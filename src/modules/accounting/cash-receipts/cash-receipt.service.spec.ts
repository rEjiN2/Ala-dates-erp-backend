import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { Model, Types } from 'mongoose';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptController } from './cash-receipt.controller.js';
import {
  CASH_RECEIPT_ENTITY_TYPE,
  CashReceipt,
  CashReceiptDocument,
  CashReceiptSchema,
} from './schemas/cash-receipt.schema.js';
import { CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import type { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountStatus,
  LedgerAccountType,
} from '../ledger-accounts/schemas/ledger-account.schema.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { LocationService } from '../../location/location.service.js';
import { Location, LocationSchema } from '../../location/schemas/location.schema.js';
import { Counter, CounterDocument, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, AuditLog, AuditLogDocument, AuditLogSchema } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { ActivityService } from '../../comments/activity.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { ActivityController, CommentsController } from '../../comments/comments.controller.js';
import { Comment, CommentDocument, CommentSchema } from '../../comments/schemas/comment.schema.js';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { Permission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { CashReceiptPrintService } from './cash-receipt-print.service.js';
import { Cashier, CashierDocument, CashierSchema, CashierStatus } from '../../cashier/schemas/cashier.schema.js';
import { CashierService } from '../../cashier/cashier.service.js';
import { CashierUsageRegistry } from '../../cashier/cashier-usage.registry.js';
import { UsersService } from '../../users/users.service.js';
import { User, UserSchema } from '../../users/schemas/user.schema.js';
import { CompanyService } from '../../company/company.service.js';
import {
  CompanySettings,
  CompanySettingsDocument,
  CompanySettingsSchema,
} from '../../company/schemas/company-settings.schema.js';
import { FilesService } from '../../files/files.service.js';
import { backfillCashReceiptCashiers } from '../../../database/backfill-cash-receipt-cashiers.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';

function makeUser(name: string, permissions: string[] = [Permission.CASH_RECEIPTS_MANAGE]): AuthenticatedUser {
  return {
    id: new Types.ObjectId().toString(),
    email: `${name.toLowerCase()}@example.com`,
    name,
    role: { id: new Types.ObjectId().toString(), name: 'accountant' },
    permissions,
  };
}

describe('CashReceiptService (transactional)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let service: CashReceiptService;
  let auditService: AuditService;
  let commentsService: CommentsService;
  let ledgerAccountModel: Model<LedgerAccountDocument>;
  let cashReceiptModel: Model<CashReceiptDocument>;
  let counterModel: Model<CounterDocument>;
  let auditModel: Model<AuditLogDocument>;
  let commentModel: Model<CommentDocument>;
  let cashierModel: Model<CashierDocument>;
  let companyModel: Model<CompanySettingsDocument>;
  let cashierService: CashierService;
  let printService: CashReceiptPrintService;
  /** Active cashier "Sachin" used by default for every receipt; recreated per test. */
  let mainCashier: CashierDocument;
  /** Active cashier "Omar". */
  let otherCashier: CashierDocument;

  const sachin = makeUser('Sachin');
  const omar = makeUser('Omar');
  /** Who the fake JWT guard says is calling, for the HTTP tests. */
  let tokenUser: AuthenticatedUser = sachin;

  beforeAll(async () => {
    // Providers are wired directly rather than importing CashReceiptModule, so
    // the real JWT strategy stays out; the HTTP tests swap the JWT guard for
    // one that attaches `tokenUser`, as a verified token would.
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('cash_receipts'),
        MongooseModule.forFeature([
          { name: CashReceipt.name, schema: CashReceiptSchema },
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: Location.name, schema: LocationSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
          { name: Comment.name, schema: CommentSchema },
          { name: Cashier.name, schema: CashierSchema },
          { name: User.name, schema: UserSchema },
          { name: CompanySettings.name, schema: CompanySettingsSchema },
        ]),
      ],
      controllers: [CashReceiptController, CommentsController, ActivityController],
      providers: [
        CashReceiptService,
        LedgerAccountService,
        LedgerAccountUsageRegistry,
        LocationService,
        SequenceService,
        AuditService,
        CommentsService,
        ActivityService,
        EntityAccessRegistry,
        CashierService,
        CashierUsageRegistry,
        UsersService,
        CompanyService,
        CashReceiptPrintService,
        // No logo is configured in these tests, so storage is never reached.
        { provide: FilesService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = tokenUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();

    service = moduleRef.get(CashReceiptService);
    auditService = moduleRef.get(AuditService);
    commentsService = moduleRef.get(CommentsService);
    ledgerAccountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    cashReceiptModel = moduleRef.get(getModelToken(CashReceipt.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    commentModel = moduleRef.get(getModelToken(Comment.name));
    cashierModel = moduleRef.get(getModelToken(Cashier.name));
    companyModel = moduleRef.get(getModelToken(CompanySettings.name));
    cashierService = moduleRef.get(CashierService);
    printService = moduleRef.get(CashReceiptPrintService);
    await Promise.all([
      cashReceiptModel.init(),
      auditModel.init(),
      commentModel.init(),
      cashierModel.init(),
      companyModel.init(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    tokenUser = sachin;
    await cashReceiptModel.deleteMany({}).exec();
    await ledgerAccountModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
    // Audit logs and comments refuse deletes through Mongoose; use the driver.
    await auditModel.collection.deleteMany({});
    await commentModel.collection.deleteMany({});
    await cashierModel.deleteMany({}).exec();
    await companyModel.deleteMany({}).exec();
  });

  beforeEach(async () => {
    mainCashier = await cashierService.create({ name: 'Sachin' }, sachin);
    otherCashier = await cashierService.create({ name: 'Omar' }, sachin);
    // Cashier creation is audited; start each test with an empty log.
    await auditModel.collection.deleteMany({});
  });

  /** service.create with the default cashier filled in. */
  function createReceipt(dto: Omit<CreateCashReceiptDto, 'cashierId'> & { cashierId?: string }, actor: Actor) {
    return service.create({ cashierId: mainCashier.id, ...dto }, actor);
  }

  async function makeAccount(
    code: string,
    type: LedgerAccountType,
    balance = 0,
    name = `${code} account`,
  ): Promise<LedgerAccountDocument> {
    return ledgerAccountModel.create({
      code,
      name,
      type,
      balance,
      status: LedgerAccountStatus.ACTIVE,
    });
  }

  async function balanceOf(account: LedgerAccountDocument): Promise<number> {
    const fresh = await ledgerAccountModel.findById(account._id).exec();
    return fresh!.balance;
  }

  async function auditFor(receiptId: Types.ObjectId | string) {
    return auditService.findForEntity(CASH_RECEIPT_ENTITY_TYPE, new Types.ObjectId(receiptId));
  }

  /** A posted receipt with a cash account, a party and one 100 + 5 VAT line. */
  async function postedReceipt(overrides: Partial<CreateCashReceiptDto> = {}, actor = sachin) {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000, 'Main Cash');
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500, 'Ali Traders');
    const receipt = await createReceipt(
      {
        voucherDate: '2026-09-21',
        cashAccountId: cash._id.toString(),
        lines: [
          {
            accountId: party._id.toString(),
            amount: 100,
            vat: 5,
            narration: 'Part payment',
          },
        ],
        ...overrides,
      },
      actor,
    );
    return { cash, party, receipt };
  }

  describe('posting', () => {
    it('posts a receipt and moves both sides of the balance', async () => {
      const { cash, party, receipt } = await postedReceipt();

      expect(receipt.voucherNo).toBe('CR000001');
      expect(receipt.grossTotal).toBe(100);
      expect(receipt.totalTax).toBe(5);
      expect(receipt.grandTotal).toBe(105);
      expect(receipt.lines[0].netAmount).toBe(105);
      expect(receipt.lines[0].oldBalance).toBe(500);

      expect(await balanceOf(cash)).toBe(1105);
      expect(await balanceOf(party)).toBe(395);
    });

    it('rolls back everything when a later line has an unknown account', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500);
      const missingAccountId = new Types.ObjectId().toString();

      await expect(
        createReceipt(
          {
            voucherDate: '2026-09-21',
            cashAccountId: cash._id.toString(),
            lines: [
              { accountId: party._id.toString(), amount: 100, vat: 0 },
              { accountId: missingAccountId, amount: 250, vat: 0 },
            ],
          },
          sachin,
        ),
      ).rejects.toThrow(/not found/i);

      // Nothing persisted: no voucher, no audit entry, and both balances untouched.
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
      expect(await auditModel.countDocuments().exec()).toBe(0);
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(party)).toBe(500);
    });

    it('does not consume a voucher number when the transaction aborts', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

      await expect(
        createReceipt(
          {
            voucherDate: '2026-09-21',
            cashAccountId: cash._id.toString(),
            lines: [{ accountId: new Types.ObjectId().toString(), amount: 10 }],
          },
          sachin,
        ),
      ).rejects.toThrow();

      const afterFailure = await createReceipt(
        {
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
          lines: [{ accountId: party._id.toString(), amount: 10 }],
        },
        sachin,
      );

      expect(afterFailure.voucherNo).toBe('CR000001');
    });

    it('gives concurrent receipts unique, gapless voucher numbers', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

      const receipts = await Promise.all(
        Array.from({ length: 10 }, () =>
          createReceipt(
            {
              voucherDate: '2026-09-21',
              cashAccountId: cash._id.toString(),
              lines: [{ accountId: party._id.toString(), amount: 1 }],
            },
            sachin,
          ),
        ),
      );

      expect(receipts.map((receipt) => receipt.voucherNo).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `CR${(i + 1).toString().padStart(6, '0')}`),
      );
      expect(await balanceOf(cash)).toBe(10);
      // Exactly one "created" entry per committed receipt, even with retried transactions.
      expect(await auditModel.countDocuments({ action: AuditAction.CREATED }).exec()).toBe(10);
    });

    it('rejects receiving into an account that is not cash, wallet or bank', async () => {
      const notCash = await makeAccount('INC-001', LedgerAccountType.INCOME, 0);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

      await expect(
        createReceipt(
          {
            voucherDate: '2026-09-21',
            cashAccountId: notCash._id.toString(),
            lines: [{ accountId: party._id.toString(), amount: 10 }],
          },
          sachin,
        ),
      ).rejects.toThrow(/must be received into a cash, wallet or bank account/);

      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
    });

    it('reverses the old posting and applies the new one on update', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

      const receipt = await createReceipt(
        {
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
          lines: [{ accountId: party._id.toString(), amount: 100 }],
        },
        sachin,
      );

      await service.update(
        receipt._id.toString(),
        { lines: [{ accountId: party._id.toString(), amount: 250 }] },
        sachin,
      );

      expect(await balanceOf(cash)).toBe(250);
      expect(await balanceOf(party)).toBe(-250);
    });

    it('reverses balances when a receipt is deleted', async () => {
      const { cash, party, receipt } = await postedReceipt();

      await service.remove(receipt._id.toString());

      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(party)).toBe(500);
    });

    it('computes totals from the lines and ignores any client-sent totals', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

      const receipt = await createReceipt(
        {
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
          // grandTotal/netAmount are not part of the DTO at all — the API surface
          // gives the client no way to send one.
          lines: [
            { accountId: party._id.toString(), amount: 33.33, vat: 1.67 },
            { accountId: party._id.toString(), amount: 10.1, vat: 0.9 },
          ],
        } as never,
        sachin,
      );

      expect(receipt.grossTotal).toBe(43.43);
      expect(receipt.totalTax).toBe(2.57);
      expect(receipt.grandTotal).toBe(46);
      expect(await balanceOf(cash)).toBe(46);
      expect(await balanceOf(party)).toBe(-46);
    });
  });

  describe('audit trail', () => {
    it('stamps the creator and writes a "created" entry', async () => {
      const { receipt } = await postedReceipt();

      expect(receipt.status).toBe('posted');
      expect(receipt.createdBy).toMatchObject({ name: 'Sachin' });
      expect(receipt.createdBy!.id.toString()).toBe(sachin.id);
      expect(receipt.createdAt).toBeInstanceOf(Date);
      expect(receipt.updatedBy).toBeNull();
      expect(receipt.updatedAt).toBeNull();

      const entries = await auditFor(receipt._id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entityType: 'cash-receipt',
        entityRef: 'CR000001',
        action: 'created',
        actorName: 'Sachin',
        changes: [],
      });
      expect(entries[0].actorId.toString()).toBe(sachin.id);
      expect(entries[0].at.getTime()).toBe(receipt.createdAt!.getTime());
    });

    it('rolls the audit entry back with the receipt when the transaction fails after recording it', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000);
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500);
      const record = auditService.record.bind(auditService);
      vi.spyOn(auditService, 'record').mockImplementation(async (entry, session) => {
        await record(entry, session);
        throw new Error('disk full');
      });

      await expect(
        createReceipt(
          {
            voucherDate: '2026-09-21',
            cashAccountId: cash._id.toString(),
            lines: [{ accountId: party._id.toString(), amount: 100 }],
          },
          sachin,
        ),
      ).rejects.toThrow('disk full');

      expect(await auditModel.countDocuments().exec()).toBe(0);
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(party)).toBe(500);
    });

    it('rolls back an update together with its audit entry', async () => {
      const { cash, party, receipt } = await postedReceipt();
      const record = auditService.record.bind(auditService);
      vi.spyOn(auditService, 'record').mockImplementation(async (entry, session) => {
        await record(entry, session);
        throw new Error('disk full');
      });

      await expect(service.update(receipt._id.toString(), { cashierId: otherCashier.id }, omar)).rejects.toThrow(
        'disk full',
      );

      const unchanged = await service.findById(receipt._id.toString());
      expect(unchanged.cashierName).toBe('Sachin');
      expect(unchanged.updatedBy).toBeNull();
      expect((await auditFor(receipt._id)).map((entry) => entry.action)).toEqual(['created']);
      expect(await balanceOf(cash)).toBe(1105);
      expect(await balanceOf(party)).toBe(395);
    });

    it('records a readable diff of an edit, with the change note as reason', async () => {
      const { cash, party, receipt } = await postedReceipt();
      const vanCash = await makeAccount('CASH-002', LedgerAccountType.CASH, 0, 'Van Cash');
      const omarDates = await makeAccount('PARTY-002', LedgerAccountType.PARTY, 0, 'Omar Dates');

      const updated = await service.update(
        receipt._id.toString(),
        {
          voucherDate: '2026-09-22',
          cashAccountId: vanCash._id.toString(),
          comments: 'Corrected',
          lines: [
            {
              accountId: party._id.toString(),
              amount: 250,
              vat: 5,
              narration: 'Part payment',
            },
            { accountId: omarDates._id.toString(), amount: 40 },
          ],
          changeNote: '  Wrong amount entered  ',
        },
        omar,
      );

      expect(updated.updatedBy).toMatchObject({ name: 'Omar' });
      expect(updated.updatedAt).toBeInstanceOf(Date);
      expect(updated.createdBy).toMatchObject({ name: 'Sachin' });

      const [latest] = await auditFor(receipt._id);
      expect(latest).toMatchObject({
        action: 'updated',
        actorName: 'Omar',
        reason: 'Wrong amount entered',
      });
      expect(latest.actorId.toString()).toBe(omar.id);
      expect(latest.changes).toEqual([
        {
          field: 'voucherDate',
          label: 'Date',
          from: '2026-09-21',
          to: '2026-09-22',
        },
        {
          field: 'cashAccount',
          label: 'Received into',
          from: 'Main Cash',
          to: 'Van Cash',
        },
        { field: 'comments', label: 'Comments', from: null, to: 'Corrected' },
        {
          field: 'lines.amount',
          label: 'Ali Traders: Amount',
          from: 100,
          to: 250,
        },
        {
          field: 'lines',
          label: 'Line added',
          from: null,
          to: 'Omar Dates: 40.00',
        },
        { field: 'grandTotal', label: 'Total', from: 105, to: 295 },
      ]);

      // Balances moved from the old posting to the new one.
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(vanCash)).toBe(295);
      expect(await balanceOf(party)).toBe(245);
      expect(await balanceOf(omarDates)).toBe(-40);
    });

    it('records a removed line and a line moved to another account', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const ali = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      const omarDates = await makeAccount('PARTY-002', LedgerAccountType.PARTY, 0, 'Omar Dates');
      const zaid = await makeAccount('PARTY-003', LedgerAccountType.PARTY, 0, 'Zaid Foods');
      const receipt = await createReceipt(
        {
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
          lines: [
            { accountId: ali._id.toString(), amount: 10 },
            { accountId: omarDates._id.toString(), amount: 20 },
          ],
        },
        sachin,
      );

      await service.update(receipt._id.toString(), { lines: [{ accountId: zaid._id.toString(), amount: 10 }] }, sachin);

      const [latest] = await auditFor(receipt._id);
      expect(latest.changes).toEqual([
        {
          field: 'lines',
          label: 'Line removed',
          from: 'Ali Traders: 10.00',
          to: null,
        },
        {
          field: 'lines',
          label: 'Line removed',
          from: 'Omar Dates: 20.00',
          to: null,
        },
        {
          field: 'lines',
          label: 'Line added',
          from: null,
          to: 'Zaid Foods: 10.00',
        },
        { field: 'grandTotal', label: 'Total', from: 30, to: 10 },
      ]);
    });

    it('rejects an edit that changes nothing, without touching updatedAt, balances or the audit log', async () => {
      const { cash, party, receipt } = await postedReceipt();
      const id = receipt._id.toString();

      const noOps: UpdateCashReceiptDto[] = [
        {},
        { changeNote: 'Just looking' },
        {
          cashierId: mainCashier.id,
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
        },
        {
          lines: [
            {
              accountId: party._id.toString(),
              amount: 100,
              vat: 5,
              narration: 'Part payment',
            },
          ],
        },
      ];
      for (const dto of noOps) {
        await expect(service.update(id, dto, omar)).rejects.toThrow('No changes to save');
      }

      const after = await service.findById(id);
      expect(after.updatedAt).toBeNull();
      expect(after.updatedBy).toBeNull();
      expect(after.lines[0].oldBalance).toBe(500);
      expect((await auditFor(id)).map((entry) => entry.action)).toEqual(['created']);
      expect(await balanceOf(cash)).toBe(1105);
      expect(await balanceOf(party)).toBe(395);
    });

    it('only accepts a change note up to 500 characters', async () => {
      const pipe = createAppValidationPipe();
      const validate = (body: object) => pipe.transform(body, { type: 'body', metatype: UpdateCashReceiptDto });

      await expect(validate({ comments: 'A', changeNote: 'x'.repeat(500) })).resolves.toBeDefined();
      await expect(validate({ comments: 'A', changeNote: 'x'.repeat(501) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('cancel', () => {
    it('reverses the posting, keeps the voucher, and records who, when and why', async () => {
      const { cash, party, receipt } = await postedReceipt();

      const cancelled = await service.cancel(receipt._id.toString(), { reason: '  Duplicate entry ' }, omar);

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelledBy).toMatchObject({ name: 'Omar' });
      expect(cancelled.cancelledAt).toBeInstanceOf(Date);
      expect(cancelled.cancelReason).toBe('Duplicate entry');
      expect(cancelled.updatedAt).toBeNull();
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(party)).toBe(500);

      const [latest] = await auditFor(receipt._id);
      expect(latest).toMatchObject({
        action: 'cancelled',
        actorName: 'Omar',
        reason: 'Duplicate entry',
        changes: [{ field: 'status', label: 'Status', from: 'posted', to: 'cancelled' }],
      });
    });

    it('rejects a missing or too-short reason', async () => {
      const { cash, receipt } = await postedReceipt();
      const id = receipt._id.toString();

      for (const dto of [{}, { reason: '' }, { reason: '  ab  ' }, undefined]) {
        await expect(service.cancel(id, dto as CancelCashReceiptDto, omar)).rejects.toThrow(/at least 3 characters/);
      }

      const pipe = createAppValidationPipe();
      for (const body of [{}, { reason: 'ab' }, { reason: '   ' }]) {
        await expect(
          pipe.transform(body, {
            type: 'body',
            metatype: CancelCashReceiptDto,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }

      expect((await service.findById(id)).status).toBe('posted');
      expect(await balanceOf(cash)).toBe(1105);
      expect((await auditFor(id)).map((entry) => entry.action)).toEqual(['created']);
    });

    it('cannot edit or cancel a cancelled receipt, and deleting it does not reverse twice', async () => {
      const { cash, party, receipt } = await postedReceipt();
      const id = receipt._id.toString();
      await service.cancel(id, { reason: 'Duplicate' }, sachin);

      await expect(service.update(id, { comments: 'Omar' }, sachin)).rejects.toThrow(/cancelled and cannot be edited/);
      await expect(service.cancel(id, { reason: 'Again' }, sachin)).rejects.toThrow(
        /cancelled and cannot be cancelled again/,
      );

      await service.remove(id);
      expect(await balanceOf(cash)).toBe(1000);
      expect(await balanceOf(party)).toBe(500);
    });
  });

  describe('receipts from before audit tracking', () => {
    async function insertLegacy(cashAccountId: Types.ObjectId, accountId: Types.ObjectId) {
      // Written through the driver, exactly as the old schema left them:
      // no status, no createdBy/updatedBy, Mongoose timestamps.
      const at = new Date('2026-01-05T08:00:00Z');
      const { insertedId } = await cashReceiptModel.collection.insertOne({
        voucherNo: 'CR000900',
        voucherDate: new Date('2026-01-05'),
        cashier: 'Old Counter Ali',
        cashAccountId,
        lines: [{ accountId, oldBalance: 0, amount: 70, vat: 0, netAmount: 70 }],
        grossTotal: 70,
        totalTax: 0,
        grandTotal: 70,
        createdAt: at,
        updatedAt: at,
      });
      return insertedId;
    }

    it('still load, show an unknown creator, and get no invented history', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 70, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, -70, 'Ali Traders');
      const legacyId = await insertLegacy(cash._id, party._id);

      const legacy = await service.findById(legacyId.toString());
      expect(legacy.status).toBe('posted');
      expect(legacy.createdBy).toBeNull();

      const page = await service.findAll({});
      expect(page.items[0]).toMatchObject({
        voucherNo: 'CR000900',
        status: 'posted',
        createdBy: null,
        updatedBy: null,
        cashAccount: { name: 'Main Cash' },
      });
      expect(page.summary).toEqual({ count: 1, total: 70 });
      expect(await auditFor(legacyId)).toEqual([]);

      // Editing one starts its history from that edit only.
      await expect(service.update(legacyId.toString(), { comments: 'Checked' }, sachin)).rejects.toThrow(
        /choose a cashier/,
      );
      await service.update(legacyId.toString(), { cashierId: mainCashier.id }, sachin);
      expect((await auditFor(legacyId)).map((entry) => entry.action)).toEqual(['updated']);
      expect((await service.findById(legacyId.toString())).createdBy).toBeNull();
    });
  });

  describe('list', () => {
    /**
     * Fixture:
     *   CR000001  2026-09-10  Main Cash  Ali (+Omar, +Ali again)  110  by Sachin  "Bulk payment" / "Invoice 7"
     *   CR000002  2026-09-15  Main Cash  Omar                      20   by Omar
     *   CR000003  2026-09-20  Van Cash   Zaid                      300  by Sachin   (cancelled)
     *   CR000004  2026-09-20  Van Cash   Ali                       50   by Omar     comments "cheque bounced"
     */
    async function seed() {
      const main = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const van = await makeAccount('CASH-002', LedgerAccountType.CASH, 0, 'Van Cash');
      const ali = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      const omarDates = await makeAccount('PARTY-002', LedgerAccountType.PARTY, 0, 'Omar Dates');
      const zaid = await makeAccount('PARTY-003', LedgerAccountType.PARTY, 0, 'Zaid Foods');
      const line = (account: LedgerAccountDocument, amount: number, narration?: string) => ({
        accountId: account._id.toString(),
        amount,
        narration,
      });

      const r1 = await createReceipt(
        {
          voucherDate: '2026-09-10',
          cashAccountId: main.id,
          comments: 'Bulk payment',
          lines: [line(ali, 50, 'Invoice 7'), line(omarDates, 40), line(ali, 20)],
        },
        sachin,
      );
      const r2 = await createReceipt(
        {
          voucherDate: '2026-09-15',
          cashAccountId: main.id,
          lines: [line(omarDates, 20)],
        },
        omar,
      );
      const r3 = await createReceipt(
        {
          voucherDate: '2026-09-20',
          cashAccountId: van.id,
          lines: [line(zaid, 300)],
        },
        sachin,
      );
      const r4 = await createReceipt(
        {
          voucherDate: '2026-09-20',
          cashAccountId: van.id,
          comments: 'Cheque bounced',
          lines: [line(ali, 50)],
        },
        omar,
      );
      await service.cancel(r3.id, { reason: 'Duplicate' }, sachin);

      return { main, van, ali, omarDates, zaid, r1, r2, r3, r4 };
    }

    const voucherNos = async (query: CashReceiptQueryDto) =>
      (await service.findAll(query)).items.map((row) => row.voucherNo);

    it('returns the row shape with parties summary, audit fields and comment count', async () => {
      const { main, ali, r1 } = await seed();
      await commentsService.create(
        {
          entityType: 'cash-receipt',
          entityId: r1.id,
          text: 'Called the party',
        },
        omar,
      );
      await commentsService.create({ entityType: 'cash-receipt', entityId: r1.id, text: 'Paid in full' }, sachin);

      const page = await service.findAll({ q: 'CR000001' });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        id: r1.id,
        voucherNo: 'CR000001',
        date: new Date('2026-09-10'),
        cashAccount: { id: main.id, name: 'Main Cash' },
        cashier: { id: mainCashier.id, name: 'Sachin' },
        paymentMethod: 'cash',
        // Ali, Omar, Ali: first account plus one other distinct account.
        partiesSummary: {
          firstAccount: { id: ali.id, name: 'Ali Traders' },
          othersCount: 1,
        },
        grandTotal: 110,
        status: 'posted',
        createdBy: { id: sachin.id, name: 'Sachin' },
        createdAt: r1.createdAt,
        updatedBy: null,
        updatedAt: null,
        commentCount: 2,
      });
    });

    it('defaults to every status, newest first, and excludes cancelled vouchers from the total', async () => {
      await seed();

      const page = await service.findAll({});
      expect(page.items.map((row) => row.voucherNo)).toEqual(['CR000004', 'CR000003', 'CR000002', 'CR000001']);
      expect(page.items.find((row) => row.voucherNo === 'CR000003')!.status).toBe('cancelled');
      expect(page.summary).toEqual({ count: 4, total: 180 });
      expect(page).toMatchObject({ page: 1, pageSize: 20 });
    });

    it('filters by status', async () => {
      await seed();

      expect(await voucherNos({ status: 'posted' })).toEqual(['CR000004', 'CR000002', 'CR000001']);
      expect(await voucherNos({ status: 'cancelled' })).toEqual(['CR000003']);
      expect(await voucherNos({ status: 'all' })).toHaveLength(4);
      expect((await service.findAll({ status: 'cancelled' })).summary).toEqual({
        count: 1,
        total: 0,
      });
    });

    it('filters by date range, with a date-only dateTo covering the whole day', async () => {
      await seed();

      expect(await voucherNos({ dateFrom: '2026-09-15' })).toEqual(['CR000004', 'CR000003', 'CR000002']);
      expect(await voucherNos({ dateTo: '2026-09-15' })).toEqual(['CR000002', 'CR000001']);
      expect(await voucherNos({ dateFrom: '2026-09-11', dateTo: '2026-09-19' })).toEqual(['CR000002']);
      await expect(service.findAll({ dateFrom: '2026-09-20', dateTo: '2026-09-10' })).rejects.toThrow(
        /dateFrom must not be after dateTo/,
      );
    });

    it('filters by cash account, by any line account, and by creator', async () => {
      const { main, van, ali, omarDates, zaid } = await seed();

      expect(await voucherNos({ cashAccountId: main.id })).toEqual(['CR000002', 'CR000001']);
      expect(await voucherNos({ cashAccountId: van.id })).toEqual(['CR000004', 'CR000003']);
      // Ali is the first line of CR000001 and CR000004; Omar is a later line of CR000001.
      expect(await voucherNos({ accountId: ali.id })).toEqual(['CR000004', 'CR000001']);
      expect(await voucherNos({ accountId: omarDates.id })).toEqual(['CR000002', 'CR000001']);
      expect(await voucherNos({ accountId: zaid.id })).toEqual(['CR000003']);
      expect(await voucherNos({ createdBy: sachin.id })).toEqual(['CR000003', 'CR000001']);
      expect(await voucherNos({ createdBy: omar.id })).toEqual(['CR000004', 'CR000002']);
      expect(await voucherNos({ createdBy: new Types.ObjectId().toString() })).toEqual([]);
    });

    it('filters by amount range, inclusive', async () => {
      await seed();

      expect(await voucherNos({ amountMin: 50 })).toEqual(['CR000004', 'CR000003', 'CR000001']);
      expect(await voucherNos({ amountMax: 50 })).toEqual(['CR000004', 'CR000002']);
      expect(await voucherNos({ amountMin: 50, amountMax: 110 })).toEqual(['CR000004', 'CR000001']);
      await expect(service.findAll({ amountMin: 100, amountMax: 10 })).rejects.toThrow(/amountMin/);
    });

    it('searches voucher number, comments and line narration, case-insensitively and literally', async () => {
      await seed();

      expect(await voucherNos({ q: 'cr000002' })).toEqual(['CR000002']);
      expect(await voucherNos({ q: 'BOUNCED' })).toEqual(['CR000004']);
      expect(await voucherNos({ q: 'invoice 7' })).toEqual(['CR000001']);
      expect(await voucherNos({ q: '.*' })).toEqual([]);
      expect(await voucherNos({ q: '   ' })).toHaveLength(4);
    });

    it('combines filters, and the summary follows the combined filter', async () => {
      const { van, ali } = await seed();

      expect(await voucherNos({ cashAccountId: van.id, status: 'posted' })).toEqual(['CR000004']);
      expect(
        await voucherNos({
          accountId: ali.id,
          createdBy: sachin.id,
          dateTo: '2026-09-15',
        }),
      ).toEqual(['CR000001']);
      expect(
        await voucherNos({
          createdBy: sachin.id,
          amountMin: 200,
          status: 'posted',
        }),
      ).toEqual([]);
      expect(await voucherNos({ q: 'payment', amountMax: 100 })).toEqual([]);

      const vanAll = await service.findAll({
        cashAccountId: van.id,
        dateFrom: '2026-09-20',
        dateTo: '2026-09-20',
      });
      expect(vanAll.items.map((row) => row.voucherNo)).toEqual(['CR000004', 'CR000003']);
      expect(vanAll.summary).toEqual({ count: 2, total: 50 });
    });

    it('sorts by date, amount or voucher number in either direction', async () => {
      await seed();

      expect(await voucherNos({ sortBy: 'date', sortDir: 'asc' })).toEqual([
        'CR000001',
        'CR000002',
        'CR000003',
        'CR000004',
      ]);
      expect(await voucherNos({ sortBy: 'amount', sortDir: 'desc' })).toEqual([
        'CR000003',
        'CR000001',
        'CR000004',
        'CR000002',
      ]);
      expect(await voucherNos({ sortBy: 'amount', sortDir: 'asc' })).toEqual([
        'CR000002',
        'CR000004',
        'CR000001',
        'CR000003',
      ]);
      expect(await voucherNos({ sortBy: 'voucherNo', sortDir: 'asc' })).toEqual([
        'CR000001',
        'CR000002',
        'CR000003',
        'CR000004',
      ]);
    });

    it('pages results while the summary covers the whole filter', async () => {
      await seed();

      const second = await service.findAll({
        sortBy: 'voucherNo',
        sortDir: 'asc',
        page: 2,
        pageSize: 3,
      });
      expect(second.items.map((row) => row.voucherNo)).toEqual(['CR000004']);
      expect(second).toMatchObject({
        page: 2,
        pageSize: 3,
        summary: { count: 4, total: 180 },
      });
    });

    it('validates query parameters', async () => {
      const pipe = createAppValidationPipe();
      const parse = (query: object) =>
        pipe.transform(query, {
          type: 'query',
          metatype: CashReceiptQueryDto,
        }) as Promise<CashReceiptQueryDto>;

      await expect(parse({ amountMin: '10.5', page: '2', pageSize: '50' })).resolves.toMatchObject({
        amountMin: 10.5,
        page: 2,
        pageSize: 50,
      });
      for (const bad of [
        { status: 'deleted' },
        { sortBy: 'cashier' },
        { sortDir: 'up' },
        { pageSize: '101' },
        { page: '0' },
        { amountMin: '-1' },
        { createdBy: 'sachin' },
        { accountId: 'nope' },
        { dateFrom: 'yesterday' },
      ]) {
        await expect(parse(bad)).rejects.toBeInstanceOf(BadRequestException);
      }
    });
  });

  describe('HTTP: actor and permissions', () => {
    async function accounts() {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      return {
        cash,
        party,
        body: {
          voucherDate: '2026-09-21',
          cashAccountId: cash.id,
          cashierId: mainCashier.id,
          lines: [{ accountId: party.id, amount: 10 }],
        },
      };
    }

    it('takes the creator from the token and rejects a body that claims one', async () => {
      const { body } = await accounts();
      tokenUser = omar;

      const forged = await request(app.getHttpServer())
        .post('/cash-receipts')
        .send({ ...body, createdBy: { id: sachin.id, name: 'Sachin' } });
      expect(forged.status).toBe(400);
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);

      const created = await request(app.getHttpServer()).post('/cash-receipts').send(body);
      expect(created.status).toBe(201);
      expect(created.body.createdBy).toEqual({ id: omar.id, name: 'Omar' });

      const [entry] = await auditFor(created.body._id);
      expect(entry.actorId.toString()).toBe(omar.id);
      expect(entry.actorName).toBe('Omar');
    });

    it('takes the editor and canceller from the token, never the body', async () => {
      const { body } = await accounts();
      const { body: receipt } = await request(app.getHttpServer()).post('/cash-receipts').send(body);
      tokenUser = omar;

      for (const forged of [
        { updatedBy: { id: sachin.id, name: 'Sachin' } },
        { actorId: sachin.id },
        { updatedAt: '2020-01-01' },
      ]) {
        const res = await request(app.getHttpServer())
          .patch(`/cash-receipts/${receipt._id}`)
          .send({ comments: 'X', ...forged });
        expect(res.status).toBe(400);
      }

      const edited = await request(app.getHttpServer()).patch(`/cash-receipts/${receipt._id}`).send({ comments: 'X' });
      expect(edited.status).toBe(200);
      expect(edited.body.updatedBy).toEqual({ id: omar.id, name: 'Omar' });

      const forgedCancel = await request(app.getHttpServer())
        .post(`/cash-receipts/${receipt._id}/cancel`)
        .send({
          reason: 'Duplicate',
          cancelledBy: { id: sachin.id, name: 'Sachin' },
        });
      expect(forgedCancel.status).toBe(400);

      const cancelled = await request(app.getHttpServer())
        .post(`/cash-receipts/${receipt._id}/cancel`)
        .send({ reason: 'Duplicate' });
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.cancelledBy).toEqual({ id: omar.id, name: 'Omar' });

      expect((await auditFor(receipt._id)).map((entry) => [entry.action, entry.actorName])).toEqual([
        ['cancelled', 'Omar'],
        ['updated', 'Omar'],
        ['created', 'Sachin'],
      ]);
    });

    it('rejects a no-op edit and a reasonless cancel over HTTP', async () => {
      const { body } = await accounts();
      const { body: receipt } = await request(app.getHttpServer()).post('/cash-receipts').send(body);

      const noop = await request(app.getHttpServer())
        .patch(`/cash-receipts/${receipt._id}`)
        .send({ changeNote: 'nothing' });
      expect(noop.status).toBe(400);
      expect(noop.body.message).toBe('No changes to save');

      const noReason = await request(app.getHttpServer()).post(`/cash-receipts/${receipt._id}/cancel`).send({});
      expect(noReason.status).toBe(400);
    });

    it('needs cash-receipts:manage for writes but not for reading or commenting', async () => {
      const { body } = await accounts();
      const { body: receipt } = await request(app.getHttpServer()).post('/cash-receipts').send(body);
      tokenUser = makeUser('Viewer', []);
      const server = app.getHttpServer();

      expect((await request(server).post('/cash-receipts').send(body)).status).toBe(403);
      expect((await request(server).patch(`/cash-receipts/${receipt._id}`).send({ comments: 'X' })).status).toBe(403);
      expect((await request(server).post(`/cash-receipts/${receipt._id}/cancel`).send({ reason: 'Nope' })).status).toBe(
        403,
      );

      expect((await request(server).get('/cash-receipts')).status).toBe(200);
      const comment = await request(server).post('/comments').send({
        entityType: 'cash-receipt',
        entityId: receipt._id,
        text: ' Looks fine ',
      });
      expect(comment.status).toBe(201);
      expect(comment.body).toMatchObject({
        text: 'Looks fine',
        author: { id: tokenUser.id, name: 'Viewer' },
      });

      const forgedAuthor = await request(server).post('/comments').send({
        entityType: 'cash-receipt',
        entityId: receipt._id,
        text: 'hi',
        authorName: 'Boss',
      });
      expect(forgedAuthor.status).toBe(400);

      const activity = await request(server)
        .get('/activity')
        .query({ entityType: 'cash-receipt', entityId: receipt._id });
      expect(activity.status).toBe(200);
      expect(activity.body.commentCount).toBe(1);
      expect(activity.body.items.map((item: { kind: string }) => item.kind)).toEqual(['comment', 'audit']);

      const list = await request(server).get('/cash-receipts').query({ status: 'posted' });
      expect(list.body.items[0].commentCount).toBe(1);
    });

    it('offers no route to edit or delete comments or audit entries', async () => {
      const { body } = await accounts();
      const { body: receipt } = await request(app.getHttpServer()).post('/cash-receipts').send(body);
      const { body: comment } = await request(app.getHttpServer()).post('/comments').send({
        entityType: 'cash-receipt',
        entityId: receipt._id,
        text: 'hello',
      });
      const server = app.getHttpServer();

      for (const path of [`/comments/${comment.id}`, `/activity/${comment.id}`, '/comments', '/activity']) {
        expect((await request(server).patch(path).send({ text: 'edited' })).status).toBe(404);
        expect((await request(server).put(path).send({ text: 'edited' })).status).toBe(404);
        expect((await request(server).delete(path)).status).toBe(404);
      }
      expect(await commentModel.countDocuments({ text: 'hello' }).exec()).toBe(1);
      expect(await auditModel.countDocuments().exec()).toBe(1);
    });
  });

  describe('cashier', () => {
    async function accounts() {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      const dto = { voucherDate: '2026-09-21', cashAccountId: cash.id, lines: [{ accountId: party.id, amount: 10 }] };
      return { cash, party, dto };
    }

    it('is required', async () => {
      const { dto } = await accounts();
      const pipe = createAppValidationPipe();
      const { CreateCashReceiptDto } = await import('./dto/create-cash-receipt.dto.js');

      await expect(pipe.transform(dto, { type: 'body', metatype: CreateCashReceiptDto })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        pipe.transform({ ...dto, cashier: 'Free text' }, { type: 'body', metatype: CreateCashReceiptDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...dto, cashierId: new Types.ObjectId().toString() }, sachin)).rejects.toThrow(
        /Cashier .* not found/,
      );
      await expect(
        service.update(new Types.ObjectId().toString(), { cashierId: null as never }, sachin),
      ).rejects.toThrow();
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
    });

    it('rejects an inactive cashier on create, consuming no voucher number', async () => {
      const { dto } = await accounts();
      await cashierService.update(otherCashier.id, { status: CashierStatus.INACTIVE }, sachin);

      await expect(createReceipt({ ...dto, cashierId: otherCashier.id }, sachin)).rejects.toThrow(
        /CSH-0002 \(Omar\) is inactive/,
      );
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
      expect((await createReceipt(dto, sachin)).voucherNo).toBe('CR000001');
    });

    it('snapshots the cashier name on the receipt', async () => {
      const { dto } = await accounts();
      const receipt = await createReceipt(dto, sachin);
      expect(receipt.cashierId!.toString()).toBe(mainCashier.id);
      expect(receipt.cashierName).toBe('Sachin');

      await cashierService.update(mainCashier.id, { name: 'Sachin Kumar' }, sachin);
      expect((await service.findById(receipt.id)).cashierName).toBe('Sachin');
    });

    it('keeps an unchanged inactive cashier on edit, but needs an active one to switch', async () => {
      const { dto } = await accounts();
      const receipt = await createReceipt(dto, sachin);
      await cashierService.update(mainCashier.id, { status: CashierStatus.INACTIVE }, sachin);

      // Unchanged (omitted, or the same id sent back): allowed although inactive.
      await expect(service.update(receipt.id, { comments: 'Checked' }, sachin)).resolves.toBeDefined();
      await expect(
        service.update(receipt.id, { cashierId: mainCashier.id, comments: 'Checked again' }, sachin),
      ).resolves.toBeDefined();

      const third = await cashierService.create({ name: 'Zaid', status: CashierStatus.INACTIVE }, sachin);
      await expect(service.update(receipt.id, { cashierId: third.id }, sachin)).rejects.toThrow(/is inactive/);

      const switched = await service.update(receipt.id, { cashierId: otherCashier.id }, omar);
      expect(switched.cashierName).toBe('Omar');
      const [latest] = await auditFor(receipt._id);
      expect(latest.changes).toEqual([{ field: 'cashier', label: 'Cashier', from: 'Sachin', to: 'Omar' }]);
    });

    it('filters the list by cashier and shows it on each row', async () => {
      const { dto } = await accounts();
      await createReceipt(dto, sachin);
      await createReceipt({ ...dto, cashierId: otherCashier.id }, sachin);

      const byOmar = await service.findAll({ cashierId: otherCashier.id });
      expect(byOmar.items.map((row) => row.cashier)).toEqual([{ id: otherCashier.id, name: 'Omar' }]);
      expect(byOmar.summary).toEqual({ count: 1, total: 10 });
      expect((await service.findAll({ cashierId: mainCashier.id, status: 'posted' })).items).toHaveLength(1);
    });

    it('cannot be deleted once a receipt uses it, even a cancelled one; deactivating is allowed', async () => {
      const { dto } = await accounts();
      const receipt = await createReceipt(dto, sachin);
      await service.cancel(receipt.id, { reason: 'Duplicate' }, sachin);

      await expect(cashierService.remove(mainCashier.id)).rejects.toThrow(
        'Cannot delete cashier CSH-0001 (Sachin): it is used by cash receipts. Deactivate it instead.',
      );
      await expect(
        cashierService.update(mainCashier.id, { status: CashierStatus.INACTIVE }, sachin),
      ).resolves.toMatchObject({ status: 'inactive' });
      await expect(cashierService.remove(otherCashier.id)).resolves.toEqual({ success: true });
    });

    it('moves a legacy free-text cashier into cashierName, idempotently, and still loads', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      const legacy = (voucherNo: string, cashier: string | undefined) => ({
        voucherNo,
        voucherDate: new Date('2026-01-05'),
        cashAccountId: cash._id,
        ...(cashier === undefined ? {} : { cashier }),
        lines: [{ accountId: party._id, oldBalance: 0, amount: 5, vat: 0, netAmount: 5 }],
        grossTotal: 5,
        totalTax: 0,
        grandTotal: 5,
      });
      await cashReceiptModel.collection.insertMany([
        legacy('CR000901', '  Old Counter Ali '),
        legacy('CR000902', '   '),
        legacy('CR000903', undefined),
      ]);

      // Before the migration they load, with no cashier.
      expect(
        (await service.findById((await cashReceiptModel.findOne({ voucherNo: 'CR000901' }))!.id)).cashierId,
      ).toBeNull();

      expect(await backfillCashReceiptCashiers(cashReceiptModel)).toEqual({ migrated: 2 });
      expect(await backfillCashReceiptCashiers(cashReceiptModel)).toEqual({ migrated: 0 });

      const raw = await cashReceiptModel.collection.find({}, { sort: { voucherNo: 1 } }).toArray();
      expect(
        raw.map((doc) => [doc.voucherNo, doc.cashierId ?? null, doc.cashierName ?? null, 'cashier' in doc]),
      ).toEqual([
        ['CR000901', null, 'Old Counter Ali', false],
        ['CR000902', null, null, false],
        ['CR000903', null, null, false],
      ]);

      const rows = (await service.findAll({ sortBy: 'voucherNo', sortDir: 'asc' })).items;
      expect(rows[0].cashier).toEqual({ id: null, name: 'Old Counter Ali' });
    });
  });

  describe('received-into account', () => {
    async function accounts() {
      const bank = await makeAccount('BNK-001', LedgerAccountType.BANK, 2000, 'Emirates NBD Current');
      const wallet = await makeAccount('WAL-001', LedgerAccountType.WALLET, 0, 'STC Pay');
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 300, 'Ali Traders');
      return { bank, wallet, cash, party };
    }

    it('posts a bank receipt: balances move, the reference is saved, and the PDF says BANK RECEIPT VOUCHER', async () => {
      const { bank, party } = await accounts();

      const receipt = await createReceipt(
        {
          voucherDate: '2026-09-21',
          cashAccountId: bank.id,
          paymentReference: '  TT-2026-0915  ',
          lines: [{ accountId: party.id, amount: 1000, vat: 50, narration: 'Invoice 12' }],
        },
        sachin,
      );

      expect(receipt).toMatchObject({ paymentMethod: 'bank', paymentReference: 'TT-2026-0915', grandTotal: 1050 });
      expect(await balanceOf(bank)).toBe(3050);
      expect(await balanceOf(party)).toBe(-750);

      const [row] = (await service.findAll({ q: 'tt-2026' })).items;
      expect(row).toMatchObject({ voucherNo: 'CR000001', paymentMethod: 'bank', cashAccount: { name: 'Emirates NBD Current' } });

      const { definition, buffer } = await printService.print(receipt.id, sachin);
      const text = JSON.stringify(definition);
      expect(text).toContain('"BANK RECEIPT VOUCHER"');
      expect(text).not.toContain('CASH RECEIPT VOUCHER');
      expect(text).toContain('"Received Into"');
      expect(text).toContain('TT-2026-0915');
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('treats a wallet like cash and prints no reference row when there is none', async () => {
      const { wallet, party } = await accounts();
      const receipt = await createReceipt(
        { voucherDate: '2026-09-21', cashAccountId: wallet.id, lines: [{ accountId: party.id, amount: 20 }] },
        sachin,
      );

      expect(receipt.paymentMethod).toBe('cash');
      expect(receipt.paymentReference).toBeNull();
      const text = JSON.stringify((await printService.print(receipt.id, sachin)).definition);
      expect(text).toContain('"CASH RECEIPT VOUCHER"');
      expect(text).not.toContain('"Reference"');
    });

    it('switches the payment method when an edit moves the receipt to a bank account, and audits the reference', async () => {
      const { bank, cash, party } = await accounts();
      const receipt = await createReceipt(
        { voucherDate: '2026-09-21', cashAccountId: cash.id, lines: [{ accountId: party.id, amount: 100 }] },
        sachin,
      );

      const moved = await service.update(receipt.id, { cashAccountId: bank.id, paymentReference: 'CHQ 4411' }, omar);
      expect(moved.paymentMethod).toBe('bank');
      expect(await balanceOf(cash)).toBe(0);
      expect(await balanceOf(bank)).toBe(2100);

      const [latest] = await auditFor(receipt._id);
      expect(latest.changes).toEqual([
        { field: 'cashAccount', label: 'Received into', from: 'Main Cash', to: 'Emirates NBD Current' },
        { field: 'paymentReference', label: 'Payment reference', from: null, to: 'CHQ 4411' },
      ]);
      expect((await service.findAll({ q: 'chq 4411' })).items).toHaveLength(1);
    });

    it('rejects an inactive bank account and a reference over 100 characters', async () => {
      const { bank, party } = await accounts();
      await ledgerAccountModel.updateOne({ _id: bank._id }, { $set: { status: LedgerAccountStatus.INACTIVE } }).exec();
      await expect(
        createReceipt({ voucherDate: '2026-09-21', cashAccountId: bank.id, lines: [{ accountId: party.id, amount: 10 }] }, sachin),
      ).rejects.toThrow(/inactive/);

      const pipe = createAppValidationPipe();
      const { CreateCashReceiptDto } = await import('./dto/create-cash-receipt.dto.js');
      const body = {
        voucherDate: '2026-09-21',
        cashAccountId: bank.id,
        cashierId: mainCashier.id,
        lines: [{ accountId: party.id, amount: 10 }],
      };
      await expect(
        pipe.transform({ ...body, paymentReference: 'x'.repeat(100) }, { type: 'body', metatype: CreateCashReceiptDto }),
      ).resolves.toBeDefined();
      await expect(
        pipe.transform({ ...body, paymentReference: 'x'.repeat(101) }, { type: 'body', metatype: CreateCashReceiptDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ ...body, paymentMethod: 'bank' }, { type: 'body', metatype: CreateCashReceiptDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects the received-into account on a line, on create and on edit', async () => {
      const { bank, party } = await accounts();
      const lines = [{ accountId: party.id, amount: 10 }, { accountId: bank.id, amount: 5 }];

      await expect(
        createReceipt({ voucherDate: '2026-09-21', cashAccountId: bank.id, lines }, sachin),
      ).rejects.toThrow('The "received into" account cannot also be used on a line');

      const receipt = await createReceipt(
        { voucherDate: '2026-09-21', cashAccountId: bank.id, lines: [{ accountId: party.id, amount: 10 }] },
        sachin,
      );
      await expect(service.update(receipt.id, { lines }, sachin)).rejects.toThrow(/cannot also be used on a line/);
      await expect(service.update(receipt.id, { cashAccountId: party.id }, sachin)).rejects.toThrow(
        /must be received into a cash, wallet or bank account/,
      );
      expect(await balanceOf(bank)).toBe(2010);
    });

    it('requires positive line amounts', async () => {
      const { bank, party } = await accounts();
      const pipe = createAppValidationPipe();
      const { CashReceiptLineDto } = await import('./dto/create-cash-receipt.dto.js');

      for (const amount of [0, -5]) {
        await expect(
          pipe.transform({ accountId: party.id, amount }, { type: 'body', metatype: CashReceiptLineDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          createReceipt({ voucherDate: '2026-09-21', cashAccountId: bank.id, lines: [{ accountId: party.id, amount }] }, sachin),
        ).rejects.toThrow('Each line needs a positive amount and a VAT of 0 or more');
      }
      expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
    });
  });

  describe('receipt PDF', () => {
    const pdfOf = (id: string) =>
      request(app.getHttpServer())
        .get(`/cash-receipts/${id}/pdf`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

    /** Every string in a document definition, footer included, for content assertions. */
    function textOf(definition: unknown): string {
      const def = definition as { footer?: (page: number, count: number) => unknown };
      const footer = typeof def.footer === 'function' ? def.footer(1, 1) : null;
      return JSON.stringify([definition, footer]);
    }

    it('returns an inline A4 PDF', async () => {
      const { receipt } = await postedReceipt();

      const res = await pdfOf(receipt.id);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline; filename="CR000001.pdf"');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('labels the first print ORIGINAL and later ones DUPLICATE with the reprint number, auditing each', async () => {
      const { receipt } = await postedReceipt();

      const first = await printService.print(receipt.id, sachin);
      const second = await printService.print(receipt.id, omar);
      const third = await printService.print(receipt.id, omar);

      expect([first.copyNumber, second.copyNumber, third.copyNumber]).toEqual([1, 2, 3]);
      expect(textOf(first.definition)).toContain('"ORIGINAL"');
      expect(textOf(first.definition)).not.toContain('DUPLICATE');
      expect(textOf(second.definition)).toContain('DUPLICATE - Reprint 1');
      expect(textOf(third.definition)).toContain('DUPLICATE - Reprint 2');

      const prints = (await auditFor(receipt._id)).filter((entry) => entry.action === 'printed');
      expect(prints.map((entry) => [entry.actorName, entry.changes[0].to])).toEqual([
        ['Omar', 'DUPLICATE - Reprint 2'],
        ['Omar', 'DUPLICATE - Reprint 1'],
        ['Sachin', 'ORIGINAL'],
      ]);
      expect(prints[0].actorId.toString()).toBe(omar.id);
    });

    it('shows company details, voucher contents, totals in words and who printed it', async () => {
      const { receipt } = await postedReceipt({ comments: 'Settled invoice 7' });
      await moduleRef.get(CompanyService).ensure();
      await companyModel.updateOne({}, { $set: { phone: '+971 6 555 0000', trn: '100234567800003' } }).exec();

      const { definition } = await printService.print(receipt.id, omar);
      const text = textOf(definition);

      expect(definition.pageSize).toBe('A4');
      expect(definition.watermark).toBeUndefined();
      for (const expected of [
        'ALA DATES LLC',
        'Jurf 3',
        'Ajman, United Arab Emirates',
        'Tel: +971 6 555 0000',
        'TRN: 100234567800003',
        'CASH RECEIPT VOUCHER',
        'CR000001',
        '21/09/2026',
        'Main Cash',
        'Sachin',
        'Ali Traders',
        'Part payment',
        '100.00',
        '5.00',
        '105.00',
        'Grand Total (AED)',
        'UAE Dirhams One Hundred Five Only',
        'Settled invoice 7',
        'Cashier Signature',
        'Payer Signature',
        'Printed by Omar on ',
        ' GST',
      ]) {
        expect(text).toContain(expected);
      }
    });

    it('leaves out the TRN line when no TRN is set', async () => {
      const { receipt } = await postedReceipt();
      const { definition } = await printService.print(receipt.id, sachin);
      expect(textOf(definition)).not.toContain('TRN:');
    });

    it('watermarks a cancelled receipt and shows the reason and who cancelled it', async () => {
      const { receipt } = await postedReceipt();
      await service.cancel(receipt.id, { reason: 'Entered twice' }, omar);

      const { definition, buffer } = await printService.print(receipt.id, sachin);
      expect(definition.watermark).toMatchObject({ text: 'CANCELLED' });
      const text = textOf(definition);
      expect(text).toContain('THIS VOUCHER IS CANCELLED');
      expect(text).toContain('Cancelled by Omar on ');
      expect(text).toContain('Reason: Entered twice');
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('prints a legacy receipt with an unknown preparer', async () => {
      const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0, 'Main Cash');
      const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0, 'Ali Traders');
      const { insertedId } = await cashReceiptModel.collection.insertOne({
        voucherNo: 'CR000900',
        voucherDate: new Date('2026-01-05'),
        cashAccountId: cash._id,
        cashierName: 'Old Counter Ali',
        lines: [{ accountId: party._id, oldBalance: 0, amount: 70, vat: 0, netAmount: 70 }],
        grossTotal: 70,
        totalTax: 0,
        grandTotal: 70,
      });

      const { definition } = await printService.print(insertedId.toString(), sachin);
      expect(textOf(definition)).toContain('Prepared by: ');
      expect(textOf(definition)).toContain('"Unknown"');
      expect(textOf(definition)).toContain('Old Counter Ali');
    });

    it('records nothing when the print fails part-way', async () => {
      const { receipt } = await postedReceipt();
      vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));

      await expect(printService.print(receipt.id, sachin)).rejects.toThrow('disk full');
      expect((await service.findById(receipt.id)).printCount).toBe(0);
      expect((await printService.print(receipt.id, sachin)).copyNumber).toBe(1);
    });

    it('404s for an unknown receipt', async () => {
      expect((await pdfOf(new Types.ObjectId().toString())).status).toBe(404);
      expect((await pdfOf('not-an-id')).status).toBe(400);
    });
  });
});
