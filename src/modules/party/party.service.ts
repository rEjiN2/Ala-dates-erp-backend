import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import {
  PARTY_ENTITY_TYPE,
  PARTY_NAME_COLLATION,
  Party,
  PartyDocument,
  PartyKind,
  PartyStatus,
  ShippingAddress,
} from './schemas/party.schema.js';
import {
  CreatePartyDto,
  PartyLookupQueryDto,
  PartyQueryDto,
  ShippingAddressDto,
  UpdatePartyDto,
  UploadPartyDocumentDto,
} from './dto/party.dto.js';
import { PARTY_CODE_SEQUENCES, PARTY_LEDGER_TYPES } from './party-code.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountStatus } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { escapeRegExp } from '../sequence/code-sequence.js';
import { FilesService } from '../files/files.service.js';
import { FileOwnerType } from '../files/schemas/file-attachment.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../audit/field-diff.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import type { Actor } from '../../common/schemas/user-snapshot.schema.js';
import { round2 } from '../../common/utils/money.util.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';

/** Plain fields copied 1:1 from the DTO; null clears them. */
const SIMPLE_FIELDS = [
  'contactPerson',
  'telephone',
  'mobile',
  'email',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'country',
  'postalCode',
  'vatNumber',
  'creditLimit',
  'creditDays',
  'salesman',
] as const;

type DisplayRecord = Record<string, string | number | null>;

const AUDITED_FIELDS: readonly DiffField<DisplayRecord>[] = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'contactPerson', label: 'Contact person' },
  { key: 'telephone', label: 'Telephone' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'email', label: 'Email' },
  { key: 'address1', label: 'Address 1' },
  { key: 'address2', label: 'Address 2' },
  { key: 'address3', label: 'Address 3' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'vatNumber', label: 'TRN' },
  { key: 'creditLimit', label: 'Credit limit' },
  { key: 'creditDays', label: 'Credit days' },
  { key: 'salesman', label: 'Salesman' },
  { key: 'shippingAddresses', label: 'Shipping addresses' },
];

export interface PartyDocumentView {
  id: string;
  /** Our FileAttachment id; download through `url`. */
  fileId: string;
  url: string;
  title: string;
  uploadedAt: Date;
}

export type PartyView = Omit<Party, 'documents' | 'ledgerAccountId' | 'shippingAddresses'> & {
  id: string;
  ledgerAccountId: string;
  shippingAddresses: (ShippingAddress & { id: string })[];
  documents: PartyDocumentView[];
  createdAt?: Date;
  updatedAt?: Date;
};

export interface PartyPage {
  items: PartyView[];
  total: number;
  page: number;
  limit: number;
}

export interface PartyLookupItem {
  id: string;
  code: string;
  name: string;
  kind: PartyKind;
  ledgerAccountId: string;
  balance: number;
}

@Injectable()
export class PartyService {
  private readonly logger = new Logger(PartyService.name);

  constructor(
    @InjectModel(Party.name) private readonly partyModel: Model<PartyDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    private readonly filesService: FilesService,
    private readonly auditService: AuditService,
    entityAccess: EntityAccessRegistry,
  ) {
    // Comments and the activity timeline: readable by anyone logged in, like GET /parties/:id.
    entityAccess.register(PARTY_ENTITY_TYPE, {
      exists: async (id) => Boolean(await this.partyModel.exists({ _id: id }).exec()),
      canRead: () => true,
    });
  }

  async list(query: PartyQueryDto): Promise<PartyPage> {
    const filter: QueryFilter<PartyDocument> = { ...this.searchFilter(query.q, ['name', 'code', 'telephone']) };
    if (query.kind) filter.kind = query.kind;
    if (query.status) filter.status = query.status;

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [items, total] = await Promise.all([
      this.partyModel
        .find(filter)
        .sort({ code: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.partyModel.countDocuments(filter).exec(),
    ]);
    return { items: items.map((party) => this.toView(party)), total, page, limit };
  }

  /** Active parties for voucher dropdowns, with their ledger account and its current balance. */
  async lookup(query: PartyLookupQueryDto): Promise<PartyLookupItem[]> {
    const filter: QueryFilter<PartyDocument> = {
      ...this.searchFilter(query.q, ['name', 'code']),
      status: PartyStatus.ACTIVE,
    };
    if (query.kind) filter.kind = query.kind;

    const parties = await this.partyModel
      .find(filter)
      .select('code name kind ledgerAccountId')
      .sort({ name: 1 })
      .limit(query.limit ?? 50)
      .lean()
      .exec();
    const balances = await this.ledgerAccountService.getBalances(
      parties.map((party) => party.ledgerAccountId.toString()),
    );

    return parties.map((party) => ({
      id: party._id.toString(),
      code: party.code,
      name: party.name,
      kind: party.kind,
      ledgerAccountId: party.ledgerAccountId.toString(),
      balance: balances.get(party.ledgerAccountId.toString()) ?? 0,
    }));
  }

  async findById(id: string): Promise<PartyView> {
    return this.toView(await this.getByIdOrThrow(id));
  }

  /**
   * Creates the party and its ledger account in one transaction: if either
   * insert (or the audit entry) fails, neither exists and no code is used up.
   */
  async create(dto: CreatePartyDto, actor: Actor): Promise<PartyView> {
    this.assertShippingAllowed(dto.kind, dto.shippingAddresses);
    const status = dto.status ?? PartyStatus.ACTIVE;
    const ledgerType = PARTY_LEDGER_TYPES[dto.kind];

    const created = await this.inTransaction(dto.kind, async (session) => {
      if (status === PartyStatus.ACTIVE) {
        await this.assertNoDuplicates(dto.kind, dto.name, dto.vatNumber ?? null, null, session);
      }
      await this.assertLedgerNameFree(dto.kind, dto.name, null, session);

      const code = await this.sequenceService.nextCode(PARTY_CODE_SEQUENCES[dto.kind], session);
      const ledgerAccount = await this.ledgerAccountService.createSystemAccount(
        { code, name: dto.name, type: ledgerType, status: this.ledgerStatusOf(status) },
        session,
      );

      const [party] = await this.partyModel.create(
        [
          {
            code,
            kind: dto.kind,
            name: dto.name,
            status,
            ...Object.fromEntries(SIMPLE_FIELDS.map((field) => [field, dto[field] ?? null])),
            shippingAddresses: (dto.shippingAddresses ?? []).map((address) => this.toShippingAddress(address)),
            documents: [],
            ledgerAccountId: ledgerAccount._id,
          },
        ],
        { session },
      );

      await this.auditService.record(
        { entityType: PARTY_ENTITY_TYPE, entityId: party._id, entityRef: code, action: AuditAction.CREATED, actor },
        session,
      );
      return party;
    });

    return this.toView(created);
  }

  /**
   * Also how a party is deactivated or reactivated (status). A rename or a
   * status change is applied to the ledger account in the same transaction.
   * Rejects with "No changes to save" when nothing would change.
   */
  async update(id: string, dto: UpdatePartyDto, actor: Actor): Promise<PartyView> {
    const provided = (key: keyof UpdatePartyDto) => Object.prototype.hasOwnProperty.call(dto, key);
    if (provided('name') && !dto.name) {
      throw new BadRequestException('name cannot be empty');
    }
    const current = await this.getByIdOrThrow(id);
    if (provided('shippingAddresses')) {
      this.assertShippingAllowed(current.kind, dto.shippingAddresses);
    }

    const saved = await this.inTransaction(current.kind, async (session) => {
      const party = await this.getByIdOrThrow(id, session);
      const before = this.display(party);

      if (provided('name')) party.name = dto.name!;
      if (provided('status')) party.status = dto.status!;
      for (const field of SIMPLE_FIELDS) {
        if (provided(field)) party.set(field, dto[field] ?? null);
      }
      if (provided('shippingAddresses')) {
        party.set(
          'shippingAddresses',
          (dto.shippingAddresses ?? []).map((address) => this.toShippingAddress(address)),
        );
      }

      const changes = diffFields(before, this.display(party), AUDITED_FIELDS);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }
      const changed = (field: string) => changes.some((change) => change.field === field);

      if (party.status === PartyStatus.ACTIVE && (changed('name') || changed('status') || changed('vatNumber'))) {
        await this.assertNoDuplicates(party.kind, party.name, party.vatNumber, party._id, session);
      }
      if (changed('name')) {
        await this.assertLedgerNameFree(party.kind, party.name, party.ledgerAccountId, session);
      }

      await party.save({ session });
      if (changed('name') || changed('status')) {
        await this.ledgerAccountService.syncSystemAccount(
          party.ledgerAccountId,
          { name: party.name, status: this.ledgerStatusOf(party.status) },
          session,
        );
      }

      await this.auditService.record(
        {
          entityType: PARTY_ENTITY_TYPE,
          entityId: party._id,
          entityRef: party.code,
          action: changes.some((change) => change.field === 'status' && change.to === PartyStatus.INACTIVE)
            ? AuditAction.DEACTIVATED
            : AuditAction.UPDATED,
          actor,
          changes,
        },
        session,
      );
      return party;
    });

    return this.toView(saved);
  }

  /**
   * Deletes the party and its ledger account together, only when the ledger
   * balance is 0 and nothing references the account; otherwise deactivate.
   * Attached files are removed from storage afterwards.
   */
  async remove(id: string): Promise<{ success: true }> {
    const fileRefs = await this.inTransaction(null, async (session) => {
      const party = await this.getByIdOrThrow(id, session);
      const ledgerAccount = await this.ledgerAccountService.findById(party.ledgerAccountId.toString(), session);

      const balance = round2(ledgerAccount.balance);
      if (balance !== 0) {
        throw new ConflictException(
          `Cannot delete ${party.kind} ${party.code} (${party.name}): its ledger balance is ${balance}, not 0. Deactivate it instead.`,
        );
      }
      if (await this.ledgerAccountService.isLedgerAccountUsed(ledgerAccount.id, session)) {
        throw new ConflictException(
          `Cannot delete ${party.kind} ${party.code} (${party.name}): its ledger account is used by existing transactions. Deactivate it instead.`,
        );
      }

      await this.partyModel.deleteOne({ _id: party._id }, { session }).exec();
      await this.ledgerAccountService.deleteSystemAccount(ledgerAccount._id, session);
      return party.documents.map((document) => document.fileRef.toString());
    });

    for (const fileRef of fileRefs) {
      await this.removeFileQuietly(fileRef);
    }
    return { success: true };
  }

  /**
   * Stores the file through the /files module and attaches its reference.
   * If attaching fails, the stored file is removed again.
   */
  async addDocument(
    id: string,
    file: Express.Multer.File | undefined,
    dto: UploadPartyDocumentDto,
    actor: Actor,
  ): Promise<PartyView> {
    const party = await this.getByIdOrThrow(id);
    const stored = await this.filesService.upload(
      file,
      { ownerType: party.kind === PartyKind.CUSTOMER ? FileOwnerType.PARTY : FileOwnerType.SUPPLIER, ownerId: id },
      actor.id,
    );
    const title = dto.title ?? stored.originalName;

    try {
      const saved = await this.inTransaction(party.kind, async (session) => {
        const current = await this.getByIdOrThrow(id, session);
        current.documents.push({ fileRef: new Types.ObjectId(stored.id), title, uploadedAt: new Date() } as never);
        await current.save({ session });
        await this.recordDocumentChange(
          current,
          { field: 'documents', label: 'Document added', from: null, to: title },
          actor,
          session,
        );
        return current;
      });
      return this.toView(saved);
    } catch (error) {
      await this.removeFileQuietly(stored.id);
      throw error;
    }
  }

  /** Detaches the document, then deletes the stored file. */
  async removeDocument(id: string, documentId: string, actor: Actor): Promise<PartyView> {
    const party = await this.getByIdOrThrow(id);
    const { saved, fileRef } = await this.inTransaction(party.kind, async (session) => {
      const current = await this.getByIdOrThrow(id, session);
      const document = Types.ObjectId.isValid(documentId)
        ? current.documents.find((entry) => entry._id.equals(documentId))
        : undefined;
      if (!document) {
        throw new NotFoundException(`Document ${documentId} not found on ${current.code}`);
      }
      current.set(
        'documents',
        current.documents.filter((entry) => !entry._id.equals(document._id)),
      );
      await current.save({ session });
      await this.recordDocumentChange(
        current,
        { field: 'documents', label: 'Document removed', from: document.title, to: null },
        actor,
        session,
      );
      return { saved: current, fileRef: document.fileRef.toString() };
    });

    // After the commit: the party no longer points at the file, so a storage
    // failure here leaves an unreferenced file row, never a broken link.
    await this.removeFileQuietly(fileRef);
    return this.toView(saved);
  }

  private async recordDocumentChange(
    party: PartyDocument,
    change: AuditChange,
    actor: Actor,
    session: ClientSession,
  ): Promise<void> {
    await this.auditService.record(
      {
        entityType: PARTY_ENTITY_TYPE,
        entityId: party._id,
        entityRef: party.code,
        action: AuditAction.UPDATED,
        actor,
        changes: [change],
      },
      session,
    );
  }

  private async removeFileQuietly(fileId: string): Promise<void> {
    await this.filesService.remove(fileId).catch((error: unknown) => {
      this.logger.warn(`Could not remove file ${fileId}: ${(error as Error).message}`);
    });
  }

  private async getByIdOrThrow(id: string, session?: ClientSession): Promise<PartyDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Party id "${id}" is not a valid id`);
    }
    const party = await this.partyModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!party) {
      throw new NotFoundException(`Party ${id} not found`);
    }
    return party;
  }

  /** Among active parties of the same kind: same name (ignoring case) or same TRN. */
  private async assertNoDuplicates(
    kind: PartyKind,
    name: string,
    vatNumber: string | null,
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<void> {
    const others = { kind, status: PartyStatus.ACTIVE, ...(exceptId ? { _id: { $ne: exceptId } } : {}) };

    const sameName = await this.partyModel
      .findOne({ ...others, name: name.trim() })
      .collation(PARTY_NAME_COLLATION)
      .session(session)
      .exec();
    if (sameName) {
      throw new ConflictException(`An active ${kind} named "${sameName.name}" already exists (${sameName.code})`);
    }

    if (vatNumber) {
      const sameVat = await this.partyModel
        .findOne({ ...others, vatNumber })
        .session(session)
        .exec();
      if (sameVat) {
        throw new ConflictException(
          `TRN ${vatNumber} is already used by active ${kind} ${sameVat.code} (${sameVat.name})`,
        );
      }
    }
  }

  /**
   * Ledger account names are unique per type across all statuses, so a name
   * held by an inactive party (or an older ledger account) blocks this one
   * even though active parties alone would allow it.
   */
  private async assertLedgerNameFree(
    kind: PartyKind,
    name: string,
    ownLedgerAccountId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<void> {
    const account = await this.ledgerAccountService.findByTypeAndName(PARTY_LEDGER_TYPES[kind], name, session);
    if (account && !(ownLedgerAccountId && account._id.equals(ownLedgerAccountId))) {
      throw new ConflictException(
        `The name "${name}" is already used by ${account.status} ${PARTY_LEDGER_TYPES[kind]} ledger account ${account.code} ("${account.name}"); ledger account names must be unique per type, so choose another name or rename that one first`,
      );
    }
  }

  private assertShippingAllowed(kind: PartyKind, addresses: ShippingAddressDto[] | undefined): void {
    if (kind !== PartyKind.CUSTOMER && addresses && addresses.length > 0) {
      throw new BadRequestException('Shipping addresses are only allowed on customers');
    }
  }

  private toShippingAddress(dto: ShippingAddressDto): ShippingAddress {
    return {
      label: dto.label,
      address1: dto.address1 ?? null,
      address2: dto.address2 ?? null,
      address3: dto.address3 ?? null,
      city: dto.city ?? null,
      state: dto.state ?? null,
      country: dto.country ?? null,
      postalCode: dto.postalCode ?? null,
      telephone: dto.telephone ?? null,
    };
  }

  private ledgerStatusOf(status: PartyStatus): LedgerAccountStatus {
    return status === PartyStatus.ACTIVE ? LedgerAccountStatus.ACTIVE : LedgerAccountStatus.INACTIVE;
  }

  /** Audited fields as plain values; shipping addresses as one readable line each. */
  private display(party: PartyDocument): DisplayRecord {
    const record: DisplayRecord = { name: party.name, status: party.status };
    for (const field of SIMPLE_FIELDS) {
      record[field] = (party.get(field) as string | number | null) ?? null;
    }
    record.shippingAddresses =
      party.shippingAddresses
        .map((address) =>
          [
            address.label,
            address.address1,
            address.address2,
            address.address3,
            address.city,
            address.state,
            address.country,
            address.postalCode,
            address.telephone,
          ]
            .filter(Boolean)
            .join(', '),
        )
        .join(' | ') || null;
    return record;
  }

  private toView(party: PartyDocument): PartyView {
    const json = party.toObject({ versionKey: false });
    return {
      ...json,
      id: party._id.toString(),
      ledgerAccountId: party.ledgerAccountId.toString(),
      shippingAddresses: party.shippingAddresses.map((address) => {
        const { _id, ...rest } = (
          address as unknown as { toObject(): ShippingAddress & { _id: Types.ObjectId } }
        ).toObject();
        return { id: _id.toString(), ...rest };
      }),
      documents: party.documents.map((document) => ({
        id: document._id.toString(),
        fileId: document.fileRef.toString(),
        url: `/files/${document.fileRef.toString()}`,
        title: document.title,
        uploadedAt: document.uploadedAt,
      })),
    } as PartyView;
  }

  private searchFilter(q: string | undefined, fields: string[]): QueryFilter<PartyDocument> {
    const term = q?.trim();
    if (!term) {
      return {};
    }
    const pattern = new RegExp(escapeRegExp(term), 'i');
    return { $or: fields.map((field) => ({ [field]: pattern })) };
  }

  private async inTransaction<T>(kind: PartyKind | null, work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      throw this.toFriendlyError(error, kind);
    }
  }

  /** Backstop for races the pre-checks can't see: the unique indexes reject the second writer. */
  private toFriendlyError(error: unknown, kind: PartyKind | null): unknown {
    const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (duplicate?.code !== 11000) return error;
    const what = kind ?? 'party';
    if (duplicate.keyPattern?.vatNumber) return new ConflictException(`An active ${what} with this TRN already exists`);
    if (duplicate.keyPattern?.name) return new ConflictException(`An active ${what} with this name already exists`);
    if (duplicate.keyPattern?.code) {
      return new ConflictException(
        `Generated ${what} code is already in use; the code counter is behind existing data and needs re-syncing (pnpm migrate:code-sequences)`,
      );
    }
    return error;
  }
}
