import { Logger } from '@nestjs/common';
import type { ConnectOptions, Connection } from 'mongoose';

export type DatabaseState = 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown';

export interface DatabaseError {
  name: string;
  message: string;
  at: string;
}

const lastErrors = new WeakMap<Connection, DatabaseError>();
const logger = new Logger('MongoDB');

/** Backoff between attempts to (re)open a connection whose last attempt failed. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/**
 * Builds MongooseModule's connectionFactory. With a lazy connection the app
 * boots without waiting for MongoDB, which leaves three jobs to this hook:
 *  - catch connection failures: mongoose only handles a failed connect when an
 *    'error' listener exists; without one Node crashes on the rejection;
 *  - keep trying: mongoose never retries a failed *initial* connect, so one bad
 *    attempt (common on a serverless cold start) would otherwise leave the
 *    instance disconnected until the host recycles it. Once connected, the
 *    driver handles reconnects itself;
 *  - remember the last failure for GET /health, and log it on one line.
 */
export function keepConnected(uri: string, options: ConnectOptions) {
  return (connection: Connection): Connection => {
    let retryDelay = RETRY_MIN_MS;
    let retryTimer: NodeJS.Timeout | undefined;

    const scheduleRetry = () => {
      if (retryTimer || connection.readyState !== 0) {
        return;
      }
      logger.warn(`Retrying in ${retryDelay / 1000}s`);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        // A failure re-emits 'error', which schedules the next attempt.
        connection.openUri(uri, options).catch(() => undefined);
      }, retryDelay);
      // Never keep the process alive just to retry.
      retryTimer.unref();
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    };

    connection.on('error', (error: unknown) => {
      const recorded = describeError(error);
      lastErrors.set(connection, recorded);
      logger.error(`Connection failed: ${recorded.name}: ${recorded.message}`);
      scheduleRetry();
    });
    connection.on('connected', () => {
      lastErrors.delete(connection);
      retryDelay = RETRY_MIN_MS;
      logger.log(`Connected to ${connection.host}/${connection.name}`);
    });
    return connection;
  };
}

export function databaseState(connection: Connection): DatabaseState {
  const states: Record<number, DatabaseState> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[connection.readyState] ?? 'unknown';
}

export function lastDatabaseError(connection: Connection): DatabaseError | undefined {
  return lastErrors.get(connection);
}

interface ServerSelectionReason {
  servers?: Map<string, { error?: unknown }>;
}

/** The useful part of a driver error, with any credentials in a connection string blanked out. */
function describeError(error: unknown): DatabaseError {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    name: err.name,
    message: redactCredentials([err.message, ...underlyingReasons(err)].join(' | ')),
    at: new Date().toISOString(),
  };
}

/**
 * "Server selection timed out" only summarises; the real reason (a TLS alert,
 * a refused or reset socket, bad auth) sits on each server's description in
 * `reason`, or in `cause`. Collect the distinct ones.
 */
function underlyingReasons(err: Error): string[] {
  const reasons = new Set<string>();
  const add = (text: string) => {
    if (text && !err.message.includes(text)) reasons.add(text);
  };

  const servers = (err as { reason?: ServerSelectionReason }).reason?.servers;
  for (const [host, description] of servers ?? []) {
    const serverError = description.error;
    if (serverError instanceof Error) {
      const cause = (serverError as { cause?: unknown }).cause;
      const causeText = cause instanceof Error && !serverError.message.includes(cause.message) ? ` (${cause.message})` : '';
      add(`${host}: ${serverError.message}${causeText}`);
    }
  }

  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) add(`cause: ${cause.message}`);

  return [...reasons].slice(0, 3);
}

function redactCredentials(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@');
}
