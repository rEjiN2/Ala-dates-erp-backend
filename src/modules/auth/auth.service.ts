import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service.js';
import { isUserActive } from '../users/schemas/user.schema.js';
import type { EnvConfig } from '../../config/env.validation.js';
import type { AuthenticatedUser, JwtAccessPayload, JwtRefreshPayload } from './interfaces/auth.types.js';
import type { UserDocument } from '../users/schemas/user.schema.js';
import type { RoleDocument } from '../roles/schemas/role.schema.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<EnvConfig, true>,
  ) {}

  async validateCredentials(email: string, password: string): Promise<UserDocument> {
    const user = await this.usersService.findByEmailWithCredentials(email);
    if (!user || !isUserActive(user)) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return user;
  }

  async issueTokens(user: UserDocument): Promise<AuthTokens> {
    const role = user.role as RoleDocument;

    const accessPayload: JwtAccessPayload = {
      sub: user.id,
      tokenType: 'access',
      email: user.email,
      roleId: role.id,
      roleName: role.name,
      permissions: role.permissions,
    };
    const accessToken = this.jwtService.sign(accessPayload, {
      secret: this.configService.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRES_IN', { infer: true }),
    });

    const refreshPayload: JwtRefreshPayload = { sub: user.id, tokenType: 'refresh' };
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', { infer: true }),
    });

    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await this.usersService.setRefreshTokenHash(user.id, refreshTokenHash);

    return { accessToken, refreshToken };
  }

  async rotateRefreshToken(userId: string, presentedRefreshToken: string): Promise<AuthTokens> {
    const user = await this.usersService.findByIdWithRefreshHash(userId);
    if (!user || !isUserActive(user) || !user.refreshTokenHash) {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    const isValid = await bcrypt.compare(presentedRefreshToken, user.refreshTokenHash);
    if (!isValid) {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    return this.issueTokens(user);
  }

  /** The user with their role, for issuing tokens after a password change. */
  async reloadForTokens(userId: string): Promise<UserDocument> {
    const user = await this.usersService.findByIdWithRole(userId);
    if (!user || !isUserActive(user)) {
      throw new UnauthorizedException('User no longer active');
    }
    return user;
  }

  async logout(userId: string): Promise<void> {
    await this.usersService.setRefreshTokenHash(userId, null);
  }

  toAuthenticatedUser(user: UserDocument): AuthenticatedUser {
    return this.usersService.toAuthenticatedUser(user);
  }
}
