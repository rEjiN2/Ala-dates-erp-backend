import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum FileOwnerType {
  PARTY = 'party',
  SUPPLIER = 'supplier',
  PRODUCT = 'product',
  BUNDLE = 'bundle',
  OTHER = 'other',
}

export type FileAttachmentDocument = HydratedDocument<FileAttachment>;

/**
 * The reference that ties a stored object to the record that owns it. Deleting
 * this row and the object together is what keeps the bucket free of orphans.
 *
 * The readable URL is deliberately not persisted: with a private bucket it is a
 * short-lived signed URL, so it is always derived from the key on read.
 */
@Schema({ timestamps: true, collection: 'file_attachments' })
export class FileAttachment {
  @Prop({ required: true, unique: true, trim: true })
  key: string;

  @Prop({ type: String, required: true, enum: FileOwnerType, index: true })
  ownerType: FileOwnerType;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  originalName: string;

  @Prop({ required: true, trim: true })
  mimeType: string;

  @Prop({ required: true })
  size: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  uploadedBy?: Types.ObjectId;
}

export const FileAttachmentSchema = SchemaFactory.createForClass(FileAttachment);
FileAttachmentSchema.index({ ownerType: 1, ownerId: 1 });
