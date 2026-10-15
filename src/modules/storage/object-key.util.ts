import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

const SAFE_SEGMENT = /[^a-zA-Z0-9_-]/g;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;

/**
 * Builds the stored object key. The filename is always server-generated: the
 * client's name only ever contributes an extension, and every path segment is
 * scrubbed, so no input can traverse out of its prefix or collide with an
 * existing object.
 */
export function buildObjectKey(path: string, originalName: string): string {
  const prefix = path
    .split('/')
    .map((segment) => segment.replace(SAFE_SEGMENT, ''))
    .filter((segment) => segment.length > 0)
    .join('/');

  const rawExtension = extname(originalName).toLowerCase();
  const extension = SAFE_EXTENSION.test(rawExtension) ? rawExtension : '';

  const filename = `${randomUUID()}${extension}`;
  return prefix ? `${prefix}/${filename}` : filename;
}
