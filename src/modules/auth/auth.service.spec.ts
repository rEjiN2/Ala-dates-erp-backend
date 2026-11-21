import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service.js';

const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_REFRESH_EXPIRES_IN: '7d',
};

function setup() {
  let storedHash: string | null = null;
  const user = { id: 'u1', email: 'a@b.c', role: { id: 'r1', name: 'Admin', permissions: [] }, isActive: true, status: 'active' };
  const users = {
    setRefreshTokenHash: vi.fn(async (_id: string, h: string | null) => {
      storedHash = h;
    }),
    findByIdWithRefreshHash: vi.fn(async () => ({ ...user, refreshTokenHash: storedHash })),
  };
  const config = { get: (k: string) => env[k] };
  const service = new AuthService(users as never, new JwtService({}), config as never);
  return { service, user };
}

describe('AuthService refresh', () => {
  it('cookie maxAge matches token: access 15m, refresh 7d', async () => {
    const { service, user } = setup();
    const t = await service.issueTokens(user as never);
    expect(Math.abs(t.accessMaxAgeMs - 15 * 60_000)).toBeLessThan(5_000);
    expect(Math.abs(t.refreshMaxAgeMs - 7 * 86_400_000)).toBeLessThan(5_000);
  });

  it('rotates: new refresh works, old one then rejected with 401', async () => {
    const { service, user } = setup();
    const first = await service.issueTokens(user as never);
    // ensure the next token differs (iat is in seconds)
    await new Promise((r) => setTimeout(r, 1100));
    const second = await service.rotateRefreshToken('u1', first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(service.rotateRefreshToken('u1', first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.rotateRefreshToken('u1', second.refreshToken)).resolves.toBeDefined();
  });

  it('bad refresh token returns 401', async () => {
    const { service, user } = setup();
    await service.issueTokens(user as never);
    await expect(service.rotateRefreshToken('u1', 'garbage')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
