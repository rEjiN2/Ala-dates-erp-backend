import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService, type AuthTokens } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { ChangePasswordDto } from '../users/dto/user.dto.js';
import { UserManagementService } from '../users/user-management.service.js';
import { AllowPendingPasswordChange } from '../../common/decorators/allow-pending-password-change.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { JwtRefreshGuard } from '../../common/guards/jwt-refresh.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser, AuthProfile } from './interfaces/auth.types.js';
import type { RefreshTokenContext } from './strategies/jwt-refresh.strategy.js';
import type { EnvConfig } from '../../config/env.validation.js';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly userManagement: UserManagementService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthProfile> {
    const user = await this.authService.validateCredentials(loginDto.email, loginDto.password);
    const tokens = await this.authService.issueTokens(user);
    this.setAuthCookies(response, tokens);
    // mustChangePassword: true here means the client must show the password change first.
    return this.userManagement.profile(user.id as string);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    const { userId, refreshToken } = request.user as unknown as RefreshTokenContext;
    const tokens = await this.authService.rotateRefreshToken(userId, refreshToken);
    this.setAuthCookies(response, tokens);
    return { success: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowPendingPasswordChange()
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    await this.authService.logout(user.id);
    this.clearAuthCookies(response);
    return { success: true };
  }

  /** The user, role, permissions, data scope, linked cashier and allowed cash accounts. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @AllowPendingPasswordChange()
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthProfile> {
    return this.userManagement.profile(user.id);
  }

  /** The caller's own password. Required after first login or an admin reset; new tokens are issued. */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @AllowPendingPasswordChange()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthProfile> {
    await this.userManagement.changeOwnPassword(user, dto);
    const reloaded = await this.authService.reloadForTokens(user.id);
    this.setAuthCookies(response, await this.authService.issueTokens(reloaded));
    return this.userManagement.profile(user.id);
  }

  private setAuthCookies(response: Response, tokens: AuthTokens): void {
    const isProduction = this.configService.get('NODE_ENV', { infer: true }) === 'production';
    const sameSite = this.configService.get('COOKIE_SAME_SITE', { infer: true });
    const secure = isProduction || sameSite === 'none';
    const domain = this.configService.get('COOKIE_DOMAIN', { infer: true });
    const cookieOptions = { httpOnly: true, secure, sameSite, domain, path: '/' } as const;

    response.cookie(ACCESS_COOKIE, tokens.accessToken, cookieOptions);
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions);
  }

  private clearAuthCookies(response: Response): void {
    const domain = this.configService.get('COOKIE_DOMAIN', { infer: true });
    response.clearCookie(ACCESS_COOKIE, { path: '/', domain });
    response.clearCookie(REFRESH_COOKIE, { path: '/', domain });
  }
}
