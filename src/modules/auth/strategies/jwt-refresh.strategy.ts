import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import type { EnvConfig } from '../../../config/env.validation.js';
import type { JwtRefreshPayload } from '../interfaces/auth.types.js';

export interface RefreshTokenContext {
  userId: string;
  refreshToken: string;
}

function extractFromCookie(request: Request): string | null {
  return request?.cookies?.refresh_token ?? null;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(configService: ConfigService<EnvConfig, true>) {
    super({
      jwtFromRequest: extractFromCookie,
      secretOrKey: configService.get('JWT_REFRESH_SECRET', { infer: true }),
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  validate(request: Request, payload: JwtRefreshPayload): RefreshTokenContext {
    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }
    return { userId: payload.sub, refreshToken: request.cookies?.refresh_token as string };
  }
}
