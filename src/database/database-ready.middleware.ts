import { Injectable, type NestMiddleware } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { NextFunction, Request, Response } from 'express';
import { ensureConnected } from './connection-status.js';

/** Just above serverSelectionTimeoutMS (10s), so one full attempt can finish inside the request. */
export const DATABASE_WAIT_MS = 12_000;

/** Paths that must answer without touching the database. /health manages its own wait. */
const SKIP_PATHS = new Set(['/', '/health', '/favicon.ico']);

/**
 * Reconnects MongoDB, if needed, while a request is in flight: the only time a
 * serverless instance is guaranteed to be running (see keepConnected). When
 * the database is already up this is a single readyState check.
 *
 * It never fails the request itself; if MongoDB is still unreachable the
 * handler's own query fails with the usual error.
 */
@Injectable()
export class DatabaseReadyMiddleware implements NestMiddleware {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
    // Not request.path: inside mounted middleware Express makes that relative
    // to the mount point, so every route would look like "/".
    const path = request.originalUrl.split('?')[0];
    if (!SKIP_PATHS.has(path)) {
      await ensureConnected(this.connection, DATABASE_WAIT_MS);
    }
    next();
  }
}
