import { Logger } from '@nestjs/common';
import type { Connection } from 'mongoose';

export type DatabaseState = 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown';

export interface DatabaseError {
  name: string;
  message: string;
  at: string;
}

const lastErrors = new WeakMap<Connection, DatabaseError>();
const logger = new Logger('MongoDB');

/**
 * Attached as MongooseModule's connectionFactory. With a lazy connection the
 * app boots without waiting for MongoDB, so a failed connect must be caught
 * here: mongoose only handles its initial-connection rejection when an 'error'
 * listener exists, and without one Node would crash on the unhandled rejection.
 * The failure is logged on one line and kept for /health to report.
 */
export function trackConnection(connection: Connection): Connection {
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

/** The useful part of a driver error, with any credentials in a connection string blanked out. */
function describeError(error: unknown): DatabaseError {
  const err = error instanceof Error ? error : new Error(String(error));
  // Server-selection errors hide the real reason (e.g. a TLS alert) in `cause` or per-server descriptions.
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error && !err.message.includes(cause.message) ? ` (cause: ${cause.message})` : '';
  return {
    name: err.name,
    message: redactCredentials(`${err.message}${detail}`),
    at: new Date().toISOString(),
  };
}

function redactCredentials(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@');
}
