import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Provider-neutral storage failures. Adapters translate their vendor errors
 * into these so callers and clients see one consistent, diagnosable shape.
 */

/** The object behind a stored key no longer exists at the provider. */
export class StorageObjectNotFoundException extends HttpException {
  constructor(key: string) {
    super(`Stored file content for "${key}" was not found at the storage provider`, HttpStatus.NOT_FOUND);
    this.name = 'StorageObjectNotFoundException';
  }
}

/**
 * The provider's transfer (bandwidth) quota is exhausted. This is an account
 * limit, not a bug: it clears on its own after `retryAfterSeconds`.
 */
export class StorageBandwidthQuotaExceededException extends HttpException {
  constructor(
    readonly retryAfterSeconds?: number,
    provider = 'storage provider',
  ) {
    const wait = retryAfterSeconds ? ` It resets in about ${retryAfterSeconds} seconds.` : '';
    super(
      `File transfer quota for the ${provider} account is exhausted.${wait}`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'StorageBandwidthQuotaExceededException';
  }
}

/** The provider account has no storage space left for new uploads. */
export class StorageSpaceQuotaExceededException extends HttpException {
  constructor(provider = 'storage provider') {
    super(`The ${provider} account is out of storage space`, HttpStatus.INSUFFICIENT_STORAGE);
    this.name = 'StorageSpaceQuotaExceededException';
  }
}

/** The provider is unreachable, rate-limiting us beyond our retries, or rejecting our credentials. */
export class StorageUnavailableException extends HttpException {
  constructor(
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`File storage is temporarily unavailable: ${detail}`, HttpStatus.SERVICE_UNAVAILABLE);
    this.name = 'StorageUnavailableException';
  }
}
