import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import type { DynamicModule } from '@nestjs/common';
import request from 'supertest';
import { inject } from 'vitest';
import { HealthModule } from './health.module.js';
import { trackConnection } from '../database/connection-status.js';

/** Same connection options the app uses, so this exercises the real boot behaviour. */
function lazyMongo(uri: string, dbName = 'health'): DynamicModule {
  return MongooseModule.forRoot(uri, {
    dbName,
    lazyConnection: true,
    connectionFactory: trackConnection,
    serverSelectionTimeoutMS: 1_000,
  });
}

async function startApp(mongo: DynamicModule) {
  const moduleRef = await Test.createTestingModule({ imports: [mongo, HealthModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
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
      expect(health.body.database.error.message).toMatch(/ECONNREFUSED/);
      expect(JSON.stringify(health.body)).not.toContain('s3cret');
    } finally {
      await app.close();
    }
  }, 20_000);
});
