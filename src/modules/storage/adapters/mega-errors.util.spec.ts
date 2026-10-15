import { describe, expect, it } from 'vitest';
import { classifyMegaError } from './mega-errors.util.js';

// Messages below are the exact strings megajs 1.3.x produces.
describe('classifyMegaError', () => {
  it('reads the reset window off a transfer-server bandwidth error', () => {
    const error = Object.assign(new Error('Bandwidth limit reached: 1830 seconds until it resets'), {
      timeLimit: '1830',
    });
    expect(classifyMegaError(error, 'download')).toEqual({
      kind: 'bandwidth-exhausted',
      retryAfterSeconds: 1830,
    });
  });

  it('treats EOVERQUOTA as the transfer quota on download but the storage quota on upload', () => {
    const error = new Error('EOVERQUOTA (-17): Request over quota');
    expect(classifyMegaError(error, 'download')).toEqual({ kind: 'bandwidth-exhausted' });
    expect(classifyMegaError(error, 'upload')).toEqual({ kind: 'storage-full' });
  });

  it('marks rate limiting and congestion as retryable', () => {
    expect(classifyMegaError(new Error('ERATELIMIT (-4): You have exceeded...'), 'upload').kind).toBe(
      'rate-limited',
    );
    expect(classifyMegaError(new Error('EAGAIN (-3): A temporary congestion...'), 'upload').kind).toBe(
      'transient',
    );
    expect(
      classifyMegaError(new Error('MEGA servers returned an invalid response, maybe caused by rate limit'), 'download')
        .kind,
    ).toBe('rate-limited');
    expect(classifyMegaError(new Error('MEGA returned a 503 status code'), 'upload').kind).toBe('transient');
    expect(classifyMegaError(new Error('MEGA returned a 509 status code'), 'download').kind).toBe(
      'bandwidth-exhausted',
    );
  });

  it('distinguishes a bad login from a missing node', () => {
    const error = new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?');
    expect(classifyMegaError(error, 'login').kind).toBe('auth');
    expect(classifyMegaError(error, 'delete').kind).toBe('not-found');
  });

  it('flags 2FA-protected accounts explicitly', () => {
    const failure = classifyMegaError(new Error('EMFAREQUIRED (-26): Multi-Factor Authentication Required'), 'login');
    expect(failure).toMatchObject({ kind: 'auth' });
  });

  it('recognises an expired session', () => {
    expect(classifyMegaError(new Error('ESID (-15): Invalid or expired user session'), 'download').kind).toBe(
      'session-expired',
    );
  });

  it('treats socket-level failures as transient', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(classifyMegaError(error, 'upload').kind).toBe('transient');
  });

  it('leaves anything else unclassified', () => {
    expect(classifyMegaError(new Error('something odd'), 'upload').kind).toBe('unknown');
  });
});
