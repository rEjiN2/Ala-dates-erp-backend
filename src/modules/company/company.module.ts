import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CompanySettings, CompanySettingsSchema } from './schemas/company-settings.schema.js';
import { CompanyService } from './company.service.js';
import { CompanyController } from './company.controller.js';
import { FilesModule } from '../files/files.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CompanySettings.name, schema: CompanySettingsSchema }]),
    FilesModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
