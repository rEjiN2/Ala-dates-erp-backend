import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryDecision {
  retry: boolean;
  /** Provider-supplied wait (e.g. "resets in N seconds"); overrides the computed backoff. */
  delayMs?: number;
}

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown, attempt: number) => RetryDecision;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * Exponential backoff with full jitter. A provider-requested delay longer than
 * `maxDelayMs` is not waited out: blocking an HTTP request for minutes is worse
 * than failing fast with a clear error, so the last error is rethrown instead.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const wait = options.wait ?? sleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.attempts) throw error;

      const decision = options.shouldRetry(error, attempt);
      if (!decision.retry) throw error;

      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = decision.delayMs ?? Math.round(backoff / 2 + (Math.random() * backoff) / 2);
      if (delayMs > options.maxDelayMs) throw error;

      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs);
    }
  }
}
