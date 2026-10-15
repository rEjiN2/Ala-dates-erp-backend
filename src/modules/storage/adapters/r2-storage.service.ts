import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EnvConfig } from '../../../config/env.validation.js';
import { StorageService, type StoredFile, type StoredFileStream, type UploadableFile } from '../storage.service.js';
import { buildObjectKey } from '../object-key.util.js';
import { StorageObjectNotFoundException } from '../storage.errors.js';

/**
 * Cloudflare R2 via the S3-compatible API. This is the only file permitted to
 * import the S3 SDK. Reads are streamed through our own endpoint like every
 * other adapter, so the bucket stays private and no signed URL is handed out.
 */
@Injectable()
export class R2StorageService extends StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    super();

    // Presence is guaranteed by the startup env validation for this driver.
    this.bucket = this.configService.get('R2_BUCKET', { infer: true })!;

    this.client = new S3Client({
      region: this.configService.get('R2_REGION', { infer: true }),
      endpoint: this.configService.get('R2_ENDPOINT', { infer: true })!,
      credentials: {
        accessKeyId: this.configService.get('R2_ACCESS_KEY_ID', { infer: true })!,
        secretAccessKey: this.configService.get('R2_SECRET_ACCESS_KEY', { infer: true })!,
      },
    });
  }

  async upload(file: UploadableFile, path: string): Promise<StoredFile> {
    const key = buildObjectKey(path, file.originalName);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimeType,
        ContentLength: file.size,
      }),
    );

    return { key, size: file.size, mimeType: file.mimeType };
  }

  async download(key: string): Promise<StoredFileStream> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { stream: object.Body as Readable, size: object.ContentLength };
    } catch (error) {
      if (this.isNotFound(error)) throw new StorageObjectNotFoundException(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // Deleting an object that is already gone must stay idempotent, otherwise
      // a retried cleanup would strand the database record it belongs to.
      if (this.isNotFound(error)) {
        this.logger.warn(`Object ${key} was already absent from the bucket`);
        return;
      }
      throw error;
    }
  }

  private isNotFound(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
  }
}
