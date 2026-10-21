import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import bcrypt from 'bcryptjs';
import {
  ACTIVE_USER_FILTER,
  USER_ENTITY_TYPE,
  User,
  UserDocument,
  UserStatus,
  isUserActive,
} from './schemas/user.schema.js';
import { ChangePasswordDto, CreateUserDto, ResetPasswordDto, UpdateUserDto, UserQueryDto } from './dto/user.dto.js';
import { UsersService } from './users.service.js';
import { Role, RoleDocument } from '../roles/schemas/role.schema.js';
import { ADMIN_ROLE_NAME, DataScope } from '../roles/permissions.js';
import { Location, LocationDocument } from '../location/schemas/location.schema.js';
import { UserUsageRegistry } from './user-usage.registry.js';
import {
  CASH_LIKE_ACCOUNT_TYPES,
  LedgerAccountService,
} from '../accounting/ledger-accounts/ledger-account.service.js';
import {
  LedgerAccountStatus,
  LedgerAccountType,
} from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../audit/field-diff.js';
import { escapeRegExp } from '../sequence/code-sequence.js';
import type { Actor } from '../../common/schemas/user-snapshot.schema.js';
import type { AuthProfile } from '../auth/interfaces/auth.types.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';

const BCRYPT_ROUNDS = 10;

/** Account types a user may be allowed to receive money into. */
const ALLOWED_CASH_ACCOUNT_TYPES: readonly LedgerAccountType[] = CASH_LIKE_ACCOUNT_TYPES;

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: { id: string; name: string; dataScope: DataScope } | null;
  status: UserStatus;
  mustChangePassword: boolean;
  allowedCashAccounts: { id: string; code: string; name: string; type: string }[];
  settlesWithOffice: boolean;
  location: { id: string; name: string | null } | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UserPage {
  items: UserView[];
  total: number;
  page: number;
  limit: number;
}

/** A user's audited fields in display form: references shown by name. */
interface UserDisplay extends Record<string, unknown> {
  name: string;
  email: string;
  role: string;
  status: string;
  allowedCashAccounts: string | null;
  settlesWithOffice: string;
  location: string | null;
}

const AUDITED_FIELDS: readonly DiffField<UserDisplay>[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
  { key: 'allowedCashAccounts', label: 'Allowed cash accounts' },
  { key: 'settlesWithOffice', label: 'Settles with office' },
  { key: 'location', label: 'Location' },
];

/**
 * User administration (users:manage) and the caller's own profile and
 * password. Every change is audited in its own transaction. The last active
 * admin can't be deactivated, demoted or deleted.
 */
@Injectable()
export class UserManagementService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly usersService: UsersService,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly auditService: AuditService,
    private readonly usage: UserUsageRegistry,
  ) {}

  async list(query: UserQueryDto): Promise<UserPage> {
    const filter: QueryFilter<UserDocument> = {};
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }];
    }
    if (query.status === UserStatus.ACTIVE) Object.assign(filter, ACTIVE_USER_FILTER);
    if (query.status === UserStatus.INACTIVE) filter.$nor = [ACTIVE_USER_FILTER];
    if (query.roleId) filter.role = new Types.ObjectId(query.roleId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .populate('role')
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { items: await this.toViews(users), total, page, limit };
  }

  async findOne(id: string): Promise<UserView> {
    const [view] = await this.toViews([await this.getById(id)]);
    return view;
  }

  /** GET /auth/me: the request user plus their role scope, settlement flag and allowed accounts. */
  async profile(userId: string): Promise<AuthProfile> {
    const user = await this.getById(userId);
    const [view] = await this.toViews([user]);
    return {
      ...this.usersService.toAuthenticatedUser(user),
      dataScope: view.role?.dataScope ?? DataScope.ALL,
      mustChangePassword: view.mustChangePassword,
      settlesWithOffice: view.settlesWithOffice,
      allowedCashAccounts: view.allowedCashAccounts,
    };
  }

  /** New users must change the password they were given at first login. */
  async create(dto: CreateUserDto, actor: Actor): Promise<UserView> {
    const role = await this.getRole(dto.roleId);
    const allowedCashAccountIds = dto.allowedCashAccountIds ?? [];
    await this.assertCashAccounts(allowedCashAccountIds, []);
    await this.assertLocation(dto.locationId);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const created = await this.inTransaction(async (session) => {
      await this.assertEmailFree(dto.email, null, session);
      const [user] = await this.userModel.create(
        [
          {
            name: dto.name,
            email: dto.email,
            passwordHash,
            role: role._id,
            status: dto.status ?? UserStatus.ACTIVE,
            mustChangePassword: true,
            allowedCashAccountIds: allowedCashAccountIds.map((id) => new Types.ObjectId(id)),
            settlesWithOffice: dto.settlesWithOffice ?? false,
            locationId: dto.locationId ? new Types.ObjectId(dto.locationId) : null,
          },
        ],
        { session },
      );
      await this.auditService.record(
        { entityType: USER_ENTITY_TYPE, entityId: user._id, entityRef: user.email, action: AuditAction.CREATED, actor },
        session,
      );
      return user;
    });
    return this.findOne(created.id as string);
  }

  /**
   * Also how a user is deactivated (status "inactive") or reactivated.
   * Rejects with "No changes to save" when nothing would change.
   */
  async update(id: string, dto: UpdateUserDto, actor: Actor): Promise<UserView> {
    const provided = (key: keyof UpdateUserDto) => Object.prototype.hasOwnProperty.call(dto, key);
    if (provided('name') && !dto.name) {
      throw new BadRequestException('name cannot be empty');
    }
    const current = await this.getById(id);
    if (id === actor.id && provided('status') && dto.status === UserStatus.INACTIVE) {
      throw new BadRequestException('You cannot deactivate your own user');
    }
    if (provided('roleId')) {
      await this.getRole(dto.roleId!);
    }
    if (provided('allowedCashAccountIds')) {
      await this.assertCashAccounts(
        dto.allowedCashAccountIds ?? [],
        current.allowedCashAccountIds.map((accountId) => accountId.toString()),
      );
    }
    if (provided('locationId')) {
      await this.assertLocation(dto.locationId);
    }

    await this.inTransaction(async (session) => {
      const existing = await this.getById(id, session);
      const wasAdmin = await this.isActiveAdmin(existing, session);
      const before = await this.display(existing, session);

      if (provided('name')) existing.name = dto.name!;
      if (provided('email')) existing.email = dto.email!;
      if (provided('roleId')) existing.role = new Types.ObjectId(dto.roleId);
      if (provided('status')) {
        existing.status = dto.status!;
        existing.isActive = undefined;
      }
      if (provided('allowedCashAccountIds')) {
        existing.allowedCashAccountIds = (dto.allowedCashAccountIds ?? []).map(
          (accountId) => new Types.ObjectId(accountId),
        );
      }
      if (provided('settlesWithOffice')) existing.settlesWithOffice = Boolean(dto.settlesWithOffice);
      if (provided('locationId')) existing.locationId = dto.locationId ? new Types.ObjectId(dto.locationId) : null;

      const changes = diffFields(before, await this.display(existing, session), AUDITED_FIELDS);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }
      if (changes.some((change) => change.field === 'email')) {
        await this.assertEmailFree(existing.email, existing._id, session);
      }
      if (wasAdmin && !(await this.isActiveAdmin(existing, session))) {
        await this.assertAnotherActiveAdmin(existing._id, session);
      }
      const deactivated = changes.some((change) => change.field === 'status' && change.to === UserStatus.INACTIVE);
      if (deactivated) {
        // Their refresh token stops working; the access token already does (status is checked per request).
        existing.refreshTokenHash = undefined;
      }

      await existing.save({ session });
      await this.auditService.record(
        {
          entityType: USER_ENTITY_TYPE,
          entityId: existing._id,
          entityRef: existing.email,
          action: deactivated ? AuditAction.DEACTIVATED : AuditAction.UPDATED,
          actor,
          changes,
        },
        session,
      );
    });
    return this.findOne(id);
  }

  async deactivate(id: string, actor: Actor): Promise<UserView> {
    return this.update(id, { status: UserStatus.INACTIVE }, actor);
  }

  /** Sets a new password the user must change at their next login, and ends their sessions. */
  async resetPassword(id: string, dto: ResetPasswordDto, actor: Actor): Promise<{ success: true }> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.inTransaction(async (session) => {
      const user = await this.getById(id, session);
      await this.userModel
        .updateOne(
          { _id: user._id },
          { $set: { passwordHash, mustChangePassword: true }, $unset: { refreshTokenHash: 1 } },
          { session },
        )
        .exec();
      await this.auditService.record(
        {
          entityType: USER_ENTITY_TYPE,
          entityId: user._id,
          entityRef: user.email,
          action: AuditAction.PASSWORD_RESET,
          actor,
        },
        session,
      );
    });
    return { success: true };
  }

  /** The caller's own password; clears mustChangePassword. */
  async changeOwnPassword(actor: Actor, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userModel.findById(actor.id).select('+passwordHash').exec();
    if (!user || !isUserActive(user)) {
      throw new UnauthorizedException('User no longer active');
    }
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('The new password must be different from the current one');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.inTransaction(async (session) => {
      await this.userModel
        .updateOne({ _id: user._id }, { $set: { passwordHash, mustChangePassword: false } }, { session })
        .exec();
      await this.auditService.record(
        {
          entityType: USER_ENTITY_TYPE,
          entityId: user._id,
          entityRef: user.email,
          action: AuditAction.PASSWORD_CHANGED,
          actor,
        },
        session,
      );
    });
  }

  /**
   * Only a user with no history can be deleted: never on a voucher as
   * Collected By / Paid By and never the actor of an audited change.
   * Otherwise deactivate them.
   */
  async remove(id: string, actor: Actor): Promise<{ success: true }> {
    if (id === actor.id) {
      throw new BadRequestException('You cannot delete your own user');
    }
    return this.inTransaction(async (session) => {
      const user = await this.getById(id, session);
      const usedBy = await this.usage.findUsage(user._id, session);
      if (usedBy) {
        throw new ConflictException(`Cannot delete user ${user.email}: they are on ${usedBy}. Deactivate the user instead.`);
      }
      if (await this.auditService.hasActor(user._id, session)) {
        throw new ConflictException(`Cannot delete user ${user.email}: they have recorded activity. Deactivate the user instead.`);
      }
      if (await this.isActiveAdmin(user, session)) {
        await this.assertAnotherActiveAdmin(user._id, session);
      }
      await this.userModel.deleteOne({ _id: user._id }, { session }).exec();
      await this.auditService.record(
        { entityType: USER_ENTITY_TYPE, entityId: user._id, entityRef: user.email, action: AuditAction.DELETED, actor },
        session,
      );
      return { success: true as const };
    });
  }

  private async getById(id: string, session?: ClientSession): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`User id "${id}" is not a valid id`);
    }
    const user = await this.userModel
      .findById(id)
      .populate({ path: 'role', options: { session } })
      .session(session ?? null)
      .exec();
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  private async getRole(id: string): Promise<RoleDocument> {
    const role = Types.ObjectId.isValid(id) ? await this.roleModel.findById(id).exec() : null;
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }
    return role;
  }

  private roleIdOf(user: UserDocument): string {
    const role = user.role as RoleDocument | Types.ObjectId;
    return role instanceof Types.ObjectId ? role.toString() : (role._id as Types.ObjectId).toString();
  }

  private async adminRole(session: ClientSession): Promise<RoleDocument | null> {
    return this.roleModel.findOne({ name: ADMIN_ROLE_NAME }).session(session).exec();
  }

  private async isActiveAdmin(user: UserDocument, session: ClientSession): Promise<boolean> {
    const admin = await this.adminRole(session);
    return Boolean(admin) && isUserActive(user) && this.roleIdOf(user) === admin!.id;
  }

  /**
   * Refuses to remove the last active admin. Touching the admin role makes
   * two concurrent demotions write the same document, so one of them retries
   * and then sees the other's change (no write skew).
   */
  private async assertAnotherActiveAdmin(exceptId: Types.ObjectId, session: ClientSession): Promise<void> {
    const admin = await this.adminRole(session);
    if (!admin) return;
    await this.roleModel.updateOne({ _id: admin._id }, { $currentDate: { updatedAt: true } }, { session }).exec();
    const others = await this.userModel
      .countDocuments({ ...ACTIVE_USER_FILTER, role: admin._id, _id: { $ne: exceptId } })
      .session(session)
      .exec();
    if (others === 0) {
      throw new ConflictException('Cannot deactivate, demote or delete the last active admin');
    }
  }

  private async assertEmailFree(email: string, exceptId: Types.ObjectId | null, session: ClientSession): Promise<void> {
    const clash = await this.userModel
      .exists({ email: email.toLowerCase(), ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .session(session)
      .exec();
    if (clash) {
      throw new ConflictException(`A user with email ${email} already exists`);
    }
  }

  /** Newly allowed accounts must be active cash or wallet accounts; ones already allowed are kept as they are. */
  private async assertCashAccounts(ids: readonly string[], alreadyAllowed: readonly string[]): Promise<void> {
    for (const accountId of ids.filter((candidate) => !alreadyAllowed.includes(candidate))) {
      const account = await this.ledgerAccountService.findById(accountId);
      if (!ALLOWED_CASH_ACCOUNT_TYPES.includes(account.type)) {
        throw new BadRequestException(
          `${account.code} (${account.name}) is a ${account.type} account. Only cash, wallet and cheque accounts can be allowed.`,
        );
      }
      if (account.status !== LedgerAccountStatus.ACTIVE) {
        throw new BadRequestException(`Ledger account ${account.code} is inactive`);
      }
    }
  }

  private async assertLocation(id: string | null | undefined): Promise<void> {
    if (id && !(await this.locationModel.exists({ _id: id }).exec())) {
      throw new NotFoundException(`Location ${id} not found`);
    }
  }

  private async display(user: UserDocument, session: ClientSession): Promise<UserDisplay> {
    const [role, location, accounts] = await Promise.all([
      this.roleModel.findById(this.roleIdOf(user)).session(session).exec(),
      user.locationId ? this.locationModel.findById(user.locationId).select('name').session(session).exec() : null,
      this.ledgerAccountService.getSummaries(
        user.allowedCashAccountIds.map((accountId) => accountId.toString()),
        session,
      ),
    ]);
    const accountLabels = user.allowedCashAccountIds.map((accountId) => {
      const account = accounts.get(accountId.toString());
      return account ? `${account.code} (${account.name})` : accountId.toString();
    });
    return {
      name: user.name,
      email: user.email,
      role: role?.name ?? this.roleIdOf(user),
      status: isUserActive(user) ? UserStatus.ACTIVE : UserStatus.INACTIVE,
      allowedCashAccounts: accountLabels.length > 0 ? accountLabels.join(', ') : null,
      settlesWithOffice: user.settlesWithOffice ? 'Yes' : 'No',
      location: user.locationId ? (location?.name ?? user.locationId.toString()) : null,
    };
  }

  private async toViews(users: UserDocument[]): Promise<UserView[]> {
    const accountIds = users.flatMap((user) => user.allowedCashAccountIds.map((accountId) => accountId.toString()));
    const [accounts, locations] = await Promise.all([
      this.ledgerAccountService.getSummaries(accountIds),
      this.locationModel
        .find({ _id: { $in: users.flatMap((user) => (user.locationId ? [user.locationId] : [])) } })
        .select('name')
        .lean()
        .exec(),
    ]);
    const locationName = new Map(locations.map((location) => [location._id.toString(), location.name]));

    return users.map((user) => {
      const role = user.role instanceof Types.ObjectId ? null : (user.role as RoleDocument | null);
      return {
        id: user.id as string,
        name: user.name,
        email: user.email,
        role: role ? { id: role.id as string, name: role.name, dataScope: role.dataScope ?? DataScope.ALL } : null,
        status: isUserActive(user) ? UserStatus.ACTIVE : UserStatus.INACTIVE,
        mustChangePassword: Boolean(user.mustChangePassword),
        allowedCashAccounts: user.allowedCashAccountIds.flatMap((accountId) => {
          const account = accounts.get(accountId.toString());
          return account ? [{ id: accountId.toString(), code: account.code, name: account.name, type: account.type }] : [];
        }),
        settlesWithOffice: Boolean(user.settlesWithOffice),
        location: user.locationId
          ? { id: user.locationId.toString(), name: locationName.get(user.locationId.toString()) ?? null }
          : null,
        createdAt: (user as unknown as { createdAt?: Date }).createdAt,
        updatedAt: (user as unknown as { updatedAt?: Date }).updatedAt,
      };
    });
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      // Backstop for a race the pre-check can't see: the unique email index rejects the second writer.
      if ((error as { code?: number })?.code === 11000) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }
}
