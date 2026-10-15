import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.util.js';

const base = { attempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 };

describe('withRetry', () => {
  it('retries retryable failures with backoff until one succeeds', async () => {
    const waits: number[] = [];
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      ...base,
      shouldRetry: () => ({ retry: true }),
      wait: async (ms) => waits.push(ms),
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThanOrEqual(200);
  });

  it('does not retry a failure the classifier rejects', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));

    await expect(
      withRetry(fn, { ...base, shouldRetry: () => ({ retry: false }), wait: async () => undefined }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still busy'));

    await expect(
      withRetry(fn, { ...base, shouldRetry: () => ({ retry: true }), wait: async () => undefined }),
    ).rejects.toThrow('still busy');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('honours a provider-requested delay that fits the budget', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new Error('wait 1s')).mockResolvedValue('ok');

    await withRetry(fn, {
      ...base,
      shouldRetry: () => ({ retry: true, delayMs: 900 }),
      wait: async (ms) => waits.push(ms),
    });

    expect(waits).toEqual([900]);
  });

  it('fails fast instead of blocking when the provider asks for a wait longer than the budget', async () => {
    const wait = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('quota resets in 1h'));

    await expect(
      withRetry(fn, { ...base, shouldRetry: () => ({ retry: true, delayMs: 3_600_000 }), wait }),
    ).rejects.toThrow('quota resets in 1h');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
