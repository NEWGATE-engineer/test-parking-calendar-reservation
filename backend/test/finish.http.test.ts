import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { createFinishRouter } from '../src/reservations/finish.router.js';
import {
  defaultFinishReservation,
  type MockFinishOptions,
  makeMockFinishRepo,
} from './helpers/mockFinish.js';
import { fakeTxRunner } from './helpers/mockReservationsRepo.js';

/** finish ルーターの HTTP 挙動（200/401/404/409）。偽 tx ランナーで DB を使わない。 */
function buildApp(opts: MockFinishOptions = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/reservations', createFinishRouter(makeMockFinishRepo(opts), fakeTxRunner));
  app.use(errorHandler);
  return app;
}

const auth = `Bearer ${signAccessToken('user-1')}`;
const RESV_ID = '22222222-2222-2222-2222-222222222222';
const PATH = `/reservations/${RESV_ID}/finish`;

describe('POST /reservations/:id/finish', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).post(PATH);
    expect(res.status).toBe(401);
  });

  it('id が UUID でないと 422', async () => {
    const res = await request(buildApp())
      .post('/reservations/not-uuid/finish')
      .set('authorization', auth);
    expect(res.status).toBe(422);
  });

  it('空車 active → 200・completed', async () => {
    const res = await request(buildApp({ hasOpen: false }))
      .post(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('不在/他人 → 404', async () => {
    const res = await request(buildApp({ reservation: null }))
      .post(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('completed 済み → 409 not_finishable', async () => {
    const res = await request(
      buildApp({ reservation: { ...defaultFinishReservation(), status: 'completed' } }),
    )
      .post(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_finishable');
  });
});
