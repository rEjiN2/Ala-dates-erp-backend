import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../../config/env.validation.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileAttachment, FileAttachmentSchema } from './schemas/file-attachment.schema.js';
import { FilesService } from './files.service.js';
import { FilesController } from './files.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: FileAttachment.name, schema: FileAttachmentSchema }]),
    StorageModule,
    // Multer defaults to in-memory storage; the cap is enforced here so an
    // oversized upload is rejected while streaming rather than after buffering.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig, true>) => ({
        limits: {
          fileSize: configService.get('STORAGE_MAX_FILE_SIZE_MB', { infer: true }) * 1024 * 1024,
          files: 1,
        },
      }),
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService],
  // MulterModule is re-exported so other modules' upload routes (e.g. party
  // documents) get the same size cap through FileInterceptor.
  exports: [FilesService, MulterModule],
})
export class FilesModule {}
