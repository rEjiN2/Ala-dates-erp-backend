import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import type { Connection, Model } from 'mongoose';
import { SequenceService } from './sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from './schemas/counter.schema.js';
import { formatSequenceCode, parseSequenceCode, type CodeSequence } from './code-sequence.js';

const BRANCH: CodeSequence = { key: 'test:branch', prefix: 'BR-', width: 4 };

describe('code-sequence helpers', () => {
  it('zero-pads to the width and grows naturally past it', () => {
    expect(formatSequenceCode(BRANCH, 1)).toBe('BR-0001');
    expect(formatSequenceCode(BRANCH, 9999)).toBe('BR-9999');
    expect(formatSequenceCode(BRANCH, 10000)).toBe('BR-10000');
  });

  it('parses only codes in the exact prefix + digits shape', () => {
    expect(parseSequenceCode(BRANCH, 'BR-0042')).toBe(42);
    expect(parseSequenceCode(BRANCH, 'BR-7')).toBe(7);
    expect(parseSequenceCode(BRANCH, 'BR-10000')).toBe(10000);
    expect(parseSequenceCode(BRANCH, 'BR-00A1')).toBeNull();
    expect(parseSequenceCode(BRANCH, 'BRANCH-1')).toBeNull();
    expect(parseSequenceCode(BRANCH, 'XBR-0001')).toBeNull();
    expect(parseSequenceCode(BRANCH, 'BR-0001-OLD')).toBeNull();
  });
});

describe('SequenceService', () => {
  let moduleRef: TestingModule;
  let service: SequenceService;
  let counterModel: Model<CounterDocument>;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('sequences'),
        MongooseModule.forFeature([{ name: Counter.name, schema: CounterSchema }]),
      ],
      providers: [SequenceService],
    }).compile();

    service = moduleRef.get(SequenceService);
    counterModel = moduleRef.get(getModelToken(Counter.name));
    connection = moduleRef.get(getConnectionToken());
    await counterModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await counterModel.deleteMany({}).exec();
  });

  it('issues sequential numbers starting at 1, independently per key', async () => {
    expect(await service.next('a')).toBe(1);
    expect(await service.next('a')).toBe(2);
    expect(await service.next('b')).toBe(1);
    expect(await service.next('a')).toBe(3);
  });

  it('formats codes from the sequence descriptor', async () => {
    expect(await service.nextCode(BRANCH)).toBe('BR-0001');
    expect(await service.nextCode(BRANCH)).toBe('BR-0002');
  });

  it('never hands out the same number to 50 concurrent callers', async () => {
    const values = await Promise.all(Array.from({ length: 50 }, () => service.next('parallel')));

    expect(new Set(values).size).toBe(50);
    expect([...values].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('rolls the increment back when the caller transaction aborts', async () => {
    await service.next('tx');

    const session = await connection.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          expect(await service.next('tx', session)).toBe(2);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
    } finally {
      await session.endSession();
    }

    expect(await service.next('tx')).toBe(2);
  });

  it('ensureAtLeast raises a counter but never lowers it', async () => {
    expect(await service.ensureAtLeast('floor', 41)).toBe(41);
    expect(await service.next('floor')).toBe(42);
    expect(await service.ensureAtLeast('floor', 10)).toBe(42);
    expect(await service.next('floor')).toBe(43);
  });
});
