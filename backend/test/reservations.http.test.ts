import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { createReservationsRouter } from '../src/reservations/router.js';
import {
  fakeTxRunner,
  type MockReservationsRepoOptions,
  makeMockReservationsRepo,
} from './helpers/mockReservationsRepo.js';

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
const RESV_ID = '22222222-2222-2222-2222-222222222222';

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
    expect(res.body).toMatchObject({
      spot_id: SPOT_ID,
      status: 'reserved',
      estimated_slot_fee: 200,
    });
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
        conflicts: [
          { start: new Date('2099-06-25T10:30:00Z'), end: new Date('2099-06-25T12:00:00Z') },
        ],
      }),
    )
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict_overlap', retryable: false });
  });

  it('バッファ未満の近接は 409 conflict_buffer', async () => {
    const res = await request(
      buildApp({
        spot: { id: SPOT_ID, last_seen_at: new Date() },
        // 希望 10:00–11:00 の直後 11:05 開始（重ならないがバッファ 15分未満）
        conflicts: [
          { start: new Date('2099-06-25T11:05:00Z'), end: new Date('2099-06-25T12:00:00Z') },
        ],
      }),
    )
      .post('/reservations')
      .set('authorization', auth)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict_buffer', retryable: false });
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
    const res = await request(buildApp()).post('/reservations').set('authorization', auth).send({
      spot_id: SPOT_ID,
      start_time: '2099-06-25T11:00:00Z',
      end_time: '2099-06-25T10:00:00Z',
    });
    expect(res.status).toBe(422);
  });

  it('end == start（ゼロ幅）は 422', async () => {
    const res = await request(buildApp()).post('/reservations').set('authorization', auth).send({
      spot_id: SPOT_ID,
      start_time: '2099-06-25T10:00:00Z',
      end_time: '2099-06-25T10:00:00Z',
    });
    expect(res.status).toBe(422);
  });

  it('過去開始は 422', async () => {
    const res = await request(buildApp()).post('/reservations').set('authorization', auth).send({
      spot_id: SPOT_ID,
      start_time: '2000-01-01T10:00:00Z',
      end_time: '2000-01-01T11:00:00Z',
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /reservations', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).get('/reservations');
    expect(res.status).toBe(401);
  });

  it('認証ありで 200・配列を返す', async () => {
    const res = await request(
      buildApp({
        reservations: [
          {
            id: RESV_ID,
            spot_id: SPOT_ID,
            start_time: new Date('2099-06-25T10:00:00Z'),
            end_time: new Date('2099-06-25T11:00:00Z'),
            status: 'reserved',
            created_at: new Date('2026-06-25T00:00:00Z'),
          },
        ],
      }),
    )
      .get('/reservations')
      .set('authorization', auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: RESV_ID, status: 'reserved', estimated_slot_fee: 200 });
  });

  it('未知の status は 422', async () => {
    const res = await request(buildApp())
      .get('/reservations')
      .query({ status: 'bogus' })
      .set('authorization', auth);
    expect(res.status).toBe(422);
  });
});

describe('PUT /reservations/:id', () => {
  /** 既定: reserved の所有予約あり・健全デバイス。 */
  function appWithReserved(extra: MockReservationsRepoOptions = {}) {
    return buildApp({
      owned: {
        id: RESV_ID,
        spot_id: SPOT_ID,
        start_time: new Date('2099-06-25T10:00:00Z'),
        end_time: new Date('2099-06-25T11:00:00Z'),
        status: 'reserved',
        created_at: new Date('2026-06-25T00:00:00Z'),
      },
      spot: { id: SPOT_ID, last_seen_at: new Date() },
      ...extra,
    });
  }

  it('Bearer 無しは 401', async () => {
    const res = await request(appWithReserved())
      .put(`/reservations/${RESV_ID}`)
      .send({ end_time: '2099-06-25T12:00:00Z' });
    expect(res.status).toBe(401);
  });

  it('部分更新で 200・料金再計算', async () => {
    const res = await request(appWithReserved())
      .put(`/reservations/${RESV_ID}`)
      .set('authorization', auth)
      .send({ end_time: '2099-06-25T12:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: RESV_ID, status: 'reserved', estimated_slot_fee: 400 });
  });

  it('存在しない/他人は 404', async () => {
    const res = await request(buildApp({ owned: null }))
      .put(`/reservations/${RESV_ID}`)
      .set('authorization', auth)
      .send({ end_time: '2099-06-25T12:00:00Z' });
    expect(res.status).toBe(404);
  });

  it('reserved 以外は 409 not_modifiable', async () => {
    const res = await request(
      appWithReserved({
        owned: {
          id: RESV_ID,
          spot_id: SPOT_ID,
          start_time: new Date('2099-06-25T10:00:00Z'),
          end_time: new Date('2099-06-25T11:00:00Z'),
          status: 'active',
          created_at: new Date('2026-06-25T00:00:00Z'),
        },
      }),
    )
      .put(`/reservations/${RESV_ID}`)
      .set('authorization', auth)
      .send({ end_time: '2099-06-25T12:00:00Z' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_modifiable');
  });

  it('更新項目が空は 422', async () => {
    const res = await request(appWithReserved())
      .put(`/reservations/${RESV_ID}`)
      .set('authorization', auth)
      .send({});
    expect(res.status).toBe(422);
  });

  it('id が UUID でないと 422', async () => {
    const res = await request(appWithReserved())
      .put('/reservations/not-a-uuid')
      .set('authorization', auth)
      .send({ end_time: '2099-06-25T12:00:00Z' });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /reservations/:id', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).delete(`/reservations/${RESV_ID}`);
    expect(res.status).toBe(401);
  });

  it('reserved を取り消して 204', async () => {
    const res = await request(buildApp({ cancelRows: 1 }))
      .delete(`/reservations/${RESV_ID}`)
      .set('authorization', auth);
    expect(res.status).toBe(204);
  });

  it('存在しなければ 404', async () => {
    const res = await request(buildApp({ cancelRows: 0, ownedStatus: null }))
      .delete(`/reservations/${RESV_ID}`)
      .set('authorization', auth);
    expect(res.status).toBe(404);
  });

  it('reserved 以外は 409 not_cancelable', async () => {
    const res = await request(buildApp({ cancelRows: 0, ownedStatus: 'completed' }))
      .delete(`/reservations/${RESV_ID}`)
      .set('authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_cancelable');
  });
});
