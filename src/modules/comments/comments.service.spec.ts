import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { CommentsService } from './comments.service.js';
import { ActivityService } from './activity.service.js';
import { EntityAccessRegistry } from './entity-access.registry.js';
import { ActivityController, CommentsController } from './comments.controller.js';
import { Comment, CommentDocument, CommentSchema } from './schemas/comment.schema.js';
import { CreateCommentDto, EntityRefQueryDto } from './dto/comment.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction, AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';
import { InsertOnlyViolationError } from '../../common/utils/insert-only.plugin.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

function makeUser(name: string, permissions: string[] = []): AuthenticatedUser {
  return {
    id: new Types.ObjectId().toString(),
    email: `${name.toLowerCase()}@example.com`,
    name,
    role: { id: new Types.ObjectId().toString(), name: 'clerk' },
    permissions,
  };
}

describe('Comments and activity', () => {
  let moduleRef: TestingModule;
  let comments: CommentsService;
  let activity: ActivityService;
  let audit: AuditService;
  let commentModel: Model<CommentDocument>;
  let auditModel: Model<AuditLogDocument>;
  let connection: Connection;

  const existing = new Set<string>();
  const thingId = new Types.ObjectId();
  const reader = makeUser('Reader');
  const pipe = createAppValidationPipe();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('comments'),
        MongooseModule.forFeature([
          { name: Comment.name, schema: CommentSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      providers: [CommentsService, ActivityService, EntityAccessRegistry, AuditService],
    }).compile();

    comments = moduleRef.get(CommentsService);
    activity = moduleRef.get(ActivityService);
    audit = moduleRef.get(AuditService);
    commentModel = moduleRef.get(getModelToken(Comment.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    connection = moduleRef.get(getConnectionToken());
    await Promise.all([commentModel.init(), auditModel.init()]);

    // A stand-in entity type: readable only by users holding "things:read".
    moduleRef.get(EntityAccessRegistry).register('thing', {
      exists: async (id) => existing.has(id.toString()),
      canRead: (user) => user.permissions.includes('things:read'),
    });
    reader.permissions = ['things:read'];
    existing.add(thingId.toString());
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    // Both models refuse deletes; clean up through the raw driver.
    await commentModel.collection.deleteMany({});
    await auditModel.collection.deleteMany({});
  });

  const ref = { entityType: 'thing', entityId: thingId.toString() };

  describe('validation', () => {
    const validate = (body: object) =>
      pipe.transform(body, {
        type: 'body',
        metatype: CreateCommentDto,
      }) as Promise<CreateCommentDto>;

    it('trims text and accepts 1 to 1000 characters', async () => {
      expect((await validate({ ...ref, text: '  hello  ' })).text).toBe('hello');
      expect((await validate({ ...ref, text: 'x' })).text).toBe('x');
      expect((await validate({ ...ref, text: 'x'.repeat(1000) })).text).toHaveLength(1000);
      expect((await validate({ ...ref, text: `  ${'x'.repeat(1000)}  ` })).text).toHaveLength(1000);
    });

    it('rejects empty, whitespace-only, too long and missing text', async () => {
      for (const text of ['', '   \n\t ', 'x'.repeat(1001), undefined]) {
        await expect(validate({ ...ref, text })).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects a body that tries to name the author', async () => {
      await expect(validate({ ...ref, text: 'hi', authorId: reader.id })).rejects.toBeInstanceOf(BadRequestException);
      await expect(validate({ ...ref, text: 'hi', authorName: 'Boss' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires a valid entity reference on queries', async () => {
      const query = (q: object) => pipe.transform(q, { type: 'query', metatype: EntityRefQueryDto });
      await expect(query({ entityType: 'thing' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(query({ entityType: 'thing', entityId: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(query({ entityId: thingId.toString() })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('re-checks text length in the service too', async () => {
      await expect(comments.create({ ...ref, text: '   ' }, reader)).rejects.toThrow(/1 to 1000/);
      await expect(comments.create({ ...ref, text: 'x'.repeat(1001) }, reader)).rejects.toThrow(/1 to 1000/);
      expect(await commentModel.countDocuments().exec()).toBe(0);
    });
  });

  it('stores the comment against the authenticated author, with a name snapshot', async () => {
    const created = await comments.create({ ...ref, text: '  Checked with the party  ' }, reader);

    expect(created).toMatchObject({
      entityType: 'thing',
      entityId: thingId.toString(),
      text: 'Checked with the party',
      author: { id: reader.id, name: 'Reader' },
    });
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('lists comments newest first', async () => {
    await comments.create({ ...ref, text: 'first' }, reader);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await comments.create({ ...ref, text: 'second' }, reader);

    expect((await comments.list(ref, reader)).map((comment) => comment.text)).toEqual(['second', 'first']);
  });

  it('only lets users who can read the entity comment on it', async () => {
    await expect(comments.create({ ...ref, text: 'hi' }, makeUser('Outsider'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(comments.list(ref, makeUser('Outsider'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      comments.create(
        {
          entityType: 'thing',
          entityId: new Types.ObjectId().toString(),
          text: 'hi',
        },
        reader,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(comments.create({ ...ref, entityType: 'unknown', text: 'hi' }, reader)).rejects.toThrow(
      /Unknown entityType "unknown"/,
    );
    expect(await commentModel.countDocuments().exec()).toBe(0);
  });

  it('counts comments per entity', async () => {
    const other = new Types.ObjectId();
    existing.add(other.toString());
    await comments.create({ ...ref, text: 'a' }, reader);
    await comments.create({ ...ref, text: 'b' }, reader);
    await comments.create({ entityType: 'thing', entityId: other.toString(), text: 'c' }, reader);

    const counts = await comments.countByEntityIds('thing', [thingId, other, new Types.ObjectId()]);
    expect(Object.fromEntries(counts)).toEqual({
      [thingId.toString()]: 2,
      [other.toString()]: 1,
    });
  });

  it('merges audit entries and comments into one newest-first timeline', async () => {
    const actor = { id: reader.id, name: reader.name };
    const t = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));

    await runInTransaction(connection, (session) =>
      audit.record(
        {
          ...ref,
          entityId: thingId,
          action: AuditAction.CREATED,
          actor,
          at: t(0),
        },
        session,
      ),
    );
    await commentModel.create({
      ...ref,
      entityId: thingId,
      text: 'note',
      authorId: actor.id,
      authorName: 'Reader',
      createdAt: t(1),
    });
    await runInTransaction(connection, (session) =>
      audit.record(
        {
          ...ref,
          entityId: thingId,
          action: AuditAction.UPDATED,
          actor,
          at: t(2),
          changes: [{ field: 'cashier', label: 'Cashier', from: 'A', to: 'B' }],
          reason: 'typo',
        },
        session,
      ),
    );

    const timeline = await activity.timeline(ref, reader);

    expect(timeline.commentCount).toBe(1);
    expect(timeline.items.map((item) => [item.kind, item.at.getTime()])).toEqual([
      ['audit', t(2).getTime()],
      ['comment', t(1).getTime()],
      ['audit', t(0).getTime()],
    ]);
    expect(timeline.items[0]).toMatchObject({
      kind: 'audit',
      action: 'updated',
      actor: { id: reader.id, name: 'Reader' },
      changes: [{ field: 'cashier', label: 'Cashier', from: 'A', to: 'B' }],
      reason: 'typo',
    });
    expect(timeline.items[1]).toMatchObject({
      kind: 'comment',
      text: 'note',
      author: { name: 'Reader' },
    });

    await expect(activity.timeline(ref, makeUser('Outsider'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('insert-only', () => {
    it('has no update or delete method or route', () => {
      for (const service of [CommentsService, ActivityService]) {
        const methods = Object.getOwnPropertyNames(service.prototype);
        expect(methods.filter((name) => /update|delete|remove|edit/i.test(name))).toEqual([]);
      }

      const routeMethods = [CommentsController, ActivityController].flatMap((controller) => {
        const prototype = controller.prototype as unknown as Record<string, object>;
        return Object.getOwnPropertyNames(prototype)
          .filter((name) => name !== 'constructor')
          .map((name) => Reflect.getMetadata(METHOD_METADATA, prototype[name]) as RequestMethod);
      });
      expect(routeMethods.sort((a, b) => a - b)).toEqual(
        [RequestMethod.GET, RequestMethod.POST, RequestMethod.GET].sort((a, b) => a - b),
      );
    });

    it('refuses every update and delete path on the model', async () => {
      const { id } = await comments.create({ ...ref, text: 'original' }, reader);
      const byId = { _id: new Types.ObjectId(id) };

      const attempts: Array<() => Promise<unknown>> = [
        () => commentModel.updateOne(byId, { text: 'edited' }).exec(),
        () => commentModel.updateMany({}, { text: 'edited' }).exec(),
        () => commentModel.findOneAndUpdate(byId, { text: 'edited' }).exec(),
        () => commentModel.findByIdAndDelete(id).exec(),
        () => commentModel.deleteOne(byId).exec(),
        () => commentModel.deleteMany({}).exec(),
        () => commentModel.bulkWrite([{ updateOne: { filter: byId, update: { text: 'edited' } } }]),
        async () => {
          const doc = await commentModel.findById(id).exec();
          doc!.text = 'edited';
          return doc!.save();
        },
        async () => (await commentModel.findById(id).exec())!.deleteOne(),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toBeInstanceOf(InsertOnlyViolationError);
      }

      expect((await comments.list(ref, reader)).map((comment) => comment.text)).toEqual(['original']);
    });
  });
});
