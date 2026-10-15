import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { Readable } from 'node:stream';
import { FilesService } from './files.service.js';
import { FileOwnerType } from './schemas/file-attachment.schema.js';
import {
  StorageService,
  type StoredFile,
  type StoredFileStream,
  type UploadableFile,
} from '../storage/storage.service.js';
import { StorageBandwidthQuotaExceededException } from '../storage/storage.errors.js';

/** Stand-in adapter: proves callers only ever need the interface, no vendor SDK. */
class FakeStorageService extends StorageService {
  readonly objects = new Map<string, UploadableFile>();
  deleteCalls: string[] = [];

  async upload(file: UploadableFile, path: string): Promise<StoredFile> {
    const key = `${path}/generated-${this.objects.size + 1}`;
    this.objects.set(key, file);
    return { key, size: file.size, mimeType: file.mimeType };
  }

  async download(key: string): Promise<StoredFileStream> {
    const file = this.objects.get(key);
    if (!file) throw new Error(`missing ${key}`);
    return { stream: Readable.from([file.buffer]), size: file.size };
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }
}

function multerFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'passport.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('test'),
    stream: undefined as never,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  } as Express.Multer.File;
}

describe('FilesService', () => {
  let db: Map<string, Record<string, unknown>>;
  let storage: FakeStorageService;
  let modelMock: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
  let service: FilesService;

  const ownerId = new Types.ObjectId().toString();

  beforeEach(() => {
    db = new Map();
    storage = new FakeStorageService();

    modelMock = {
      create: vi.fn(async (input: Record<string, unknown>) => {
        const _id = new Types.ObjectId();
        const doc = { ...input, _id, id: _id.toString() };
        db.set(doc.id, doc);
        return doc;
      }),
      findById: vi.fn((id: string) => ({ exec: async () => db.get(id) ?? null })),
      deleteOne: vi.fn((filter: { _id: Types.ObjectId }) => ({
        exec: async () => {
          db.delete(filter._id.toString());
          return { deletedCount: 1 };
        },
      })),
    };

    service = new FilesService(
      modelMock as unknown as ConstructorParameters<typeof FilesService>[0],
      storage,
    );
  });

  it('stores the file under its owner prefix and records the reference', async () => {
    const result = await service.upload(
      multerFile(),
      { ownerType: FileOwnerType.PARTY, ownerId },
      undefined,
    );

    expect(storage.objects.has(`party/${ownerId}/generated-1`)).toBe(true);
    expect(db.size).toBe(1);
    // Clients get our own reference, never the provider key.
    expect(result.url).toBe(`/files/${result.id}`);
    expect(result).not.toHaveProperty('key');
    expect(JSON.stringify(result)).not.toContain('generated-1');
  });

  it('rejects a request with no file attached', async () => {
    await expect(
      service.upload(undefined, { ownerType: FileOwnerType.PARTY, ownerId }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a disallowed content type before anything is stored', async () => {
    await expect(
      service.upload(multerFile({ mimetype: 'application/x-msdownload', originalname: 'setup.exe' }), {
        ownerType: FileOwnerType.PRODUCT,
        ownerId,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.objects.size).toBe(0);
    expect(db.size).toBe(0);
  });

  it('deletes the stored object and its reference together', async () => {
    const uploaded = await service.upload(multerFile(), {
      ownerType: FileOwnerType.PARTY,
      ownerId,
    });

    await expect(service.remove(uploaded.id)).resolves.toEqual({ success: true });

    expect(storage.deleteCalls).toEqual([`party/${ownerId}/generated-1`]);
    expect(storage.objects.size).toBe(0);
    expect(db.size).toBe(0);
  });

  it('leaves the reference in place if the object could not be removed', async () => {
    const uploaded = await service.upload(multerFile(), {
      ownerType: FileOwnerType.PARTY,
      ownerId,
    });
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('bucket unreachable'));

    await expect(service.remove(uploaded.id)).rejects.toThrow('bucket unreachable');

    // Row survives, so the object is still reachable for a retry rather than orphaned.
    expect(db.size).toBe(1);
  });

  it('streams the stored bytes back with the recorded metadata', async () => {
    const uploaded = await service.upload(multerFile({ buffer: Buffer.from('%PDF-bytes') }), {
      ownerType: FileOwnerType.PARTY,
      ownerId,
    });

    const download = await service.download(uploaded.id);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe('%PDF-bytes');
    expect(download.mimeType).toBe('application/pdf');
    expect(download.originalName).toBe('passport.pdf');
  });

  it('lets a storage quota error through unchanged so the client sees a 503, not a 500', async () => {
    const uploaded = await service.upload(multerFile(), { ownerType: FileOwnerType.PARTY, ownerId });
    vi.spyOn(storage, 'download').mockRejectedValueOnce(new StorageBandwidthQuotaExceededException(600, 'MEGA'));

    await expect(service.download(uploaded.id)).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: 600,
    });
  });

  it('removes the stored object if the reference row cannot be written', async () => {
    modelMock.create.mockRejectedValueOnce(new Error('mongo down'));

    await expect(
      service.upload(multerFile(), { ownerType: FileOwnerType.PARTY, ownerId }),
    ).rejects.toThrow('mongo down');

    expect(storage.objects.size).toBe(0);
  });

  it('404s for an unknown file id', async () => {
    await expect(service.remove(new Types.ObjectId().toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
