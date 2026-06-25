import { describe, it, expect } from 'vitest';
import { ReservationsService } from '../src/reservations/service.js';
import { AppError } from '../src/http/errors.js';
import { makeMockReservationsRepo, fakeTxRunner } from './helpers/mockReservationsRepo.js';
import type { CreateReservationInput } from '../src/reservations/validation.js';

/** 希望時間帯 10:00–11:00（UTC）。 */
const input: CreateReservationInput = {
  spotId: 'spot-1',
  start: new Date('2026-06-25T10:00:00Z'),
  end: new Date('2026-06-25T11:00:00Z'),
};

describe('ReservationsService.create', () => {
  it('健全＋競合なしで作成成功し、見込み料金を返す', async () => {
    const repo = makeMockReservationsRepo({ spot: { id: 'spot-1', last_seen_at: new Date() } });
    const res = await new ReservationsService(repo, fakeTxRunner).create('user-1', input);

    expect(res).toMatchObject({
      spot_id: 'spot-1',
      status: 'reserved',
      // 60分 = 2単位 × 100円
      estimated_slot_fee: 200,
    });
    // 時刻は ISO 文字列で返る
    expect(res.start_time).toBe('2026-06-25T10:00:00.000Z');
    // INSERT に所有者と時間帯が渡る
    expect(repo.insertReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', spotId: 'spot-1' }),
    );
  });

  it('区画が存在しない（spot=null）は 404 not_found・INSERT しない', async () => {
    const repo = makeMockReservationsRepo({ spot: null });
    const service = new ReservationsService(repo, fakeTxRunner);

    await expect(service.create('user-1', input)).rejects.toMatchObject({
      httpStatus: 404,
      code: 'not_found',
    });
    expect(repo.insertReservation).not.toHaveBeenCalled();
  });

  it('時間帯が重複する予約があれば 409 conflict_overlap', async () => {
    const repo = makeMockReservationsRepo({
      spot: { id: 'spot-1', last_seen_at: new Date() },
      // 10:30–12:00 が希望窓 10:00–11:00 と重なる
      conflicts: [{ start: new Date('2026-06-25T10:30:00Z'), end: new Date('2026-06-25T12:00:00Z') }],
    });

    await expect(new ReservationsService(repo, fakeTxRunner).create('user-1', input)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'conflict_overlap',
      retryable: false,
    });
  });

  it('バッファ未満で近接する予約があれば 409 conflict_buffer', async () => {
    const repo = makeMockReservationsRepo({
      spot: { id: 'spot-1', last_seen_at: new Date() },
      // 09:40–09:50 終了。重ならないが開始 10:00 まで 10分（バッファ 15分未満）
      conflicts: [{ start: new Date('2026-06-25T09:40:00Z'), end: new Date('2026-06-25T09:50:00Z') }],
    });

    await expect(new ReservationsService(repo, fakeTxRunner).create('user-1', input)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'conflict_buffer',
    });
  });

  it('デバイス不健全（last_seen_at が古い）は 409 device_unhealthy', async () => {
    const repo = makeMockReservationsRepo({
      // 1時間前＝健全閾値（仮10分）超過
      spot: { id: 'spot-1', last_seen_at: new Date(Date.now() - 60 * 60_000) },
    });

    await expect(new ReservationsService(repo, fakeTxRunner).create('user-1', input)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'device_unhealthy',
    });
  });

  it('デバイス未割当（last_seen_at=null）も device_unhealthy', async () => {
    const repo = makeMockReservationsRepo({ spot: { id: 'spot-1', last_seen_at: null } });
    await expect(new ReservationsService(repo, fakeTxRunner).create('user-1', input)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
