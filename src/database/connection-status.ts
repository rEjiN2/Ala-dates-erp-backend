import { setImmediate as nextTick } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import type { ConnectOptions, Connection } from 'mongoose';

export type DatabaseState = 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown';

export interface DatabaseError {
  name: string;
  message: string;
  at: string;
}

const lastErrors = new WeakMap<Connection, DatabaseError>();
const reopeners = new WeakMap<Connection, () => Promise<unknown>>();
const pendingAttempts = new WeakMap<Connection, Promise<void>>();
const logger = new Logger('MongoDB');

/**
 * Builds MongooseModule's connectionFactory. With a lazy connection the app
 * boots without waiting for MongoDB. This hook catches connection failures
 * (mongoose only handles a failed connect when an 'error' listener exists;
 * without one Node crashes on the rejection), logs them on one line, keeps the
 * last one for GET /health, and registers how to reopen the connection.
 *
 * Reopening is deliberately NOT done on a background timer: on Vercel the
 * instance is frozen between requests, so background work stalls and then
 * "times out" the moment the next request thaws it. ensureConnected() reopens
 * during a request instead, while the instance is guaranteed to be running.
 */
export function keepConnected(uri: string, options: ConnectOptions) {
  return (connection: Connection): Connection => {
    reopeners.set(connection, () => connection.openUri(uri, options));

    connection.on('error', (error: unknown) => {
      const recorded = describeError(error);
      lastErrors.set(connection, recorded);
      logger.error(`Connection failed: ${recorded.name}: ${recorded.message}`);
    });
    connection.on('connected', () => {
      lastErrors.delete(connection);
      logger.log(`Connected to ${connection.host}/${connection.name}`);
    });
    return connection;
  };
}

/**
 * Makes sure the connection is up, waiting at most `timeoutMs`. If it is
 * disconnected (mongoose never retries a failed first connect), a new attempt
 * is started; concurrent callers share one attempt. Never throws: the outcome
 * is read back through databaseState()/lastDatabaseError().
 */
export async function ensureConnected(connection: Connection, timeoutMs: number): Promise<void> {
  if (connection.readyState === 1) {
    return;
  }

  let attempt = pendingAttempts.get(connection);
  if (!attempt) {
    const reopen = reopeners.get(connection);
    const started =
      connection.readyState === 0 && reopen ? reopen() : connection.asPromise();
    attempt = started
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => pendingAttempts.delete(connection));
    pendingAttempts.set(connection, attempt);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
  // Mongoose rejects first and emits 'error' on the next tick; let the
  // listener record the reason before the caller reads it.
  await nextTick();
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
