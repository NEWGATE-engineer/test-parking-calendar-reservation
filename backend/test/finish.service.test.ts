import { FinishService } from '@parking/core';
import { describe, expect, it } from 'vitest';
import { defaultFinishReservation, makeMockFinishRepo } from './helpers/mockFinish.js';
import { fakeTxRunner } from './helpers/mockReservationsRepo.js';

/**
 * FinishService.finish の分岐を DB なしで検証する（mock repo＋偽 tx ランナー）。
 * now を引数で固定して end_time 前倒しの有無を決める。予約は 10:00-12:00。
 */

const NOW = new Date('2026-06-25T11:00:00Z'); // 予約 10:00-12:00 の途中

describe('FinishService.finish', () => {
  it('不在/他人 → 404 not_found', async () => {
    const repo = makeMockFinishRepo({ reservation: null });
    await expect(
      new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });

  it('active/overstay 以外 → 409 not_finishable', async () => {
    const repo = makeMockFinishRepo({
      reservation: { ...defaultFinishReservation(), status: 'completed' },
    });
    await expect(
      new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'not_finishable' });
  });

  it('在車中（open あり）: end_time を前倒しし、完了はしない', async () => {
    const repo = makeMockFinishRepo({ hasOpen: true });
    const res = await new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW);

    // end が未来（12:00 > 11:00）なので前倒しが呼ばれ、end は now に
    expect(repo.bringForwardEndTime).toHaveBeenCalled();
    expect(res.end_time).toBe(NOW.toISOString());
    // 在車中は完了しない
    expect(repo.completeReservation).not.toHaveBeenCalled();
    expect(res.status).toBe('active');
    expect(res.in_car).toBe(true); // まだ在車＝出庫後に完了する
  });

  it('空車（open なし）: 完了確定＋Fee を INSERT', async () => {
    const repo = makeMockFinishRepo({ hasOpen: false, completeRows: 1 });
    const res = await new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW);

    expect(repo.completeReservation).toHaveBeenCalled();
    expect(repo.insertFee).toHaveBeenCalled();
    expect(res.status).toBe('completed');
    expect(res.in_car).toBe(false); // 出庫済みで完了
  });

  it('空車だが競合負け（completeRows=0）: Fee を入れず status 据え置き', async () => {
    const repo = makeMockFinishRepo({ hasOpen: false, completeRows: 0 });
    const res = await new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW);

    expect(repo.insertFee).not.toHaveBeenCalled();
    expect(res.status).toBe('active'); // 完了できなかった
  });

  it('overstay（end 過去）: 前倒しせず、空車なら超過込みで確定', async () => {
    // end 10:30 は now(11:00) より過去 → 前倒し対象外。最終出庫 11:30 で超過あり。
    const repo = makeMockFinishRepo({
      reservation: {
        ...defaultFinishReservation(),
        status: 'overstay',
        end_time: new Date('2026-06-25T10:30:00Z'),
      },
      hasOpen: false,
      lastExit: new Date('2026-06-25T11:30:00Z'),
    });
    const res = await new FinishService(repo, fakeTxRunner).finish('u1', 'r1', NOW);

    expect(repo.bringForwardEndTime).not.toHaveBeenCalled();
    expect(res.end_time).toBe(new Date('2026-06-25T10:30:00Z').toISOString());
    const feeArg = repo.insertFee.mock.calls[0][1];
    expect(feeArg.overstayFee).toBeGreaterThan(0); // 10:30→11:30 の超過
    expect(res.status).toBe('completed');
  });
});
