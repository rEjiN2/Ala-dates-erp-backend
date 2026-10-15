import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../../config/env.validation.js';
import { StorageService } from './storage.service.js';
import { R2StorageService } from './adapters/r2-storage.service.js';
import { MegaStorageService } from './adapters/mega-storage.service.js';

/**
 * The single place a provider is chosen. Adding Supabase/Spaces/Backblaze means
 * one new adapter class, its env keys in env.validation.ts, and one more case
 * here — no caller or endpoint changes.
 */
const storageProvider: Provider = {
  provide: StorageService,
  inject: [ConfigService],
  useFactory: (configService: ConfigService<EnvConfig, true>): StorageService => {
    const driver = configService.get('STORAGE_DRIVER', { infer: true });

    switch (driver) {
      case 'r2':
        return new R2StorageService(configService);
      case 'mega':
        return new MegaStorageService(configService);
      default:
        throw new Error(`Unsupported STORAGE_DRIVER "${driver as string}"`);
    }
  },
};

@Module({
  providers: [storageProvider],
  exports: [StorageService],
})
export class StorageModule {}
