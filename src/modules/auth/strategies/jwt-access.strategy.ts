import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { UsersService } from '../../users/users.service.js';
import type { EnvConfig } from '../../../config/env.validation.js';
import type { JwtAccessPayload, AuthenticatedUser } from '../interfaces/auth.types.js';
import type { RoleDocument } from '../../roles/schemas/role.schema.js';

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

  async validate(payload: JwtAccessPayload): Promise<AuthenticatedUser> {
    if (payload.tokenType !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.usersService.findByIdWithRole(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer active');
    }

    const role = user.role as RoleDocument;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: { id: role.id, name: role.name },
      permissions: role.permissions,
    };
  }
}
