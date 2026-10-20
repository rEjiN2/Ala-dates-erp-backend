import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import {
  CASHIER_ENTITY_TYPE,
  CASHIER_NAME_COLLATION,
  Cashier,
  CashierDocument,
  CashierStatus,
  STAFF_TYPE_LABELS,
  StaffType,
  defaultSettlesWithOffice,
} from './schemas/cashier.schema.js';
import { CashierLookupQueryDto, CashierQueryDto, CreateCashierDto, UpdateCashierDto } from './dto/cashier.dto.js';
import { CashierUsageRegistry } from './cashier-usage.registry.js';
import { CASHIER_CODE_SEQUENCE } from './cashier-code.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { escapeRegExp } from '../sequence/code-sequence.js';
import { LocationService } from '../location/location.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../audit/field-diff.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import type { Actor } from '../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';

export interface CashierPage {
  items: CashierDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface CashierLookupItem {
  id: string;
  code: string;
  name: string;
  staffType: StaffType;
  settlesWithOffice: boolean;
}

/** A cashier's audited fields in display form: references shown by name. */
interface CashierDisplay extends Record<string, unknown> {
  name: string;
  mobile: string | null;
  email: string | null;
  status: string;
  staffType: string;
  settlesWithOffice: string;
  linkedUser: string | null;
  location: string | null;
  notes: string | null;
}

const AUDITED_FIELDS: readonly DiffField<CashierDisplay>[] = [
  { key: 'name', label: 'Name' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'email', label: 'Email' },
  { key: 'status', label: 'Status' },
  { key: 'staffType', label: 'Staff type' },
  { key: 'settlesWithOffice', label: 'Settles with office' },
  { key: 'linkedUser', label: 'Linked user' },
  { key: 'location', label: 'Location' },
  { key: 'notes', label: 'Notes' },
];

@Injectable()
export class CashierService {
  constructor(
    @InjectModel(Cashier.name) private readonly cashierModel: Model<CashierDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly sequenceService: SequenceService,
    private readonly locationService: LocationService,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
    private readonly usageRegistry: CashierUsageRegistry,
    entityAccess: EntityAccessRegistry,
  ) {
    // Activity timeline: readable by anyone logged in, like GET /cashiers/:id.
    entityAccess.register(CASHIER_ENTITY_TYPE, {
      exists: async (id) => Boolean(await this.cashierModel.exists({ _id: id }).exec()),
      canRead: () => true,
    });
  }

  async list(query: CashierQueryDto): Promise<CashierPage> {
    const filter: QueryFilter<CashierDocument> = { ...this.searchFilter(query.q, ['code', 'name', 'mobile', 'email']) };
    if (query.status) filter.status = query.status;
    if (query.staffType) filter.staffType = query.staffType;
    if (query.settlesWithOffice !== undefined) filter.settlesWithOffice = query.settlesWithOffice;

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [items, total] = await Promise.all([
      this.cashierModel
        .find(filter)
        .sort({ code: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.cashierModel.countDocuments(filter).exec(),
    ]);
    return { items, total, page, limit };
  }

  /** For dropdowns. Active cashiers only unless activeOnly is false. */
  async lookup(query: CashierLookupQueryDto): Promise<CashierLookupItem[]> {
    const filter: QueryFilter<CashierDocument> = { ...this.searchFilter(query.q, ['code', 'name']) };
    if (query.activeOnly !== false) filter.status = CashierStatus.ACTIVE;
    if (query.staffType) filter.staffType = query.staffType;
    if (query.settlesWithOffice !== undefined) filter.settlesWithOffice = query.settlesWithOffice;

    const cashiers = await this.cashierModel
      .find(filter)
      .select('code name staffType settlesWithOffice')
      .sort({ name: 1 })
      .limit(query.limit ?? 50)
      .lean()
      .exec();
    return cashiers.map((cashier) => ({
      id: cashier._id.toString(),
      code: cashier.code,
      name: cashier.name,
      staffType: cashier.staffType ?? StaffType.CASHIER,
      settlesWithOffice: cashier.settlesWithOffice ?? false,
    }));
  }

  async findById(id: string, session?: ClientSession): Promise<CashierDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Cashier id "${id}" is not a valid id`);
    }
    const cashier = await this.cashierModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!cashier) {
      throw new NotFoundException(`Cashier ${id} not found`);
    }
    return cashier;
  }

  /** The cashier linked to this user, or null. */
  async findByLinkedUser(userId: string): Promise<CashierDocument | null> {
    if (!Types.ObjectId.isValid(userId)) {
      return null;
    }
    return this.cashierModel.findOne({ linkedUserId: new Types.ObjectId(userId) }).exec();
  }

  /** A cashier a voucher may be posted against now: must exist and be active. */
  async findActiveForPosting(id: string, session?: ClientSession): Promise<CashierDocument> {
    const cashier = await this.findById(id, session);
    if (cashier.status !== CashierStatus.ACTIVE) {
      throw new BadRequestException(`Cashier ${cashier.code} (${cashier.name}) is inactive`);
    }
    return cashier;
  }

  async create(dto: CreateCashierDto, actor: Actor): Promise<CashierDocument> {
    const status = dto.status ?? CashierStatus.ACTIVE;
    const staffType = dto.staffType ?? StaffType.CASHIER;
    await this.assertReferences(dto.linkedUserId ?? null, dto.locationId ?? null);

    return this.inTransaction(async (session) => {
      if (status === CashierStatus.ACTIVE) {
        await this.assertNameFree(dto.name, null, session);
      }
      await this.assertUserNotLinked(dto.linkedUserId ?? null, null, session);

      // Issued on the session: a rejected create rolls the counter back too.
      const code = await this.sequenceService.nextCode(CASHIER_CODE_SEQUENCE, session);
      const [created] = await this.cashierModel.create(
        [
          {
            code,
            name: dto.name,
            mobile: dto.mobile ?? null,
            email: dto.email ?? null,
            status,
            staffType,
            settlesWithOffice: dto.settlesWithOffice ?? defaultSettlesWithOffice(staffType),
            linkedUserId: dto.linkedUserId ? new Types.ObjectId(dto.linkedUserId) : null,
            locationId: dto.locationId ? new Types.ObjectId(dto.locationId) : null,
            notes: dto.notes ?? null,
          },
        ],
        { session },
      );

      await this.auditService.record(
        {
          entityType: CASHIER_ENTITY_TYPE,
          entityId: created._id,
          entityRef: code,
          action: AuditAction.CREATED,
          actor,
        },
        session,
      );
      return created;
    });
  }

  /**
   * Also how a cashier is deactivated (status "inactive") or reactivated.
   * Rejects with "No changes to save" when nothing would change.
   */
  async update(id: string, dto: UpdateCashierDto, actor: Actor): Promise<CashierDocument> {
    const provided = (key: keyof UpdateCashierDto) => Object.prototype.hasOwnProperty.call(dto, key);
    if (provided('name') && !dto.name) {
      throw new BadRequestException('name cannot be empty');
    }

    const current = await this.findById(id);
    const nextLinkedUserId = provided('linkedUserId') ? (dto.linkedUserId ?? null) : this.idOf(current.linkedUserId);
    const nextLocationId = provided('locationId') ? (dto.locationId ?? null) : this.idOf(current.locationId);
    await this.assertReferences(
      nextLinkedUserId !== this.idOf(current.linkedUserId) ? nextLinkedUserId : null,
      nextLocationId !== this.idOf(current.locationId) ? nextLocationId : null,
    );

    return this.inTransaction(async (session) => {
      const existing = await this.findById(id, session);
      const before = await this.display(existing);

      if (provided('name')) existing.name = dto.name!;
      if (provided('mobile')) existing.mobile = dto.mobile ?? null;
      if (provided('email')) existing.email = dto.email ?? null;
      if (provided('status')) existing.status = dto.status!;
      // A type change does not flip settlesWithOffice: the admin sets it explicitly.
      if (provided('staffType')) existing.staffType = dto.staffType!;
      if (provided('settlesWithOffice')) existing.settlesWithOffice = dto.settlesWithOffice!;
      if (provided('notes')) existing.notes = dto.notes ?? null;
      existing.linkedUserId = nextLinkedUserId ? new Types.ObjectId(nextLinkedUserId) : null;
      existing.locationId = nextLocationId ? new Types.ObjectId(nextLocationId) : null;

      const changes = diffFields(before, await this.display(existing), AUDITED_FIELDS);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      const nameMatters = changes.some((change) => change.field === 'name' || change.field === 'status');
      if (nameMatters && existing.status === CashierStatus.ACTIVE) {
        await this.assertNameFree(existing.name, existing._id, session);
      }
      if (changes.some((change) => change.field === 'linkedUser')) {
        await this.assertUserNotLinked(nextLinkedUserId, existing._id, session);
      }

      await existing.save({ session });
      await this.auditService.record(
        {
          entityType: CASHIER_ENTITY_TYPE,
          entityId: existing._id,
          entityRef: existing.code,
          action: changes.some((change) => change.field === 'status' && change.to === CashierStatus.INACTIVE)
            ? AuditAction.DEACTIVATED
            : AuditAction.UPDATED,
          actor,
          changes,
        },
        session,
      );
      return existing;
    });
  }

  /** Only a cashier no voucher refers to can be deleted; otherwise deactivate it. */
  async remove(id: string): Promise<{ success: true }> {
    return this.inTransaction(async (session) => {
      const cashier = await this.findById(id, session);
      const usedBy = await this.usageRegistry.findUsage(cashier._id, session);
      if (usedBy) {
        throw new ConflictException(
          `Cannot delete cashier ${cashier.code} (${cashier.name}): it is used by ${usedBy}. Deactivate it instead.`,
        );
      }
      await this.cashierModel.deleteOne({ _id: cashier._id }, { session }).exec();
      return { success: true as const };
    });
  }

  private async display(cashier: CashierDocument): Promise<CashierDisplay> {
    const linkedUserId = this.idOf(cashier.linkedUserId);
    const locationId = this.idOf(cashier.locationId);
    const [userNames, location] = await Promise.all([
      linkedUserId ? this.usersService.findNames([linkedUserId]) : Promise.resolve(new Map<string, string>()),
      locationId ? this.locationService.findById(locationId).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      name: cashier.name,
      mobile: cashier.mobile,
      email: cashier.email,
      status: cashier.status,
      staffType: STAFF_TYPE_LABELS[cashier.staffType ?? StaffType.CASHIER],
      settlesWithOffice: cashier.settlesWithOffice ? 'Yes' : 'No',
      linkedUser: linkedUserId ? (userNames.get(linkedUserId) ?? linkedUserId) : null,
      location: locationId ? (location?.name ?? locationId) : null,
      notes: cashier.notes,
    };
  }

  /** Newly referenced user/location must exist. Pass null to skip a check. */
  private async assertReferences(linkedUserId: string | null, locationId: string | null): Promise<void> {
    if (linkedUserId && !(await this.usersService.exists(linkedUserId))) {
      throw new NotFoundException(`User ${linkedUserId} not found`);
    }
    if (locationId) {
      await this.locationService.findById(locationId);
    }
  }

  private async assertNameFree(name: string, exceptId: Types.ObjectId | null, session: ClientSession): Promise<void> {
    const clash = await this.cashierModel
      .findOne({
        name: name.trim(),
        status: CashierStatus.ACTIVE,
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      })
      .collation(CASHIER_NAME_COLLATION)
      .session(session)
      .exec();
    if (clash) {
      throw new ConflictException(`An active cashier named "${clash.name}" already exists (${clash.code})`);
    }
  }

  private async assertUserNotLinked(
    userId: string | null,
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<void> {
    if (!userId) return;
    const clash = await this.cashierModel
      .findOne({ linkedUserId: new Types.ObjectId(userId), ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .session(session)
      .exec();
    if (clash) {
      throw new ConflictException(`That user is already linked to cashier ${clash.code} (${clash.name})`);
    }
  }

  private idOf(value: Types.ObjectId | null | undefined): string | null {
    return value ? value.toString() : null;
  }

  private searchFilter(q: string | undefined, fields: string[]): QueryFilter<CashierDocument> {
    const term = q?.trim();
    if (!term) {
      return {};
    }
    const pattern = new RegExp(escapeRegExp(term), 'i');
    return { $or: fields.map((field) => ({ [field]: pattern })) };
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  /** Backstop for a race the pre-checks can't see: the unique indexes reject the second writer. */
  private toFriendlyError(error: unknown): unknown {
    const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (duplicate?.code !== 11000) return error;
    if (duplicate.keyPattern?.name) return new ConflictException('An active cashier with this name already exists');
    if (duplicate.keyPattern?.linkedUserId) return new ConflictException('That user is already linked to a cashier');
    if (duplicate.keyPattern?.code) {
      return new ConflictException(
        'Generated cashier code is already in use; the code counter is behind existing data and needs re-syncing',
      );
    }
    return error;
  }
}
