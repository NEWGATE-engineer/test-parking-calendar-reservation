import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSpotsRouter } from '../src/spots/router.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { makeMockSpotsRepo } from './helpers/mockSpotsRepo.js';
import type { SpotsRepository } from '../src/spots/repository.js';

function buildApp(repo: SpotsRepository): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/spots', createSpotsRouter(repo));
  app.use(errorHandler);
  return app;
}

const auth = `Bearer ${signAccessToken('user-1')}`;

describe('GET /spots', () => {
  it('Bearer 無しは 401', async () => {
    const repo = makeMockSpotsRepo([]);
    const res = await request(buildApp(repo)).get('/spots');
    expect(res.status).toBe(401);
  });

  it('認証ありで 200・配列を返す', async () => {
    const repo = makeMockSpotsRepo([{ id: '1', name: 'A', occupancy: 'vacant', last_seen_at: new Date() }]);
    const res = await request(buildApp(repo)).get('/spots').set('authorization', auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: '1', device_healthy: true });
  });
});

describe('GET /spots/availability', () => {
  it('認証ありで 200', async () => {
    const repo = makeMockSpotsRepo([{ id: '1', name: 'A', occupancy: 'vacant', last_seen_at: new Date() }]);
    const res = await request(buildApp(repo))
      .get('/spots/availability')
      .query({ start: '2026-06-24T10:00:00Z', end: '2026-06-24T11:00:00Z' })
      .set('authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ spot_id: '1', available: true, reason: 'ok' });
  });

  it('end <= start は 422', async () => {
    const repo = makeMockSpotsRepo([]);
    const res = await request(buildApp(repo))
      .get('/spots/availability')
      .query({ start: '2026-06-24T11:00:00Z', end: '2026-06-24T10:00:00Z' })
      .set('authorization', auth);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
  });

  it('start/end 欠落は 422', async () => {
    const repo = makeMockSpotsRepo([]);
    const res = await request(buildApp(repo)).get('/spots/availability').set('authorization', auth);
    expect(res.status).toBe(422);
  });

  it('end === start（ゼロ幅）は 422', async () => {
    const repo = makeMockSpotsRepo([]);
    const res = await request(buildApp(repo))
      .get('/spots/availability')
      .query({ start: '2026-06-24T10:00:00Z', end: '2026-06-24T10:00:00Z' })
      .set('authorization', auth);
    expect(res.status).toBe(422);
  });
});
