import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthModule } from './health.module.js';

describe('GET /', () => {
  it('reports that the API is running, without a login', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const response = await request(app.getHttpServer()).get('/').expect(200);
      expect(response.body).toMatchObject({ message: 'Ala Dates ERP API is running', status: 'ok', health: '/health' });

      await request(app.getHttpServer()).get('/health').expect(200);
    } finally {
      await app.close();
    }
  });
});
