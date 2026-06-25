import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReservationsRouter } from '../src/reservations/router.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { makeMockReservationsRepo, fakeTxRunner, type MockReservationsRepoOptions } from './helpers/mockReservationsRepo.js';

function buildApp(repoOptions: MockReservationsRepoOptions = {}): express.Express {
  const repo = makeMockReservationsRepo(repoOptions);
  const app = express();
  app.use(express.json());
  // 偽ランナーを注入して DB なしで完結させる
  app.use('/reservations', createReservationsRouter(repo, fakeTxRunner));
  app.use(errorHandler);
  return app;
}

const auth = `Bearer ${signAccessToken('user-1')}`;
const SPOT_ID = '11111111-1111-1111-1111-111111111111';

/** 未来日時の正常ボディ（過去日時 422 を踏まないよう十分先にする）。 */
function validBody(): Record<string, string> {
  return {
    spot_id: SPOT_ID,
    start_time: '2099-06-25T10:00:00Z',
    end_time: '2099-06-25T11:00:00Z',
  };
}

describe('POST /reservations', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).post('/reservations').send(validBody());
    expect(res.status).toBe(401);
  });

  it('認証ありで 201・予約と見込み料金を返す', async () => {
    const res = await request(buildApp({ spot: { id: SPOT_ID, last_seen_at: new Date() } }))
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ spot_id: SPOT_ID, status: 'reserved', estimated_slot_fee: 200 });
  });

  it('区画が存在しなければ 404 not_found', async () => {
    const res = await request(buildApp({ spot: null }))
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('時間帯重複は 409 conflict_overlap', async () => {
    const res = await request(
      buildApp({
        spot: { id: SPOT_ID, last_seen_at: new Date() },
        conflicts: [{ start: new Date('2099-06-25T10:30:00Z'), end: new Date('2099-06-25T12:00:00Z') }],
      }),
    )
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict_overlap', retryable: false });
  });

  it('デバイス不健全は 409 device_unhealthy', async () => {
    const res = await request(buildApp({ spot: { id: SPOT_ID, last_seen_at: null } }))
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_unhealthy');
  });

  it('spot_id が UUID でないと 422', async () => {
    const res = await request(buildApp())
      .post('/reservations')
      .set('authorization', auth)
      .send({ ...validBody(), spot_id: 'not-a-uuid' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
  });

  it('end <= start は 422', async () => {
    const res = await request(buildApp())
      .post('/reservations')
      .set('authorization', auth)
      .send({ spot_id: SPOT_ID, start_time: '2099-06-25T11:00:00Z', end_time: '2099-06-25T10:00:00Z' });
    expect(res.status).toBe(422);
  });

  it('過去開始は 422', async () => {
    const res = await request(buildApp())
      .post('/reservations')
      .set('authorization', auth)
      .send({ spot_id: SPOT_ID, start_time: '2000-01-01T10:00:00Z', end_time: '2000-01-01T11:00:00Z' });
    expect(res.status).toBe(422);
  });
});
