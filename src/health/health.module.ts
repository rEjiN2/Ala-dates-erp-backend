import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { RootController } from './root.controller.js';

@Module({ controllers: [RootController, HealthController] })
export class HealthModule {}
