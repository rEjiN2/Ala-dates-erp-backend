import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { Test } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import type { DynamicModule } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { inject } from 'vitest';
import { HealthModule } from './health.module.js';
import { keepConnected } from '../database/connection-status.js';

/** Same connection setup the app uses, so this exercises the real boot behaviour. */
function lazyMongo(uri: string, dbName = 'health'): DynamicModule {
  const options = { dbName, serverSelectionTimeoutMS: 1_000 };
  return MongooseModule.forRoot(uri, { ...options, lazyConnection: true, connectionFactory: keepConnected(uri, options) });
}

async function startApp(mongo: DynamicModule) {
  const moduleRef = await Test.createTestingModule({ imports: [mongo, HealthModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe('GET / and GET /health', () => {
  it('reports the API running and the database connected', async () => {
    const app = await startApp(lazyMongo(inject('mongoUri')));
    try {
      const root = await request(app.getHttpServer()).get('/').expect(200);
      expect(root.body).toMatchObject({ message: 'Ala Dates ERP API is running', status: 'ok', health: '/health' });

      const health = await request(app.getHttpServer()).get('/health').expect(200);
      expect(health.body).toMatchObject({ status: 'ok', node: process.version, database: { state: 'connected' } });
    } finally {
      await app.close();
    }
  });

  it('still boots when MongoDB is unreachable, and /health says why (without leaking credentials)', async () => {
    const app = await startApp(lazyMongo('mongodb://admin:s3cret@127.0.0.1:1/ala?directConnection=true'));
    try {
      await request(app.getHttpServer()).get('/').expect(200);

      const health = await request(app.getHttpServer()).get('/health').expect(503);
      expect(health.body).toMatchObject({
        status: 'degraded',
        database: { state: 'disconnected', error: { name: 'MongoServerSelectionError' } },
      });
      // The per-server reason is surfaced, not just the "timed out" summary.
      expect(health.body.database.error.message).toMatch(/127\.0\.0\.1:1: .*ECONNREFUSED/);
      expect(JSON.stringify(health.body)).not.toContain('s3cret');
    } finally {
      await app.close();
    }
  }, 20_000);

  it('keeps retrying after a failed first connect, and recovers once MongoDB is reachable', async () => {
    const port = await freePort();
    const app = await startApp(lazyMongo(`mongodb://127.0.0.1:${port}/ala?directConnection=true`));
    let mongod: MongoMemoryServer | undefined;
    try {
      await request(app.getHttpServer()).get('/health').expect(503);

      mongod = await MongoMemoryServer.create({ instance: { port, ip: '127.0.0.1' } });

      let state = 'disconnected';
      for (let attempt = 0; attempt < 30 && state !== 'connected'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        state = (await request(app.getHttpServer()).get('/health')).body.database.state;
      }
      expect(state).toBe('connected');
    } finally {
      await app.close();
      await mongod?.stop();
    }
  }, 60_000);
});
