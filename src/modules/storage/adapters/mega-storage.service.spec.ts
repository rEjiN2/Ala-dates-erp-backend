import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../../../config/env.validation.js';
import {
  StorageBandwidthQuotaExceededException,
  StorageSpaceQuotaExceededException,
  StorageUnavailableException,
} from '../storage.errors.js';

/** Minimal in-memory stand-in for the parts of megajs the adapter touches. */
const mega = vi.hoisted(() => {
  const state = {
    loginError: undefined as Error | undefined,
    uploadError: undefined as Error | undefined,
    /** Queue of per-call download behaviours; falls back to streaming the stored bytes. */
    downloadErrors: [] as Error[],
    downloadCalls: 0,
    files: {} as Record<string, FakeNode>,
    rootChildren: [] as FakeNode[],
    reloads: 0,
    nextId: 1,
  };

  class FakeNode {
    constructor(
      public nodeId: string,
      public name: string,
      public directory: boolean,
      public size?: number,
      public data?: Buffer,
    ) {}
    children: FakeNode[] = [];

    upload(opts: { name: string }, buffer: Buffer) {
      const stream = new EventEmitter() as EventEmitter & { complete: Promise<FakeNode> };
      stream.complete = new Promise((resolve, reject) => {
        queueMicrotask(() => {
          if (state.uploadError) return reject(state.uploadError);
          const node = new FakeNode(`node${state.nextId++}`, opts.name, false, buffer.length, buffer);
          this.children.push(node);
          state.files[node.nodeId] = node;
          resolve(node);
        });
      });
      return stream;
    }

    download() {
      state.downloadCalls++;
      const out = new PassThrough();
      const error = state.downloadErrors.shift();
      queueMicrotask(() => (error ? out.emit('error', error) : out.end(this.data)));
      return out;
    }

    async delete() {
      delete state.files[this.nodeId];
    }
  }

  class Storage {
    root = { children: state.rootChildren };
    files = state.files;
    ready: Promise<this>;
    constructor() {
      this.ready = state.loginError ? Promise.reject(state.loginError) : Promise.resolve(this);
    }
    async mkdir(name: string) {
      const folder = new FakeNode(`dir${state.nextId++}`, name, true);
      state.rootChildren.push(folder);
      state.files[folder.nodeId] = folder;
      return folder;
    }
    async reload() {
      state.reloads++;
    }
    async close() {}
  }

  return { state, Storage, FakeNode };
});

vi.mock('megajs', () => ({ Storage: mega.Storage }));

const { MegaStorageService } = await import('./mega-storage.service.js');

const env: Partial<EnvConfig> = {
  MEGA_EMAIL: 'erp@example.com',
  MEGA_PASSWORD: 'secret',
  MEGA_FOLDER_NAME: 'ala-dates-files',
};
const config = { get: (key: keyof EnvConfig) => env[key] } as unknown as ConfigService<EnvConfig, true>;

const pdf = { buffer: Buffer.from('%PDF-1.7 bytes'), originalName: 'trade-licence.pdf', mimeType: 'application/pdf', size: 14 };

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

describe('MegaStorageService', () => {
  beforeEach(() => {
    Object.assign(mega.state, {
      loginError: undefined,
      uploadError: undefined,
      downloadErrors: [],
      downloadCalls: 0,
      files: {},
      reloads: 0,
      nextId: 1,
    });
    mega.state.rootChildren.length = 0;
  });

  it('uploads into the configured folder, creating it once, and returns the node handle as key', async () => {
    const service = new MegaStorageService(config);

    const first = await service.upload(pdf, 'party/652f1c9e5b4a3d2e1f0a9b8c');
    await service.upload(pdf, 'party/652f1c9e5b4a3d2e1f0a9b8c');

    const folders = mega.state.rootChildren.filter((n) => n.directory && n.name === 'ala-dates-files');
    expect(folders).toHaveLength(1);
    expect(first).toEqual({ key: 'node2', size: 14, mimeType: 'application/pdf' });
    expect(mega.state.files.node2.name).toMatch(/^party__652f1c9e5b4a3d2e1f0a9b8c__[0-9a-f-]{36}\.pdf$/);
  });

  it('reuses an existing folder of the same name', async () => {
    const existing = new mega.FakeNode('dirX', 'ala-dates-files', true);
    mega.state.rootChildren.push(existing);

    await new MegaStorageService(config).upload(pdf, 'product/1');

    expect(existing.children).toHaveLength(1);
  });

  it('streams decrypted bytes back for a stored key', async () => {
    const service = new MegaStorageService(config);
    const { key } = await service.upload(pdf, 'party/1');

    const download = await service.download(key);

    expect(download.size).toBe(14);
    expect(await readAll(download.stream)).toBe('%PDF-1.7 bytes');
  });

  it('retries a rate-limited download and then succeeds', async () => {
    const service = new MegaStorageService(config);
    const { key } = await service.upload(pdf, 'party/1');
    mega.state.downloadErrors.push(new Error('ERATELIMIT (-4): You have exceeded your command weight'));

    const download = await service.download(key);

    expect(await readAll(download.stream)).toBe('%PDF-1.7 bytes');
    expect(mega.state.downloadCalls).toBe(2);
  });

  it('fails fast with a clear 503 when the bandwidth quota is exhausted', async () => {
    const service = new MegaStorageService(config);
    const { key } = await service.upload(pdf, 'party/1');
    mega.state.downloadErrors.push(new Error('Bandwidth limit reached: 1830 seconds until it resets'));

    const error = await service.download(key).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageBandwidthQuotaExceededException);
    expect(error).toMatchObject({ status: 503, retryAfterSeconds: 1830 });
    expect((error as Error).message).toContain('MEGA');
    // Not worth waiting half an hour inside an HTTP request.
    expect(mega.state.downloadCalls).toBe(1);
  });

  it('reports a full account as 507 on upload', async () => {
    mega.state.uploadError = new Error('EOVERQUOTA (-17): Request over quota');

    await expect(new MegaStorageService(config).upload(pdf, 'party/1')).rejects.toBeInstanceOf(
      StorageSpaceQuotaExceededException,
    );
  });

  it('surfaces bad credentials as a storage-unavailable error naming the env vars', async () => {
    mega.state.loginError = new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?');

    const error = await new MegaStorageService(config).upload(pdf, 'party/1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnavailableException);
    expect((error as Error).message).toContain('MEGA_EMAIL / MEGA_PASSWORD');
  });

  it('treats deleting an already-missing node as success after re-checking the tree', async () => {
    await expect(new MegaStorageService(config).delete('gone')).resolves.toBeUndefined();
    expect(mega.state.reloads).toBe(1);
  });

  it('permanently deletes a stored node', async () => {
    const service = new MegaStorageService(config);
    const { key } = await service.upload(pdf, 'party/1');

    await service.delete(key);

    expect(mega.state.files[key]).toBeUndefined();
  });
});
