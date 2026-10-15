import { setImmediate as nextTick } from 'node:timers/promises';
import { Controller, Get, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Response } from 'express';
import {
  databaseState,
  lastDatabaseError,
  type DatabaseError,
  type DatabaseState,
} from '../database/connection-status.js';

/**
 * How long /health waits for a connection attempt that has not finished yet.
 * Just above serverSelectionTimeoutMS (10s), so the first request after a cold
 * start reports the real outcome rather than a bare "disconnected".
 */
const CONNECT_WAIT_MS = 12_000;

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
 * 500. Returns 503 while the database is down, for uptime monitors.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    if (databaseState(this.connection) !== 'connected' && !lastDatabaseError(this.connection)) {
      await this.waitForConnection();
    }

    const state = databaseState(this.connection);
    const error = state === 'connected' ? undefined : lastDatabaseError(this.connection);
    const healthy = state === 'connected';
    response.status(healthy ? 200 : 503);

    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      node: process.version,
      database: error ? { state, error } : { state },
    };
  }

  private async waitForConnection(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CONNECT_WAIT_MS);
    });
    try {
      // The failure itself is recorded by keepConnected; only the outcome matters here.
      await Promise.race([this.connection.asPromise().then(() => undefined), timeout]);
    } catch {
      // Reported through databaseState/lastDatabaseError below.
    } finally {
      clearTimeout(timer);
    }
    // Mongoose rejects first and emits 'error' on the next tick; wait for it
    // so keepConnected has recorded the reason before we report.
    await nextTick();
  }
}
