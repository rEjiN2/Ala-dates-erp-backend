import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  COMPANY_SETTINGS_DEFAULTS,
  COMPANY_SETTINGS_ENTITY_TYPE,
  COMPANY_SETTINGS_KEY,
  CompanySettings,
  CompanySettingsDocument,
} from './schemas/company-settings.schema.js';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto.js';
import { FilesService } from '../files/files.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/schemas/audit-log.schema.js';
import { diffFields, type DiffField } from '../audit/field-diff.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../accounting/ledger-accounts/ledger-account-usage.registry.js';
import { LedgerAccountType } from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { type Actor, toUserSnapshot, userRefOf } from '../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';

/** Image types pdfmake can embed. */
const LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

const EDITABLE_FIELDS = [
  'legalName',
  'tradeName',
  'addressLine1',
  'addressLine2',
  'city',
  'country',
  'phone',
  'email',
  'website',
  'trn',
  'currencyCode',
  'receiptFooterText',
  'referenceReceiptHeaderText',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface CompanySettingsView extends Record<EditableField, string | null> {
  id: string;
  legalName: string;
  currencyCode: string;
  /** Our own file reference; fetch the image through GET /files/:id. */
  logo: { id: string; url: string } | null;
  allowSelfApproval: boolean;
  allowNegativeStock: boolean;
  defaultCashInHandAccountId: string | null;
  defaultChequesInHandAccountId: string | null;
  defaultPettyCashAccountId: string | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: Date | null;
}

type DisplayRecord = Record<
  EditableField | 'logo' | 'allowSelfApproval' | 'allowNegativeStock' |'defaultCashInHandAccount' | 'defaultChequesInHandAccount' | 'defaultPettyCashAccount',
  string | null
>;

/** Default handover accounts and the types each may be. */
const DEFAULT_ACCOUNT_FIELDS = [
  {
    field: 'defaultCashInHandAccountId',
    types: [LedgerAccountType.CASH, LedgerAccountType.WALLET],
  },
  { field: 'defaultChequesInHandAccountId', types: [LedgerAccountType.CHEQUE] },
  { field: 'defaultPettyCashAccountId', types: [LedgerAccountType.CASH, LedgerAccountType.WALLET] },
] as const;

const AUDITED_FIELDS: readonly DiffField<DisplayRecord>[] = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'tradeName', label: 'Trade name' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'trn', label: 'TRN' },
  { key: 'logo', label: 'Logo' },
  { key: 'currencyCode', label: 'Currency' },
  { key: 'receiptFooterText', label: 'Receipt footer text' },
  { key: 'referenceReceiptHeaderText', label: 'Reference receipt header text' },
  { key: 'allowSelfApproval', label: 'Allow self-approval of handovers' },
  { key: 'allowNegativeStock', label: 'Allow negative stock' },
  { key: 'defaultCashInHandAccount', label: 'Default cash in hand account' },
  { key: 'defaultChequesInHandAccount', label: 'Default cheques in hand account' },
  { key: 'defaultPettyCashAccount', label: 'Default petty cash account' },
];

@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    @InjectModel(CompanySettings.name) private readonly settingsModel: Model<CompanySettingsDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly filesService: FilesService,
    private readonly auditService: AuditService,
    private readonly ledgerAccountService: LedgerAccountService,
    entityAccess: EntityAccessRegistry,
    ledgerUsage: LedgerAccountUsageRegistry,
  ) {
    ledgerUsage.register('company settings (default handover account)', async (accountId, session) =>
      Boolean(
        await this.settingsModel
          .exists({
            $or: [
              { defaultCashInHandAccountId: accountId },
              { defaultChequesInHandAccountId: accountId },
              { defaultPettyCashAccountId: accountId },
            ],
          })
          .session(session ?? null)
          .exec(),
      ),
    );
    // Change history via GET /activity: readable by anyone logged in, like GET /company.
    entityAccess.register(COMPANY_SETTINGS_ENTITY_TYPE, {
      exists: async (id) => Boolean(await this.settingsModel.exists({ _id: id }).exec()),
      canRead: () => true,
    });
  }

  async get(): Promise<CompanySettingsView> {
    return this.toView(await this.ensure());
  }

  /**
   * The settings document, created with the defaults on first use. Upsert on
   * the unique `singleton` key, so concurrent first calls still end up with one.
   */
  async ensure(session?: ClientSession): Promise<CompanySettingsDocument> {
    const settings = await this.settingsModel
      .findOneAndUpdate(
        { singleton: COMPANY_SETTINGS_KEY },
        { $setOnInsert: { singleton: COMPANY_SETTINGS_KEY, ...COMPANY_SETTINGS_DEFAULTS } },
        { upsert: true, returnDocument: 'after', session },
      )
      .exec();
    return settings!;
  }

  /** Replaces the whole profile. Returns it unchanged, with no audit entry, when nothing differs. */
  async update(dto: UpdateCompanySettingsDto, actor: Actor): Promise<CompanySettingsView> {
    if (dto.logoFileRef) {
      const file = await this.filesService.describe(dto.logoFileRef);
      if (!LOGO_MIME_TYPES.has(file.mimeType)) {
        throw new BadRequestException(`The logo must be a PNG or JPEG image, not ${file.mimeType}`);
      }
    }
    for (const { field, types } of DEFAULT_ACCOUNT_FIELDS) {
      const id = dto[field];
      if (id) await this.ledgerAccountService.findActiveReceiptAccount(id, types);
    }
    // Outside the transaction: no ledger, so ensure() creating the document
    // separately is harmless, and it keeps the upsert out of a retried callback.
    await this.ensure();

    const saved = await runInTransaction(this.connection, async (session) => {
      const settings = (await this.settingsModel.findOne({ singleton: COMPANY_SETTINGS_KEY }).session(session).exec())!;
      const before = await this.display(settings);

      for (const field of EDITABLE_FIELDS) {
        if (field === 'legalName') continue;
        settings.set(field, field === 'currencyCode' ? (dto.currencyCode ?? 'AED') : (dto[field] ?? null));
      }
      settings.legalName = dto.legalName;
      settings.logoFileRef = dto.logoFileRef ? new Types.ObjectId(dto.logoFileRef) : null;
      settings.allowSelfApproval = dto.allowSelfApproval ?? false;
      settings.allowNegativeStock = dto.allowNegativeStock ?? false;
      for (const { field } of DEFAULT_ACCOUNT_FIELDS) {
        settings.set(field, dto[field] ? new Types.ObjectId(dto[field]) : null);
      }

      const changes = diffFields(before, await this.display(settings), AUDITED_FIELDS);
      if (changes.length === 0) {
        return settings;
      }

      const now = new Date();
      settings.updatedBy = toUserSnapshot(actor);
      settings.updatedAt = now;
      await settings.save({ session });
      await this.auditService.record(
        {
          entityType: COMPANY_SETTINGS_ENTITY_TYPE,
          entityId: settings._id,
          entityRef: 'Company profile',
          action: AuditAction.UPDATED,
          actor,
          changes,
          at: now,
        },
        session,
      );
      return settings;
    });

    return this.toView(saved);
  }

  /**
   * The profile plus its logo as a data URL, ready to embed in a PDF. A logo
   * that can't be fetched (storage down, quota) is left out rather than
   * failing the document.
   */
  async getForPrinting(): Promise<{ settings: CompanySettingsDocument; logoDataUrl: string | null }> {
    const settings = await this.ensure();
    if (!settings.logoFileRef) {
      return { settings, logoDataUrl: null };
    }
    try {
      const { buffer, mimeType } = await this.filesService.readBuffer(settings.logoFileRef.toString());
      if (!LOGO_MIME_TYPES.has(mimeType)) {
        return { settings, logoDataUrl: null };
      }
      return { settings, logoDataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
    } catch (error) {
      this.logger.warn(`Company logo could not be loaded; printing without it: ${(error as Error).message}`);
      return { settings, logoDataUrl: null };
    }
  }

  /** Audit values: the logo by file name rather than id. */
  private async display(settings: CompanySettingsDocument): Promise<DisplayRecord> {
    const record = Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, settings.get(field) ?? null])) as Record<
      EditableField,
      string | null
    >;
    const logoId = settings.logoFileRef?.toString() ?? null;
    let logo: string | null = null;
    if (logoId) {
      logo = await this.filesService
        .describe(logoId)
        .then((file) => file.originalName)
        .catch(() => logoId);
    }
    const accountIds = DEFAULT_ACCOUNT_FIELDS.flatMap(({ field }) => settings.get(field)?.toString() ?? []);
    const accounts = await this.ledgerAccountService.getSummaries(accountIds);
    const accountLabel = (field: (typeof DEFAULT_ACCOUNT_FIELDS)[number]['field']) => {
      const id = settings.get(field)?.toString() as string | undefined;
      const account = id ? accounts.get(id) : undefined;
      return id ? (account ? `${account.code} (${account.name})` : id) : null;
    };
    return {
      ...record,
      logo,
      allowSelfApproval: settings.allowSelfApproval ? 'Yes' : 'No',
      allowNegativeStock: settings.allowNegativeStock ? 'Yes' : 'No',
      defaultCashInHandAccount: accountLabel('defaultCashInHandAccountId'),
      defaultChequesInHandAccount: accountLabel('defaultChequesInHandAccountId'),
      defaultPettyCashAccount: accountLabel('defaultPettyCashAccountId'),
    };
  }

  private toView(settings: CompanySettingsDocument): CompanySettingsView {
    const fields = Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, settings.get(field) ?? null])) as Record<
      EditableField,
      string | null
    >;
    const logoId = settings.logoFileRef?.toString() ?? null;
    return {
      id: settings._id.toString(),
      ...fields,
      legalName: settings.legalName,
      currencyCode: settings.currencyCode,
      logo: logoId ? { id: logoId, url: `/files/${logoId}` } : null,
      allowSelfApproval: settings.allowSelfApproval ?? false,
      allowNegativeStock: settings.allowNegativeStock ?? false,
      defaultCashInHandAccountId: settings.defaultCashInHandAccountId?.toString() ?? null,
      defaultChequesInHandAccountId: settings.defaultChequesInHandAccountId?.toString() ?? null,
      defaultPettyCashAccountId: settings.defaultPettyCashAccountId?.toString() ?? null,
      updatedBy: userRefOf(settings.updatedBy),
      updatedAt: settings.updatedAt ?? null,
    };
  }
}
