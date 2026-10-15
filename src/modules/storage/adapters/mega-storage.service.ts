import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, type Readable } from 'node:stream';
import { Storage } from 'megajs';
import type { EnvConfig } from '../../../config/env.validation.js';
import { StorageService, type StoredFile, type StoredFileStream, type UploadableFile } from '../storage.service.js';
import { buildObjectKey } from '../object-key.util.js';
import { withRetry } from '../retry.util.js';
import {
  StorageBandwidthQuotaExceededException,
  StorageObjectNotFoundException,
  StorageSpaceQuotaExceededException,
  StorageUnavailableException,
} from '../storage.errors.js';
import { classifyMegaError, type MegaFailure, type MegaOperation } from './mega-errors.util.js';

type MegaNode = Storage['root'];
type ChunkRetryHandler = (tries: number, error: Error | null, cb: (error: Error | null) => void) => void;

const PROVIDER = 'MEGA';

/** Whole-operation retries for rate limits / congestion. Kept short: a caller's HTTP request is waiting. */
const RETRY = { attempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 } as const;

/**
 * Per-chunk retries inside megajs. Its default backs off up to 2^8 seconds per
 * chunk, far longer than an HTTP request can wait; failing the chunk lets the
 * operation-level retry (and its clear error mapping) take over instead.
 */
const chunkRetries: ChunkRetryHandler = (tries, error, cb) => {
  if (tries > 2 || classifyMegaError(error, 'download').kind === 'bandwidth-exhausted') {
    cb(error);
    return;
  }
  setTimeout(() => cb(null), 400 * 2 ** tries);
};

/**
 * MEGA via `megajs`. This is the only file permitted to import the MEGA SDK.
 *
 * MEGA encrypts client-side, so this adapter is also where decryption happens:
 * `download` yields plaintext that our own authenticated endpoint streams out.
 * No MEGA share link is ever created — a share link embeds the decryption key
 * and would make the file public to anyone holding the URL.
 *
 * The stored key is the MEGA node handle. It never leaves the server; API
 * clients only ever see our own FileAttachment id.
 */
@Injectable()
export class MegaStorageService extends StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MegaStorageService.name);
  private readonly email: string;
  private readonly password: string;
  private readonly folderName: string;

  private session?: Promise<Storage>;
  private folder?: Promise<MegaNode>;

  constructor(configService: ConfigService<EnvConfig, true>) {
    super();
    // Presence is guaranteed by the startup env validation for this driver.
    this.email = configService.get('MEGA_EMAIL', { infer: true })!;
    this.password = configService.get('MEGA_PASSWORD', { infer: true })!;
    this.folderName = configService.get('MEGA_FOLDER_NAME', { infer: true })!;
  }

  onModuleInit(): void {
    // Warm the session so the first upload doesn't pay for login + tree fetch.
    // Not awaited: MEGA being briefly unreachable shouldn't stop the API booting;
    // a bad credential still shows up loudly in the log right away.
    this.getFolder().then(
      () => this.logger.log(`Connected to MEGA; files go to folder "${this.folderName}"`),
      (error: unknown) => this.logger.error(`MEGA warm-up failed: ${describe(error)}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const storage = await this.session?.catch(() => undefined);
    await storage?.close();
  }

  async upload(file: UploadableFile, path: string): Promise<StoredFile> {
    // Flat inside the folder: avoids racing mkdir calls per owner, while the
    // name still reads as "<ownerType>__<ownerId>__<uuid>.<ext>" in the MEGA UI.
    const name = buildObjectKey(path, file.originalName).replaceAll('/', '__');

    const node = await this.run('upload', async () => {
      const folder = await this.getFolder();
      return new Promise<MegaNode>((resolve, reject) => {
        // `handleRetries` is supported by megajs at runtime but missing from its typings.
        const options = { name, size: file.size, handleRetries: chunkRetries } as { name: string; size: number };
        const upload = folder.upload(options, file.buffer) as ReturnType<Storage['upload']>;
        // Chunk failures are emitted as 'error' rather than rejecting `complete`;
        // an unhandled 'error' event would take the whole process down.
        upload.on('error', reject);
        upload.complete.then(resolve, reject);
      });
    });

    if (!node.nodeId) {
      throw new StorageUnavailableException('MEGA accepted the upload but returned no node handle');
    }

    return { key: node.nodeId, size: file.size, mimeType: file.mimeType };
  }

  async download(key: string): Promise<StoredFileStream> {
    return this.run('download', async () => {
      const node = await this.findNode(key);
      if (!node) throw new StorageObjectNotFoundException(key);

      const source = node.download({ handleRetries: chunkRetries }) as Readable;
      return { stream: await primeStream(source), size: node.size };
    });
  }

  async delete(key: string): Promise<void> {
    await this.run('delete', async () => {
      const node = await this.findNode(key);
      if (!node) {
        // Idempotent: a retried cleanup must still be able to drop the DB reference.
        this.logger.warn(`MEGA node ${key} was already absent`);
        return;
      }
      // Permanent, not the rubbish bin — same semantics as deleting from a bucket.
      try {
        await node.delete(true);
      } catch (error) {
        if (classifyMegaError(error, 'delete').kind !== 'not-found') throw error;
        this.logger.warn(`MEGA node ${key} disappeared before it could be deleted`);
      }
    });
  }

  /** Runs one MEGA operation with backoff, then maps whatever is left to a provider-neutral exception. */
  private async run<T>(operation: MegaOperation, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, {
        ...RETRY,
        shouldRetry: (error) => {
          const failure = classifyMegaError(error, operation);
          switch (failure.kind) {
            case 'rate-limited':
            case 'transient':
              return { retry: true };
            case 'session-expired':
              this.resetSession();
              return { retry: true };
            case 'bandwidth-exhausted':
              // Worth waiting only when MEGA says the window resets within our
              // backoff budget; otherwise withRetry rethrows and we fail fast.
              return failure.retryAfterSeconds
                ? { retry: true, delayMs: failure.retryAfterSeconds * 1000 }
                : { retry: false };
            default:
              return { retry: false };
          }
        },
        onRetry: (error, attempt, delayMs) =>
          this.logger.warn(`MEGA ${operation} attempt ${attempt} failed (${describe(error)}); retrying in ${delayMs}ms`),
      });
    } catch (error) {
      if (error instanceof StorageObjectNotFoundException || error instanceof StorageUnavailableException) {
        throw error;
      }
      throw this.toStorageException(classifyMegaError(error, operation), operation, error);
    }
  }

  private toStorageException(failure: MegaFailure, operation: MegaOperation, error: unknown): Error {
    switch (failure.kind) {
      case 'bandwidth-exhausted':
        this.logger.error(
          `MEGA transfer quota exhausted during ${operation}` +
            (failure.retryAfterSeconds ? `; resets in ${failure.retryAfterSeconds}s` : ''),
        );
        return new StorageBandwidthQuotaExceededException(failure.retryAfterSeconds, PROVIDER);
      case 'storage-full':
        this.logger.error(`MEGA account is out of storage space (${operation})`);
        return new StorageSpaceQuotaExceededException(PROVIDER);
      case 'rate-limited':
        return new StorageUnavailableException('MEGA is rate-limiting requests; try again shortly', 30);
      case 'transient':
      case 'session-expired':
        return new StorageUnavailableException(`MEGA did not respond successfully (${describe(error)})`, 15);
      case 'auth':
        this.logger.error(`MEGA login/access failed: ${failure.reason}`);
        return new StorageUnavailableException(`cannot authenticate with MEGA (${failure.reason})`);
      case 'not-found':
        return new StorageObjectNotFoundException('(MEGA node)');
      default:
        // Unknown vendor error: leave it as a 500, which the global filter logs with a stack.
        return error instanceof Error ? error : new Error(String(error));
    }
  }

  private getSession(): Promise<Storage> {
    this.session ??= new Storage({ email: this.email, password: this.password, keepalive: true }).ready.catch(
      (error: unknown) => {
        // Don't cache a failed login; the next call tries again.
        this.session = undefined;
        this.folder = undefined;
        throw this.toStorageException(classifyMegaError(error, 'login'), 'login', error);
      },
    );
    return this.session;
  }

  private getFolder(): Promise<MegaNode> {
    this.folder ??= (async () => {
      const storage = await this.getSession();
      const existing = storage.root.children?.find((node) => node.directory && node.name === this.folderName);
      return existing ?? storage.mkdir(this.folderName);
    })().catch((error: unknown) => {
      this.folder = undefined;
      throw error;
    });
    return this.folder;
  }

  /**
   * Resolves a node from the session's file tree. Another API instance may have
   * uploaded it after our tree was loaded, so a miss triggers one reload.
   */
  private async findNode(key: string): Promise<MegaNode | undefined> {
    const storage = await this.getSession();
    let node = storage.files[key];
    if (!node) {
      await storage.reload(true);
      node = storage.files[key];
    }
    return node && !node.directory ? node : undefined;
  }

  private resetSession(): void {
    const stale = this.session;
    this.session = undefined;
    this.folder = undefined;
    void stale?.then((storage) => storage.close()).catch(() => undefined);
  }
}

/**
 * Waits for the first chunk (or a clean end) before handing the stream to the
 * HTTP layer. MEGA reports bandwidth exhaustion as a stream error on the first
 * chunk fetch; catching it here means the client gets a 503 with a clear
 * message instead of a 200 with a truncated body.
 */
function primeStream(source: Readable): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    let primed = false;

    // Kept for the stream's whole life: megajs may emit more than one error and
    // an unhandled 'error' would crash the process.
    source.on('error', (error) => {
      if (primed) {
        output.destroy(error);
      } else {
        reject(error);
      }
      source.destroy();
    });

    source.once('data', (chunk: Buffer) => {
      primed = true;
      source.pause();
      output.write(chunk);
      source.pipe(output);
      resolve(output);
    });

    source.once('end', () => {
      if (primed) return;
      primed = true;
      output.end();
      resolve(output);
    });

    // Client went away mid-download: stop pulling chunks from MEGA (and burning quota).
    output.on('close', () => source.destroy());
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
