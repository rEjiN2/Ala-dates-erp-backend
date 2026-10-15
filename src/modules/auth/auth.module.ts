import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy.js';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Global because JwtAuthGuard / JwtRefreshGuard (passport's AuthGuard) inject
 * AuthModuleOptions, which only PassportModule provides. Exporting it from a
 * global module lets every feature module use the guards without each one
 * having to remember to import PassportModule.
 */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({}), UsersModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAccessStrategy, JwtRefreshStrategy],
  exports: [AuthService, PassportModule],
})
export class AuthModule {}
