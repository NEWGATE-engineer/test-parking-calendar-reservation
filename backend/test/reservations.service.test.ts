import {
  AppError,
  type CreateReservationInput,
  type ReservationPatch,
  type ReservationRow,
  ReservationsService,
} from '@parking/core';
import { describe, expect, it } from 'vitest';
import { fakeTxRunner, makeMockReservationsRepo } from './helpers/mockReservationsRepo.js';

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
      conflicts: [
        { start: new Date('2026-06-25T10:30:00Z'), end: new Date('2026-06-25T12:00:00Z') },
      ],
    });

    await expect(
      new ReservationsService(repo, fakeTxRunner).create('user-1', input),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'conflict_overlap',
      retryable: false,
    });
  });

  it('バッファ未満で近接する予約があれば 409 conflict_buffer', async () => {
    const repo = makeMockReservationsRepo({
      spot: { id: 'spot-1', last_seen_at: new Date() },
      // 09:40–09:50 終了。重ならないが開始 10:00 まで 10分（バッファ 15分未満）
      conflicts: [
        { start: new Date('2026-06-25T09:40:00Z'), end: new Date('2026-06-25T09:50:00Z') },
      ],
    });

    await expect(
      new ReservationsService(repo, fakeTxRunner).create('user-1', input),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'conflict_buffer',
    });
  });

  it('デバイス不健全（last_seen_at が古い）は 409 device_unhealthy', async () => {
    const repo = makeMockReservationsRepo({
      // 1時間前＝健全閾値（仮10分）超過
      spot: { id: 'spot-1', last_seen_at: new Date(Date.now() - 60 * 60_000) },
    });

    await expect(
      new ReservationsService(repo, fakeTxRunner).create('user-1', input),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 'device_unhealthy',
    });
  });

  it('デバイス未割当（last_seen_at=null）も device_unhealthy', async () => {
    const repo = makeMockReservationsRepo({ spot: { id: 'spot-1', last_seen_at: null } });
    await expect(
      new ReservationsService(repo, fakeTxRunner).create('user-1', input),
    ).rejects.toBeInstanceOf(AppError);
  });
});

/** reserved の所有予約1件（2099年・1時間枠）。 */
function ownedReserved(inCar = false): ReservationRow {
  return {
    id: 'resv-1',
    spot_id: 'spot-1',
    start_time: new Date('2099-06-25T10:00:00Z'),
    end_time: new Date('2099-06-25T11:00:00Z'),
    status: 'reserved',
    created_at: new Date('2026-06-25T00:00:00Z'),
    in_car: inCar,
  };
}

describe('ReservationsService.list', () => {
  it('行を ReservationResponse[]（見込み料金つき）へ整形して返す', async () => {
    const repo = makeMockReservationsRepo({ reservations: [ownedReserved()] });
    const res = await new ReservationsService(repo, fakeTxRunner).list('user-1');
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: 'resv-1', status: 'reserved', estimated_slot_fee: 200 });
    expect(res[0]?.start_time).toBe('2099-06-25T10:00:00.000Z');
  });

  it('status をリポジトリへ渡す', async () => {
    const repo = makeMockReservationsRepo({ reservations: [] });
    await new ReservationsService(repo, fakeTxRunner).list('user-1', 'cancelled');
    expect(repo.listReservations).toHaveBeenCalledWith('user-1', 'cancelled');
  });

  it('in_car を行からそのままレスポンスへ通す', async () => {
    const repo = makeMockReservationsRepo({ reservations: [ownedReserved(true)] });
    const res = await new ReservationsService(repo, fakeTxRunner).list('user-1');
    expect(res[0]?.in_car).toBe(true);
  });
});

describe('ReservationsService.update', () => {
  it('部分更新（end のみ）に成功し、見込み料金を再計算する', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(),
      spot: { id: 'spot-1', last_seen_at: new Date() },
    });
    // 10:00–12:00 へ延長 → 2時間 = 4単位 × 100 = 400
    const patch: ReservationPatch = { end: new Date('2099-06-25T12:00:00Z') };
    const res = await new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', patch);

    expect(res).toMatchObject({ id: 'resv-1', status: 'reserved', estimated_slot_fee: 400 });
    expect(res.end_time).toBe('2099-06-25T12:00:00.000Z');
    // 競合チェックは自分自身を除外して呼ぶ（第6引数に予約 ID）
    expect(repo.findConflictsForSpot).toHaveBeenCalledWith(
      expect.anything(),
      'spot-1',
      expect.any(Date),
      new Date('2099-06-25T12:00:00Z'),
      expect.any(Number),
      'resv-1',
    );
  });

  it('存在しない/他人の予約は 404', async () => {
    const repo = makeMockReservationsRepo({ owned: null });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-x', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });

  it('reserved 以外は 409 not_modifiable・UPDATE しない', async () => {
    const repo = makeMockReservationsRepo({ owned: { ...ownedReserved(), status: 'completed' } });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'not_modifiable' });
    expect(repo.updateReservation).not.toHaveBeenCalled();
  });

  it('マージ後に end<=start なら 422', async () => {
    const repo = makeMockReservationsRepo({ owned: ownedReserved() });
    // start を end と同じにして ゼロ幅へ
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        start: new Date('2099-06-25T11:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'validation_error' });
  });

  it('変更後の時間帯が重複すれば 409 conflict_overlap', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(),
      spot: { id: 'spot-1', last_seen_at: new Date() },
      conflicts: [
        { start: new Date('2099-06-25T11:30:00Z'), end: new Date('2099-06-25T13:00:00Z') },
      ],
    });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'conflict_overlap' });
  });

  it('条件付き UPDATE が 0 件なら 409 not_modifiable（競合）', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(),
      spot: { id: 'spot-1', last_seen_at: new Date() },
      updateRows: 0,
    });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'not_modifiable' });
  });

  it('マージ後に start が過去日時なら 422・UPDATE しない', async () => {
    const repo = makeMockReservationsRepo({ owned: ownedReserved() });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        start: new Date('2000-01-01T10:00:00Z'),
        end: new Date('2000-01-01T11:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'validation_error' });
    expect(repo.updateReservation).not.toHaveBeenCalled();
  });

  it('デバイス不健全なら 409 device_unhealthy・UPDATE しない', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(),
      // 1時間前＝健全閾値（仮10分）超過
      spot: { id: 'spot-1', last_seen_at: new Date(Date.now() - 60 * 60_000) },
    });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'device_unhealthy' });
    expect(repo.updateReservation).not.toHaveBeenCalled();
  });

  it('変更後がバッファ未満で近接すれば 409 conflict_buffer', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(),
      spot: { id: 'spot-1', last_seen_at: new Date() },
      // 12:10–13:00 開始。延長後 10:00–12:00 の直後 10分（バッファ 15分未満）
      conflicts: [
        { start: new Date('2099-06-25T12:10:00Z'), end: new Date('2099-06-25T13:00:00Z') },
      ],
    });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        end: new Date('2099-06-25T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'conflict_buffer' });
  });

  it('spot_id のみ変更で 200・新区画で競合チェック＋新区画値で UPDATE', async () => {
    const repo = makeMockReservationsRepo({
      owned: ownedReserved(), // spot_id = 'spot-1'
      spot: { id: 'spot-2', last_seen_at: new Date() },
    });
    const res = await new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
      spotId: 'spot-2',
    });

    expect(res.spot_id).toBe('spot-2');
    // 競合チェックは新区画＋自分除外で呼ぶ
    expect(repo.findConflictsForSpot).toHaveBeenCalledWith(
      expect.anything(),
      'spot-2',
      expect.any(Date),
      expect.any(Date),
      expect.any(Number),
      'resv-1',
    );
    // 条件付き UPDATE にも新区画・据え置きの時刻が渡る
    expect(repo.updateReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'resv-1',
        userId: 'user-1',
        spotId: 'spot-2',
        start: new Date('2099-06-25T10:00:00Z'),
        end: new Date('2099-06-25T11:00:00Z'),
      }),
    );
  });

  it('変更先の区画が存在しない場合は 404・UPDATE しない', async () => {
    // 予約自体は存在する（owned あり）が、変更先 spot が DB に無い分岐
    const repo = makeMockReservationsRepo({ owned: ownedReserved(), spot: null });
    await expect(
      new ReservationsService(repo, fakeTxRunner).update('user-1', 'resv-1', {
        spotId: '99999999-9999-9999-9999-999999999999',
      }),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
    expect(repo.updateReservation).not.toHaveBeenCalled();
  });
});

describe('ReservationsService.cancel', () => {
  it('reserved の予約を取り消せる（1件成功）', async () => {
    const repo = makeMockReservationsRepo({ cancelRows: 1 });
    await expect(
      new ReservationsService(repo, fakeTxRunner).cancel('user-1', 'resv-1'),
    ).resolves.toBeUndefined();
    expect(repo.cancelReservation).toHaveBeenCalledWith('resv-1', 'user-1');
  });

  it('0 件かつ存在しなければ 404', async () => {
    const repo = makeMockReservationsRepo({ cancelRows: 0, ownedStatus: null });
    await expect(
      new ReservationsService(repo, fakeTxRunner).cancel('user-1', 'resv-x'),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });

  it('0 件かつ reserved 以外なら 409 not_cancelable', async () => {
    const repo = makeMockReservationsRepo({ cancelRows: 0, ownedStatus: 'active' });
    await expect(
      new ReservationsService(repo, fakeTxRunner).cancel('user-1', 'resv-1'),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'not_cancelable' });
  });

  it('AppError 型で投げる', async () => {
    const repo = makeMockReservationsRepo({ cancelRows: 0, ownedStatus: null });
    await expect(
      new ReservationsService(repo, fakeTxRunner).cancel('user-1', 'x'),
    ).rejects.toBeInstanceOf(AppError);
  });
});
