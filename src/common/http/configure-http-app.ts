import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request parsing the API relies on, applied in main.ts and in HTTP tests so
 * both behave the same.
 *
 * Express 5 defaults to the "simple" query parser, which leaves
 * `types[]=cash&types[]=bank` (axios' default array format) as a literal
 * `types[]` key; the strict validation pipe then rejects the request. The
 * "extended" parser turns it into an array.
 */
export function configureHttpApp(app: INestApplication): void {
  (app as NestExpressApplication).set('query parser', 'extended');
}
