/**
 * One-off LOCAL DEV helper: `pnpm seed:dev-user`. Never run on startup.
 *
 * Creates a single admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD so
 * the guarded endpoints can be exercised locally. Credentials come only from
 * the environment; nothing is hardcoded here. Safe to run repeatedly: an
 * existing user with that email is left exactly as it is.
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { AppModule } from '../app.module.js';
import type { EnvConfig } from '../config/env.validation.js';
import { Role, RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { User, UserDocument } from '../modules/users/schemas/user.schema.js';
import { ensureAdminRole } from './seed-roles.js';

async function seedDevUser(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const config = app.get(ConfigService<EnvConfig, true>);

    if (config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new Error('seed:dev-user is a local development helper and refuses to run with NODE_ENV=production');
    }

    const email = config.get('SEED_ADMIN_EMAIL', { infer: true })?.toLowerCase();
    const password = config.get('SEED_ADMIN_PASSWORD', { infer: true });
    if (!email || !password) {
      throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env before running seed:dev-user');
    }

    const role = await ensureAdminRole(app.get<Model<RoleDocument>>(getModelToken(Role.name)));
    const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));

    // Upsert keyed on the unique email: atomic, so even two concurrent runs
    // can't create a duplicate, and an existing user is never overwritten.
    const result = await userModel
      .updateOne(
        { email },
        {
          $setOnInsert: {
            email,
            name: 'Dev Admin',
            passwordHash: await bcrypt.hash(password, 10),
            role: role._id,
            isActive: true,
          },
        },
        { upsert: true },
      )
      .exec();

    if (result.upsertedCount > 0) {
      console.log(`\n[seed:dev-user] Created dev admin user ${email} with role "${role.name}".`);
      console.log(`[seed:dev-user] Permissions: ${role.permissions.join(', ')}\n`);
    } else {
      console.log(`\n[seed:dev-user] User ${email} already exists; left unchanged (password and role not modified).\n`);
    }
  } finally {
    await app.close();
  }
}

try {
  await seedDevUser();
} catch (error) {
  console.error(`\n[seed:dev-user] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
