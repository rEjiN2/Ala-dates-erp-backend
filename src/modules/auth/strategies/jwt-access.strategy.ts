import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { UsersService } from '../../users/users.service.js';
import { isUserActive } from '../../users/schemas/user.schema.js';
import type { EnvConfig } from '../../../config/env.validation.js';
import type { JwtAccessPayload, AuthenticatedUser } from '../interfaces/auth.types.js';

function extractFromCookie(request: Request): string | null {
  return request?.cookies?.access_token ?? null;
}

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: extractFromCookie,
      secretOrKey: configService.get('JWT_ACCESS_SECRET', { infer: true }),
      ignoreExpiration: false,
    });
  }

  /**
   * The user is reloaded on every request: role, permissions, data scope and
   * status come from the database, never from the token, so deactivating a
   * user or changing their role applies on their next request.
   */
  async validate(payload: JwtAccessPayload): Promise<AuthenticatedUser> {
    if (payload.tokenType !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.usersService.findByIdWithRole(payload.sub);
    if (!user || !isUserActive(user)) {
      throw new UnauthorizedException('User no longer active');
    }
    return this.usersService.toAuthenticatedUser(user);
  }
}
