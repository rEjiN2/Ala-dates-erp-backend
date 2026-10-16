import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Readable } from 'node:stream';
import { StorageService } from '../storage/storage.service.js';
import {
  FileAttachment,
  FileAttachmentDocument,
  FileOwnerType,
} from './schemas/file-attachment.schema.js';
import { UploadFileDto } from './dto/upload-file.dto.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/**
 * What API clients get back. `id` is the reference to save against the owning
 * record; `url` is our own endpoint for it. The provider key is deliberately
 * absent so clients can never couple to (or reach) the storage backend.
 */
export interface StoredFileResponse {
  id: string;
  url: string;
  ownerType: FileOwnerType;
  ownerId: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface FileDownload {
  stream: Readable;
  originalName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class FilesService {
  constructor(
    @InjectModel(FileAttachment.name)
    private readonly fileAttachmentModel: Model<FileAttachmentDocument>,
    private readonly storageService: StorageService,
  ) {}

  async upload(
    file: Express.Multer.File | undefined,
    dto: UploadFileDto,
    uploadedBy?: string,
  ): Promise<StoredFileResponse> {
    if (!file) {
      throw new BadRequestException('A file is required under the "file" field');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    const stored = await this.storageService.upload(
      {
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
      `${dto.ownerType}/${dto.ownerId}`,
    );

    try {
      const attachment = await this.fileAttachmentModel.create({
        key: stored.key,
        ownerType: dto.ownerType,
        ownerId: new Types.ObjectId(dto.ownerId),
        originalName: file.originalname,
        mimeType: stored.mimeType,
        size: stored.size,
        uploadedBy: uploadedBy ? new Types.ObjectId(uploadedBy) : undefined,
      });
      return this.toResponse(attachment);
    } catch (error) {
      // No reference row means nothing could ever find or delete the object:
      // remove it now rather than leave it consuming quota forever.
      await this.storageService.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }

  async download(id: string): Promise<FileDownload> {
    const attachment = await this.getByIdOrThrow(id);
    const { stream, size } = await this.storageService.download(attachment.key);
    return {
      stream,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: size ?? attachment.size,
    };
  }

  /** Metadata only, without touching storage. */
  async describe(id: string): Promise<StoredFileResponse> {
    return this.toResponse(await this.getByIdOrThrow(id));
  }

  /** The whole file in memory, for embedding (e.g. a logo in a PDF). Keep to small files. */
  async readBuffer(id: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const file = await this.download(id);
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return { buffer: Buffer.concat(chunks), mimeType: file.mimeType };
  }

  async remove(id: string): Promise<{ success: true }> {
    const attachment = await this.getByIdOrThrow(id);

    // Object first, then the reference: if the second step fails we are left
    // with a dangling row that is visible and repairable, rather than an
    // orphaned object nothing points at any more.
    await this.storageService.delete(attachment.key);
    await this.fileAttachmentModel.deleteOne({ _id: attachment._id }).exec();

    return { success: true };
  }

  private async getByIdOrThrow(id: string): Promise<FileAttachmentDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`File id "${id}" is not a valid id`);
    }
    const attachment = await this.fileAttachmentModel.findById(id).exec();
    if (!attachment) {
      throw new NotFoundException(`File ${id} not found`);
    }
    return attachment;
  }

  private toResponse(attachment: FileAttachmentDocument): StoredFileResponse {
    return {
      id: attachment.id,
      url: `/files/${attachment.id}`,
      ownerType: attachment.ownerType,
      ownerId: attachment.ownerId.toString(),
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  }
}
