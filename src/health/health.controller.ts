import { Controller, Get, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Response } from 'express';
import {
  databaseState,
  ensureConnected,
  lastDatabaseError,
  type DatabaseError,
  type DatabaseState,
} from '../database/connection-status.js';
import { DATABASE_WAIT_MS } from '../database/database-ready.middleware.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  node: string;
  database: { state: DatabaseState; error?: DatabaseError };
}

/**
 * Answers even when MongoDB is unreachable (the connection is lazy), so a
 * broken deployment explains itself here instead of failing with an opaque
 * 500. If the database is down it makes a fresh connection attempt within
 * this request, so the error reported is from now, not from a stale attempt.
 * Returns 503 while the database is down, for uptime monitors.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    await ensureConnected(this.connection, DATABASE_WAIT_MS);

    const state = databaseState(this.connection);
    const healthy = state === 'connected';
    const error = healthy ? undefined : lastDatabaseError(this.connection);
    response.status(healthy ? 200 : 503);

    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      node: process.version,
      database: error ? { state, error } : { state },
    };
  }
}
