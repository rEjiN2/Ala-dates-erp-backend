import { IsEnum, IsMongoId } from 'class-validator';
import { FileOwnerType } from '../schemas/file-attachment.schema.js';

export class UploadFileDto {
  @IsEnum(FileOwnerType)
  ownerType: FileOwnerType;

  @IsMongoId()
  ownerId: string;
}
