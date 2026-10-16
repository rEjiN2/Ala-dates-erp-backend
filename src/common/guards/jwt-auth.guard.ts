import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../decorators/allow-pending-password-change.decorator.js';
import type { AuthenticatedUser } from '../../modules/auth/interfaces/auth.types.js';

export const PASSWORD_CHANGE_REQUIRED_MESSAGE = 'You must change your password before continuing';

/**
 * Verifies the access token (JwtAccessStrategy reloads the user, so an
 * inactive user is refused on their next request). A user flagged
 * mustChangePassword only reaches routes marked @AllowPendingPasswordChange().
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    const authenticated = super.handleRequest(err, user, info, context, status) as TUser & AuthenticatedUser;
    if (authenticated.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new ForbiddenException(PASSWORD_CHANGE_REQUIRED_MESSAGE);
      }
    }
    return authenticated;
  }
}
