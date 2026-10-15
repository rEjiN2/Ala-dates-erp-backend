import { describe, expect, it } from 'vitest';
import { buildObjectKey } from './object-key.util.js';

describe('buildObjectKey', () => {
  it('places the object under the requested prefix with a generated name', () => {
    const key = buildObjectKey('party/652f1c9e5b4a3d2e1f0a9b8c', 'passport.pdf');
    expect(key).toMatch(/^party\/652f1c9e5b4a3d2e1f0a9b8c\/[0-9a-f-]{36}\.pdf$/);
  });

  it('never lets a traversing filename escape the prefix', () => {
    const key = buildObjectKey('party/123', '../../../etc/passwd');
    expect(key.startsWith('party/123/')).toBe(true);
    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
  });

  it('strips traversal and unsafe characters out of the prefix itself', () => {
    const key = buildObjectKey('../../secrets/party id!', 'photo.png');
    expect(key).not.toContain('..');
    expect(key).toMatch(/^secrets\/partyid\/[0-9a-f-]{36}\.png$/);
  });

  it('drops an extension that is not a plain short suffix', () => {
    const key = buildObjectKey('product/1', 'evil.php.exe%00.jpg"');
    expect(key.endsWith('"')).toBe(false);
    expect(key).toMatch(/^product\/1\/[0-9a-f-]{36}(\.[a-z0-9]{1,10})?$/);
  });

  it('does not reuse a name for the same uploaded filename', () => {
    const first = buildObjectKey('product/1', 'photo.png');
    const second = buildObjectKey('product/1', 'photo.png');
    expect(first).not.toBe(second);
  });
});
