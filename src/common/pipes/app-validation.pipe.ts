import { ValidationPipe } from '@nestjs/common';

/**
 * The single global validation pipe. Exported as a factory so tests validate
 * DTOs with exactly the options production runs with.
 *
 * forbidNonWhitelisted turns any property a DTO does not declare into a 400,
 * which is how server-owned fields (e.g. generated codes) are kept out of
 * client payloads.
 */
export function createAppValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}
