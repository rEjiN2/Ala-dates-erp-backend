/**
 * megajs surfaces failures as plain `Error`s whose message carries the MEGA API
 * code ("EOVERQUOTA (-17): ...") or an HTTP status from the transfer servers
 * ("Bandwidth limit reached: 1234 seconds until it resets"). This turns those
 * strings into something the adapter can make retry/mapping decisions on.
 */

export type MegaOperation = 'login' | 'upload' | 'download' | 'delete' | 'lookup';

export type MegaFailure =
  | { kind: 'rate-limited' }
  | { kind: 'transient' }
  | { kind: 'session-expired' }
  | { kind: 'bandwidth-exhausted'; retryAfterSeconds?: number }
  | { kind: 'storage-full' }
  | { kind: 'not-found' }
  | { kind: 'auth'; reason: string }
  | { kind: 'unknown' };

const API_CODE = /^E[A-Z]+ \((-\d+)\)/;
const BANDWIDTH = /Bandwidth limit reached: (\d+)/i;
const HTTP_STATUS = /MEGA returned a (\d{3}) status code/;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function classifyMegaError(error: unknown, operation: MegaOperation): MegaFailure {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;

  const bandwidth = BANDWIDTH.exec(message);
  if (bandwidth) {
    return { kind: 'bandwidth-exhausted', retryAfterSeconds: Number(bandwidth[1]) || undefined };
  }

  const apiCode = API_CODE.exec(message);
  if (apiCode) {
    switch (Number(apiCode[1])) {
      case -3: // EAGAIN: congestion, already retried inside megajs
      case -6: // ETOOMANY
      case -18: // ETEMPUNAVAIL
      case -19: // ETOOMANYCONNECTIONS
        return { kind: 'transient' };
      case -4: // ERATELIMIT
        return { kind: 'rate-limited' };
      case -15: // ESID
        return { kind: 'session-expired' };
      case -17: // EOVERQUOTA: on a download request this is the transfer quota
        return operation === 'download' ? { kind: 'bandwidth-exhausted' } : { kind: 'storage-full' };
      case -24: // EGOINGOVERQUOTA
      case -401: // ESHAREROVERQUOTA
        return { kind: 'storage-full' };
      case -9: // ENOENT: on login this is MEGA's "wrong email/password"
        return operation === 'login'
          ? { kind: 'auth', reason: 'MEGA rejected MEGA_EMAIL / MEGA_PASSWORD' }
          : { kind: 'not-found' };
      case -26: // EMFAREQUIRED
        return {
          kind: 'auth',
          reason: 'the MEGA account has two-factor authentication enabled, which unattended login cannot satisfy',
        };
      case -16: // EBLOCKED
        return { kind: 'auth', reason: 'the MEGA account is blocked' };
      case -11: // EACCESS
        return { kind: 'auth', reason: 'the MEGA account lacks access to this node' };
      default:
        return { kind: 'unknown' };
    }
  }

  const status = HTTP_STATUS.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code === 509) return { kind: 'bandwidth-exhausted' };
    if (code === 429) return { kind: 'rate-limited' };
    if (code >= 500) return { kind: 'transient' };
    return { kind: 'unknown' };
  }

  if (/maybe caused by rate limit/i.test(message)) {
    return { kind: 'rate-limited' };
  }

  if (
    NETWORK_CODES.has(String(errorCode)) ||
    NETWORK_CODES.has(String(causeCode)) ||
    /fetch failed|socket hang up|network/i.test(message)
  ) {
    return { kind: 'transient' };
  }

  return { kind: 'unknown' };
}
