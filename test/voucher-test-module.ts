import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { mongooseTestRoot } from './mongo-test-db.js';
import { CashReceiptService } from '../src/modules/accounting/cash-receipts/cash-receipt.service.js';
import { CashReceiptPrintService } from '../src/modules/accounting/cash-receipts/cash-receipt-print.service.js';
import { CashReceiptController } from '../src/modules/accounting/cash-receipts/cash-receipt.controller.js';
import { CashReceipt, CashReceiptSchema } from '../src/modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashPaymentService } from '../src/modules/accounting/cash-payments/cash-payment.service.js';
import { CashPaymentController } from '../src/modules/accounting/cash-payments/cash-payment.controller.js';
import { CashPayment, CashPaymentSchema } from '../src/modules/accounting/cash-payments/schemas/cash-payment.schema.js';
import { CashHandoverService } from '../src/modules/accounting/cash-handovers/cash-handover.service.js';
import { CashHandoverController } from '../src/modules/accounting/cash-handovers/cash-handover.controller.js';
import {
  CashHandover,
  CashHandoverSchema,
} from '../src/modules/accounting/cash-handovers/schemas/cash-handover.schema.js';
import { OpeningBalanceService } from '../src/modules/accounting/opening-balances/opening-balance.service.js';
import { OpeningBalanceController } from '../src/modules/accounting/opening-balances/opening-balance.controller.js';
import {
  OpeningBalance,
  OpeningBalanceSchema,
} from '../src/modules/accounting/opening-balances/schemas/opening-balance.schema.js';
import { AllocationService } from '../src/modules/accounting/allocations/allocation.service.js';
import { AllocationController } from '../src/modules/accounting/allocations/allocation.controller.js';
import { Allocation, AllocationSchema } from '../src/modules/accounting/allocations/schemas/allocation.schema.js';
import {
  PurchaseInvoice,
  PurchaseInvoiceSchema,
} from '../src/modules/purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { Party, PartySchema } from '../src/modules/party/schemas/party.schema.js';
import { SalesInvoice, SalesInvoiceSchema } from '../src/modules/sales/sales-invoices/schemas/sales-invoice.schema.js';
import { ChequeService } from '../src/modules/accounting/cheques/cheque.service.js';
import { ChequeController } from '../src/modules/accounting/cheques/cheque.controller.js';
import { SalesmanCollectionsService } from '../src/modules/reports/salesman-collections.service.js';
import { ReportsController } from '../src/modules/reports/reports.controller.js';
import { VoucherPostingService } from '../src/modules/accounting/vouchers/voucher-posting.service.js';
import { VoucherPrintService } from '../src/modules/accounting/vouchers/voucher-print.service.js';
import { LedgerEntry, LedgerEntrySchema } from '../src/modules/accounting/vouchers/schemas/ledger-entry.schema.js';
import { LedgerAccountService } from '../src/modules/accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../src/modules/accounting/ledger-accounts/ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountSchema,
  LedgerAccountStatus,
  type LedgerAccountDocument,
  type LedgerAccountType,
} from '../src/modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { LocationService } from '../src/modules/location/location.service.js';
import { Location, LocationSchema } from '../src/modules/location/schemas/location.schema.js';
import { SequenceService } from '../src/modules/sequence/sequence.service.js';
import { Counter, CounterSchema } from '../src/modules/sequence/schemas/counter.schema.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AuditLog, AuditLogSchema } from '../src/modules/audit/schemas/audit-log.schema.js';
import { CommentsService } from '../src/modules/comments/comments.service.js';
import { ActivityService } from '../src/modules/comments/activity.service.js';
import { EntityAccessRegistry } from '../src/modules/comments/entity-access.registry.js';
import { ActivityController, CommentsController } from '../src/modules/comments/comments.controller.js';
import { Comment, CommentSchema } from '../src/modules/comments/schemas/comment.schema.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { UserUsageRegistry } from '../src/modules/users/user-usage.registry.js';
import { User, UserSchema, UserStatus, type UserDocument } from '../src/modules/users/schemas/user.schema.js';
import { Role, RoleSchema } from '../src/modules/roles/schemas/role.schema.js';
import { CompanyService } from '../src/modules/company/company.service.js';
import { CompanySettings, CompanySettingsSchema } from '../src/modules/company/schemas/company-settings.schema.js';
import { FilesService } from '../src/modules/files/files.service.js';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { createAppValidationPipe } from '../src/common/pipes/app-validation.pipe.js';
import { configureHttpApp } from '../src/common/http/configure-http-app.js';
import { ADMIN_PERMISSIONS, DataScope } from '../src/modules/roles/permissions.js';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/auth.types.js';

export function makeUser(name: string, permissions: string[] = [...ADMIN_PERMISSIONS]): AuthenticatedUser {
  return {
    id: new Types.ObjectId().toString(),
    email: `${name.toLowerCase()}@example.com`,
    name,
    role: { id: new Types.ObjectId().toString(), name: 'accountant' },
    permissions,
  };
}

/**
 * Receipts, payments and everything they depend on, wired directly (no JWT
 * strategy) against a private test database. The HTTP app uses the same
 * pipe, filter and query parsing as main.ts; the JWT guard is replaced by one
 * that attaches `harness.tokenUser`.
 */
export async function createVoucherHarness(dbName: string) {
  const harness = { tokenUser: makeUser('Sachin') };

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      mongooseTestRoot(dbName),
      MongooseModule.forFeature([
        { name: CashReceipt.name, schema: CashReceiptSchema },
        { name: CashPayment.name, schema: CashPaymentSchema },
        { name: CashHandover.name, schema: CashHandoverSchema },
        { name: OpeningBalance.name, schema: OpeningBalanceSchema },
        { name: Allocation.name, schema: AllocationSchema },
        { name: PurchaseInvoice.name, schema: PurchaseInvoiceSchema },
        { name: SalesInvoice.name, schema: SalesInvoiceSchema },
        { name: Party.name, schema: PartySchema },
        { name: LedgerEntry.name, schema: LedgerEntrySchema },
        { name: LedgerAccount.name, schema: LedgerAccountSchema },
        { name: Counter.name, schema: CounterSchema },
        { name: Location.name, schema: LocationSchema },
        { name: AuditLog.name, schema: AuditLogSchema },
        { name: Comment.name, schema: CommentSchema },
        { name: User.name, schema: UserSchema },
        { name: Role.name, schema: RoleSchema },
        { name: CompanySettings.name, schema: CompanySettingsSchema },
      ]),
    ],
    controllers: [
      CashReceiptController,
      CashPaymentController,
      CashHandoverController,
      OpeningBalanceController,
      AllocationController,
      ChequeController,
      ReportsController,
      CommentsController,
      ActivityController,
    ],
    providers: [
      CashReceiptService,
      CashReceiptPrintService,
      CashPaymentService,
      CashHandoverService,
      OpeningBalanceService,
      AllocationService,
      ChequeService,
      SalesmanCollectionsService,
      VoucherPostingService,
      VoucherPrintService,
      LedgerAccountService,
      LedgerAccountUsageRegistry,
      LocationService,
      SequenceService,
      AuditService,
      CommentsService,
      ActivityService,
      EntityAccessRegistry,
      UserUsageRegistry,
      UsersService,
      CompanyService,
      // No logo is configured in these tests, so storage is never reached.
      { provide: FilesService, useValue: {} },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().user = harness.tokenUser;
        return true;
      },
    })
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  configureHttpApp(app);
  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const model = <T>(name: string) => moduleRef.get<Model<T>>(getModelToken(name));
  const models = {
    receipt: model(CashReceipt.name),
    payment: model(CashPayment.name),
    handover: model(CashHandover.name),
    openingBalance: model(OpeningBalance.name),
    allocation: model(Allocation.name),
    purchaseInvoice: model(PurchaseInvoice.name),
    party: model(Party.name),
    entry: model(LedgerEntry.name),
    account: model<LedgerAccountDocument>(LedgerAccount.name),
    counter: model(Counter.name),
    audit: model(AuditLog.name),
    comment: model(Comment.name),
    user: model<UserDocument>(User.name),
    role: model(Role.name),
    company: model(CompanySettings.name),
  };
  await Promise.all(Object.values(models).map((m) => m.init()));

  async function makeAccount(
    code: string,
    type: LedgerAccountType,
    balance = 0,
    name = `${code} account`,
    status = LedgerAccountStatus.ACTIVE,
  ): Promise<LedgerAccountDocument> {
    return models.account.create({ code, name, type, balance, status });
  }

  async function balanceOf(account: { _id: Types.ObjectId }): Promise<number> {
    return (await models.account.findById(account._id).exec())!.balance;
  }

  /**
   * Saves `user` (as made by makeUser) with a role holding its permissions
   * and scope, so it can be Collected By / Paid By on a voucher.
   */
  async function persistUser(
    user: AuthenticatedUser,
    extra: { settlesWithOffice?: boolean; locationId?: Types.ObjectId | null; status?: UserStatus } = {},
  ): Promise<AuthenticatedUser> {
    const role = await models.role.create({
      name: `${user.name} role ${new Types.ObjectId().toString()}`,
      permissions: user.permissions,
      dataScope: user.dataScope ?? DataScope.ALL,
    });
    await models.user.create({
      _id: new Types.ObjectId(user.id),
      email: user.email,
      name: user.name,
      passwordHash: 'x',
      role: role._id,
      allowedCashAccountIds: (user.allowedCashAccountIds ?? []).map((id) => new Types.ObjectId(id)),
      ...extra,
    });
    return user;
  }

  /** Empties every collection. Insert-only ones (audit, comments, ledger entries) go through the raw driver. */
  async function reset(): Promise<void> {
    await Promise.all(Object.values(models).map((m) => m.collection.deleteMany({})));
  }

  return {
    harness,
    moduleRef,
    app,
    models,
    makeAccount,
    balanceOf,
    reset,
    persistUser,
    receipts: moduleRef.get(CashReceiptService),
    receiptPrints: moduleRef.get(CashReceiptPrintService),
    payments: moduleRef.get(CashPaymentService),
    handovers: moduleRef.get(CashHandoverService),
    openingBalances: moduleRef.get(OpeningBalanceService),
    allocations: moduleRef.get(AllocationService),
    cheques: moduleRef.get(ChequeService),
    collections: moduleRef.get(SalesmanCollectionsService),
    posting: moduleRef.get(VoucherPostingService),
    audit: moduleRef.get(AuditService),
    users: moduleRef.get(UsersService),
    ledger: moduleRef.get(LedgerAccountService),
    company: moduleRef.get(CompanyService),
  };
}

export type VoucherHarness = Awaited<ReturnType<typeof createVoucherHarness>>;
