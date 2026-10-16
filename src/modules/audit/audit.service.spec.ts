import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { AuditService } from './audit.service.js';
import { AuditAction, AuditLog, AuditLogDocument, AuditLogSchema } from './schemas/audit-log.schema.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';
import { InsertOnlyViolationError } from '../../common/utils/insert-only.plugin.js';

describe('AuditService', () => {
  let moduleRef: TestingModule;
  let service: AuditService;
  let auditModel: Model<AuditLogDocument>;
  let connection: Connection;

  const actor = { id: new Types.ObjectId().toString(), name: 'Auditor' };
  const entityId = new Types.ObjectId();
  const entry = {
    entityType: 'thing',
    entityId,
    entityRef: 'T-1',
    action: AuditAction.CREATED,
    actor,
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('audit'),
        MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }]),
      ],
      providers: [AuditService],
    }).compile();
    service = moduleRef.get(AuditService);
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    connection = moduleRef.get(getConnectionToken());
    await auditModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    // The model refuses deletes; clean up through the raw driver.
    await auditModel.collection.deleteMany({});
  });

  it('records an entry inside a committed transaction', async () => {
    await runInTransaction(connection, (session) => service.record({ ...entry, reason: '  why  ' }, session));

    const [saved] = await service.findForEntity('thing', entityId);
    expect(saved).toMatchObject({
      entityType: 'thing',
      entityRef: 'T-1',
      action: 'created',
      actorName: 'Auditor',
      reason: 'why',
      changes: [],
    });
    expect(saved.actorId.toString()).toBe(actor.id);
  });

  it('leaves no entry behind when the transaction fails after recording', async () => {
    await expect(
      runInTransaction(connection, async (session) => {
        await service.record(entry, session);
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');

    expect(await auditModel.countDocuments().exec()).toBe(0);
  });

  it('refuses to record outside a transaction', async () => {
    await expect(service.record(entry, undefined as never)).rejects.toThrow(/inside the business change's transaction/);

    const session = await connection.startSession();
    try {
      await expect(service.record(entry, session)).rejects.toThrow(/inside/);
    } finally {
      await session.endSession();
    }
    expect(await auditModel.countDocuments().exec()).toBe(0);
  });

  describe('insert-only', () => {
    it('exposes no update or delete method', () => {
      const methods = Object.getOwnPropertyNames(AuditService.prototype);
      expect(methods.filter((name) => /update|delete|remove|edit/i.test(name))).toEqual([]);
    });

    it('refuses every update and delete path on the model', async () => {
      const saved = await runInTransaction(connection, (session) => service.record(entry, session));
      const byId = { _id: saved._id };

      const attempts: Array<() => Promise<unknown>> = [
        () => auditModel.updateOne(byId, { actorName: 'Someone else' }).exec(),
        () => auditModel.updateMany({}, { reason: 'x' }).exec(),
        () => auditModel.replaceOne(byId, { ...entry }).exec(),
        () => auditModel.findOneAndUpdate(byId, { reason: 'x' }).exec(),
        () => auditModel.findOneAndReplace(byId, { ...entry }).exec(),
        () => auditModel.findOneAndDelete(byId).exec(),
        () => auditModel.findByIdAndUpdate(saved._id, { reason: 'x' }).exec(),
        () => auditModel.findByIdAndDelete(saved._id).exec(),
        () => auditModel.deleteOne(byId).exec(),
        () => auditModel.deleteMany({}).exec(),
        () => auditModel.bulkWrite([{ deleteOne: { filter: byId } }]),
        async () => {
          const doc = await auditModel.findById(saved._id).exec();
          doc!.reason = 'rewritten';
          return doc!.save();
        },
        async () => (await auditModel.findById(saved._id).exec())!.deleteOne(),
      ];

      for (const attempt of attempts) {
        await expect(attempt()).rejects.toBeInstanceOf(InsertOnlyViolationError);
      }

      const [unchanged] = await service.findForEntity('thing', entityId);
      expect(unchanged).toMatchObject({ actorName: 'Auditor' });
      expect(unchanged.reason).toBeUndefined();
    });
  });
});
