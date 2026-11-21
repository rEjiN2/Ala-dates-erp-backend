import { describe, expect, it } from 'vitest';
import { assertResetAllowed, confirmArg } from './reset-guard.js';

const ok = { nodeEnv: 'development', allowResetDb: 'ala_dev', confirm: 'ala_dev', databaseName: 'ala_dev' };

describe('db:reset guard', () => {
  it('allows the right database with both the env and --confirm', () => {
    expect(() => assertResetAllowed(ok)).not.toThrow();
  });

  it('refuses without --confirm and with a wrong name', () => {
    expect(() => assertResetAllowed({ ...ok, confirm: undefined })).toThrow(/--confirm=ala_dev/);
    expect(() => assertResetAllowed({ ...ok, confirm: 'ala_prod' })).toThrow(/--confirm=ala_dev/);
  });

  it('refuses in production, and when ALLOW_RESET_DB is missing or another database', () => {
    expect(() => assertResetAllowed({ ...ok, nodeEnv: 'production' })).toThrow(/production/);
    expect(() => assertResetAllowed({ ...ok, allowResetDb: undefined })).toThrow(/ALLOW_RESET_DB/);
    expect(() => assertResetAllowed({ ...ok, allowResetDb: 'other' })).toThrow(/ALLOW_RESET_DB/);
  });

  it('reads --confirm from the command line', () => {
    expect(confirmArg(['node', 'x.js', '--confirm=ala_dev'])).toBe('ala_dev');
    expect(confirmArg(['node', 'x.js'])).toBeUndefined();
  });
});
