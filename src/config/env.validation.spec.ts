import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation.js';

const base = {
  MONGODB_URI: 'mongodb://localhost/test',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  STORAGE_DRIVER: 'mega',
  MEGA_EMAIL: 'files@example.com',
  MEGA_PASSWORD: 'secret',
  MEGA_FOLDER_NAME: 'files',
};

describe('validateEnv COOKIE_DOMAIN', () => {
  it.each([
    ['', undefined],
    ['  ', undefined],
    ['.example.com', '.example.com'],
    ['api.example.com', 'api.example.com'],
    ['localhost', 'localhost'],
  ])('accepts %j', (value, expected) => {
    expect(validateEnv({ ...base, COOKIE_DOMAIN: value }).COOKIE_DOMAIN).toBe(expected);
  });

  it.each(['https://najeeb-erp.vercel.app', '"example.com"', 'example.com:443', 'example.com/', 'api example.com'])(
    'rejects %j at startup with a clear message',
    (value) => {
      expect(() => validateEnv({ ...base, COOKIE_DOMAIN: value })).toThrow(/COOKIE_DOMAIN must be a bare domain/);
    },
  );

  it('rejects the shared vercel.app suffix, which browsers refuse', () => {
    expect(() => validateEnv({ ...base, COOKIE_DOMAIN: '.vercel.app' })).toThrow(/cannot be "vercel.app"/);
  });
});
