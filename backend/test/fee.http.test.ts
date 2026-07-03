import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { createFeeRouter } from '../src/reservations/fee.router.js';
import { type MockFeeOptions, makeMockFeeRepo } from './helpers/mockFee.js';

/** fee ルーターの HTTP 挙動（200 pending / 200 confirmed / 401 / 404）。 */
function buildApp(opts: MockFeeOptions = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/reservations', createFeeRouter(makeMockFeeRepo(opts)));
  app.use(errorHandler);
  return app;
}

const auth = `Bearer ${signAccessToken('user-1')}`;
const RESV_ID = '22222222-2222-2222-2222-222222222222';
const PATH = `/reservations/${RESV_ID}/fee`;

describe('GET /reservations/:id/fee', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).get(PATH);
    expect(res.status).toBe(401);
  });

  it('id が UUID でないと 422', async () => {
    const res = await request(buildApp())
      .get('/reservations/not-uuid/fee')
      .set('authorization', auth);
    expect(res.status).toBe(422);
  });

  it('Fee 未記録 → 200・pending', async () => {
    const res = await request(buildApp({ exists: true, fee: null }))
      .get(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending', total: 0 });
  });

  it('Fee あり → 200・confirmed', async () => {
    const res = await request(
      buildApp({
        exists: true,
        fee: {
          reservation_id: RESV_ID,
          slot_fee: 200,
          overstay_fee: 0,
          total: 200,
          status: 'confirmed',
          calculated_at: new Date('2026-06-25T12:00:00Z'),
        },
      }),
    )
      .get(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'confirmed', total: 200 });
  });

  it('他人/不在 → 404', async () => {
    const res = await request(buildApp({ exists: false }))
      .get(PATH)
      .set('authorization', auth);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});
