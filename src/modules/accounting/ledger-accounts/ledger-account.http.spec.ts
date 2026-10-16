import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { LedgerAccountController } from './ledger-account.controller.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountUsageRegistry } from './ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountStatus,
  LedgerAccountType,
} from './schemas/ledger-account.schema.js';
import { LocationService } from '../../location/location.service.js';
import { Location, LocationSchema } from '../../location/schemas/location.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { configureHttpApp } from '../../../common/http/configure-http-app.js';

/**
 * GET /accounts and GET /accounts/lookup over HTTP, with the same query
 * parsing and validation as main.ts, against data shaped like production:
 * ADCB is an active bank account with bank details and no location.
 */
describe('Accounts lookup over HTTP', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let accountModel: Model<LedgerAccountDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('ledger_accounts_http'),
        MongooseModule.forFeature([
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      controllers: [LedgerAccountController],
      providers: [LedgerAccountService, LedgerAccountUsageRegistry, LocationService, SequenceService],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { id: new Types.ObjectId().toString(), permissions: [] };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    configureHttpApp(app);
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();

    accountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    const { ACTIVE, INACTIVE } = LedgerAccountStatus;
    await accountModel.insertMany([
      {
        code: 'BNK-0001',
        name: 'ADCB',
        type: LedgerAccountType.BANK,
        status: ACTIVE,
        locationId: null,
        bankDetails: { bankName: 'ADCB', accountNumber: '123' },
      },
      { code: 'BNK-0002', name: 'Closed Bank', type: LedgerAccountType.BANK, status: INACTIVE },
      { code: 'CASH-001', name: 'Main Cash Counter', type: LedgerAccountType.CASH, status: ACTIVE },
      { code: 'WAL-0001', name: 'STC Pay', type: LedgerAccountType.WALLET, status: ACTIVE },
      { code: 'EXP-0001', name: 'Rent', type: LedgerAccountType.EXPENSE, status: ACTIVE },
      { code: 'CUS-0001', name: 'Ali Traders', type: LedgerAccountType.PARTY, status: ACTIVE },
      { code: 'SUP-0001', name: 'Omar Farms', type: LedgerAccountType.SUPPLIER, status: ACTIVE },
    ]);
  }, 120_000);

  afterAll(async () => {
    await accountModel?.deleteMany({}).exec();
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const codes = (body: { code: string }[]) => body.map((item) => item.code);

  it('types=cash,wallet,bank&q= returns ADCB with the active cash and wallet accounts', async () => {
    const res = await get('/accounts/lookup?types=cash,wallet,bank&q=');
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['BNK-0001', 'CASH-001', 'WAL-0001']);
    expect(res.body[0]).toEqual({ id: expect.any(String), code: 'BNK-0001', name: 'ADCB', type: 'bank', balance: 0 });
  });

  it('accepts the other common array encodings of types', async () => {
    for (const qs of [
      'types=cash&types=wallet&types=bank',
      'types[]=cash&types[]=wallet&types[]=bank',
      'types%5B%5D=cash&types%5B%5D=wallet&types%5B%5D=bank',
      'types=Cash,Wallet,BANK',
    ]) {
      const res = await get(`/accounts/lookup?${qs}`);
      expect([qs, res.status, codes(res.body)]).toEqual([qs, 200, ['BNK-0001', 'CASH-001', 'WAL-0001']]);
    }
  });

  it('scope=company never returns party or supplier accounts', async () => {
    const all = await get('/accounts/lookup?scope=company');
    expect(codes(all.body)).toEqual(['BNK-0001', 'CASH-001', 'EXP-0001', 'WAL-0001']);
    expect((await get('/accounts/lookup?scope=company&types=party,supplier')).body).toEqual([]);
    expect(codes((await get('/accounts/lookup?scope=company&types=bank,party')).body)).toEqual(['BNK-0001']);
  });

  it('scope=party returns only customer and supplier accounts', async () => {
    expect(codes((await get('/accounts/lookup?scope=party')).body)).toEqual(['CUS-0001', 'SUP-0001']);
  });

  it('the Accounts list excludes customer and supplier accounts by default', async () => {
    const res = await get('/accounts');
    expect(res.status).toBe(200);
    expect(codes(res.body.items)).toEqual(['BNK-0001', 'BNK-0002', 'CASH-001', 'EXP-0001', 'WAL-0001']);
    expect(res.body.total).toBe(5);
    expect((await get('/accounts?type=party')).body.items).toEqual([]);
    expect(codes((await get('/accounts?scope=party')).body.items)).toEqual(['CUS-0001', 'SUP-0001']);
  });

  it('rejects an unknown scope', async () => {
    expect((await get('/accounts/lookup?scope=all')).status).toBe(400);
    expect((await get('/accounts?scope=customers')).status).toBe(400);
  });
});
