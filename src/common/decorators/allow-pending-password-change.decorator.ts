import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allow_pending_password_change';

/**
 * Lets a user who must change their password still reach this route
 * (JwtAuthGuard refuses every other one with 403 until they do).
 */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
