import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGateDownRouter } from '../src/reservations/gateDown.router.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { signAccessToken } from '../src/auth/tokens.js';
import {
  makeMockCommandLogRepo,
  mockDevicePortOk,
  mockDevicePortTimeout,
  type MockCommandLogOptions,
} from './helpers/mockGateDown.js';
import type { DeviceCommandPort } from '../src/reservations/deviceCommandPort.js';

function buildApp(opts: MockCommandLogOptions = {}, port: DeviceCommandPort = mockDevicePortOk()): express.Express {
  const repo = makeMockCommandLogRepo(opts);
  const app = express();
  app.use(express.json());
  app.use('/reservations', createGateDownRouter(repo, port));
  app.use(errorHandler);
  return app;
}

const auth = `Bearer ${signAccessToken('user-1')}`;
const RESV_ID = '22222222-2222-2222-2222-222222222222';
const PATH = `/reservations/${RESV_ID}/gate-down`;
const body = { request_id: 'req-1' };

describe('POST /reservations/:id/gate-down', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildApp()).post(PATH).send(body);
    expect(res.status).toBe(401);
  });

  it('正常系は 200・GateDownResponse', async () => {
    const res = await request(buildApp()).post(PATH).set('authorization', auth).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'down', command_id: 'cmd-1' });
  });

  it('request_id 欠落は 422', async () => {
    const res = await request(buildApp()).post(PATH).set('authorization', auth).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
  });

  it('id が UUID でないと 422', async () => {
    const res = await request(buildApp())
      .post('/reservations/not-a-uuid/gate-down')
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(422);
  });

  it('予約不在は 404', async () => {
    const res = await request(buildApp({ context: null })).post(PATH).set('authorization', auth).send(body);
    expect(res.status).toBe(404);
  });

  it('reserved 以外は 409 invalid_state', async () => {
    const res = await request(
      buildApp({
        context: {
          status: 'active',
          start_time: new Date(Date.now() - 60 * 60_000),
          end_time: new Date(Date.now() + 60 * 60_000),
          spot_id: 'spot-1',
          occupancy: 'vacant',
          device_id: 'device-1',
          device_last_seen_at: new Date(),
        },
      }),
    )
      .post(PATH)
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_state');
  });

  it('物理占有は 409 physical_occupancy', async () => {
    const res = await request(
      buildApp({
        context: {
          status: 'reserved',
          start_time: new Date(Date.now() - 60 * 60_000),
          end_time: new Date(Date.now() + 60 * 60_000),
          spot_id: 'spot-1',
          occupancy: 'occupied',
          device_id: 'device-1',
          device_last_seen_at: new Date(),
        },
      }),
    )
      .post(PATH)
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'physical_occupancy', retryable: false });
  });

  it('デバイス不健全は 503', async () => {
    const res = await request(
      buildApp({
        context: {
          status: 'reserved',
          start_time: new Date(Date.now() - 60 * 60_000),
          end_time: new Date(Date.now() + 60 * 60_000),
          spot_id: 'spot-1',
          occupancy: 'vacant',
          device_id: 'device-1',
          device_last_seen_at: new Date(Date.now() - 60 * 60_000),
        },
      }),
    )
      .post(PATH)
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('device_unhealthy');
  });

  it('デバイス無応答は 504 timeout（retryable）', async () => {
    const res = await request(buildApp({}, mockDevicePortTimeout()))
      .post(PATH)
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('冪等再送（success）は 200・同じ command_id', async () => {
    const res = await request(buildApp({ existing: { id: 'cmd-orig', result: 'success' } }))
      .post(PATH)
      .set('authorization', auth)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.command_id).toBe('cmd-orig');
  });
});
