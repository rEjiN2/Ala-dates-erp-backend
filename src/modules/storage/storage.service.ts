import type { Readable } from 'node:stream';

export interface UploadableFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

/**
 * What an adapter hands back after storing a file. `key` is opaque and
 * adapter-owned (an object path for R2, a node handle for MEGA): it is
 * persisted server-side only and never sent to API clients.
 */
export interface StoredFile {
  key: string;
  size: number;
  mimeType: string;
}

/** Plaintext bytes of a stored file, ready to pipe into an HTTP response. */
export interface StoredFileStream {
  stream: Readable;
  /** Byte length, when the provider knows it up front. */
  size?: number;
}

/**
 * Provider-agnostic storage contract. Consumers inject this abstract class as
 * the DI token and never reference a concrete adapter or vendor SDK, so
 * swapping providers is a change to StorageModule's factory plus STORAGE_DRIVER.
 *
 * Files are private by default: there is no "public URL" here. Reads always go
 * through our own authenticated endpoint, which calls `download` and streams the
 * bytes back, so the access model is identical whichever provider is behind it.
 *
 * Failures are raised as the exceptions in storage.errors.ts, never as raw
 * vendor errors, so callers can handle quota/not-found without knowing the
 * provider.
 */
export abstract class StorageService {
  /** Stores the file under `path` (a logical prefix) and returns its generated key. */
  abstract upload(file: UploadableFile, path: string): Promise<StoredFile>;

  /**
   * Opens a read stream of the file's (decrypted, where applicable) bytes.
   * Resolves only once the provider has started delivering data, so quota and
   * not-found errors surface as a proper HTTP status rather than a truncated body.
   */
  abstract download(key: string): Promise<StoredFileStream>;

  /** Removes the object. Must not throw if the object is already gone. */
  abstract delete(key: string): Promise<void>;
}
