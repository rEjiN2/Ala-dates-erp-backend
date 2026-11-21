/**
 * DEV ONLY: `pnpm db:reset --confirm=<databaseName>` (also needs ALLOW_RESET_DB=<databaseName>).
 *
 * Drops every collection (counters included, so number series restart) and
 * seeds only: roles, the admin user (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD),
 * system-key ledger accounts, the Cash Customer and an empty Company profile.
 * Files in storage (MEGA) are not touched.
 */
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { AppModule } from '../app.module.js';
import { LedgerAccountService } from '../modules/accounting/ledger-accounts/ledger-account.service.js';
import { SYSTEM_ACCOUNTS, LedgerAccountType } from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import {
  OPENING_BALANCE_EQUITY_KEY,
  OPENING_BALANCE_EQUITY_NAME,
} from '../modules/accounting/opening-balances/schemas/opening-balance.schema.js';
import { CompanyService } from '../modules/company/company.service.js';
import { CASH_CUSTOMER_KEY, Party, PartyDocument, PartyKind } from '../modules/party/schemas/party.schema.js';
import { PartyService } from '../modules/party/party.service.js';
import { Role, RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { User, UserDocument, UserStatus } from '../modules/users/schemas/user.schema.js';
import { ensureConnected, lastDatabaseError } from './connection-status.js';
import { assertResetAllowed, confirmArg } from './reset-guard.js';
import { ensureDefaultRoles } from './seed-roles.js';

const SEED_ACTOR = { id: '000000000000000000000000', name: 'System' };

async function reset(): Promise<void> {
  // This script runs outside Nest's ConfigModule: read the same .env it does (shell variables win).
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on the shell environment.
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run with NODE_ENV=production');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set (in .env or the environment); nothing was dropped');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    // The app connects lazily: open it and wait before reading anything from it.
    const connection = app.get<Connection>(getConnectionToken());
    await ensureConnected(connection, 30_000);
    if (connection.readyState !== 1 || !connection.db) {
      const reason = lastDatabaseError(connection)?.message;
      throw new Error(`Could not connect to MongoDB${reason ? `: ${reason}` : ''}; nothing was dropped`);
    }
    const databaseName = connection.name;
    const host = connection.host;
    if (!databaseName || !host) {
      throw new Error('The connection reports no database name or host; nothing was dropped');
    }

    const db = connection.db;
    console.log(`\n[db:reset] Database: ${databaseName}  Host: ${host}`);
    const collections = (await db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
    let fileReferences = 0;
    for (const { name } of collections) {
      const count = await db.collection(name).countDocuments();
      if (name === 'file_attachments') fileReferences = count;
      console.log(`[db:reset]   ${name}: ${count}`);
    }

    assertResetAllowed({
      nodeEnv: process.env.NODE_ENV,
      allowResetDb: process.env.ALLOW_RESET_DB,
      confirm: confirmArg(process.argv),
      databaseName,
    });
    const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!email || !password) {
      throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env before running db:reset');
    }

    for (const { name } of collections) await db.dropCollection(name);
    // Dropping removed the indexes too; rebuild them (this also recreates the collections).
    for (const model of Object.values(connection.models)) await model.syncIndexes();
    console.log(
      `[db:reset] Dropped ${collections.length} collections. File references removed: ${fileReferences} (files in storage untouched).`,
    );

    const roles = await ensureDefaultRoles(app.get<Model<RoleDocument>>(getModelToken(Role.name)));
    const admin = roles.find((role) => role.isSystem)!;
    await app.get<Model<UserDocument>>(getModelToken(User.name)).create({
      email,
      name: 'Admin',
      passwordHash: await bcrypt.hash(password, 10),
      role: admin._id,
      status: UserStatus.ACTIVE,
    });

    const accounts = app.get(LedgerAccountService);
    await accounts.ensureSystemAccount(OPENING_BALANCE_EQUITY_KEY, OPENING_BALANCE_EQUITY_NAME, LedgerAccountType.OTHER);
    for (const system of Object.values(SYSTEM_ACCOUNTS)) {
      await accounts.ensureSystemAccount(system.key, system.name, system.type);
    }

    const view = await app.get(PartyService).create({ kind: PartyKind.CUSTOMER, name: 'Cash Customer' }, SEED_ACTOR);
    await app
      .get<Model<PartyDocument>>(getModelToken(Party.name))
      .updateOne({ _id: view.id }, { $set: { systemKey: CASH_CUSTOMER_KEY } })
      .exec();

    await app.get(CompanyService).ensure();
    console.log(
      `[db:reset] Seeded roles (${roles.map((r) => r.name).join(', ')}), admin ${email}, system accounts, Cash Customer, company profile.\n`,
    );
  } finally {
    await app.close();
  }
}

try {
  await reset();
} catch (error) {
  console.error(`\n[db:reset] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
