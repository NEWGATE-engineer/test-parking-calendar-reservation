import { LifecycleService } from '@parking/core';
import { describe, expect, it } from 'vitest';
import { completable, makeMockLifecycleRepo } from './helpers/mockLifecycleRepo.js';
import { fakeTxRunner } from './helpers/mockReservationsRepo.js';

/**
 * LifecycleService.sweep の検証。DB なしでモック repo＋偽 tx ランナーを注入し、
 * 3 遷移の実行・件数集約・autoComplete の Fee 確定（勝者のみ）・失敗継続を確認する。
 *
 * 仮の料金設定（config 既定）: 枠 100円/30分・超過 100円/30分。予約枠は 10:00-11:00（60分）= 200円。
 */

const NOW = new Date('2026-06-25T12:00:00Z');

describe('LifecycleService.sweep', () => {
  it('該当なし: 全件 0・候補空でも例外なく 0 件を返す', async () => {
    const repo = makeMockLifecycleRepo();
    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    expect(result).toEqual({ noShow: 0, overstay: 0, completed: 0, feesInserted: 0, failures: [] });
    // 走査順: noShow → overstay → completable
    expect(repo.markNoShows).toHaveBeenCalledOnce();
    expect(repo.markOverstays).toHaveBeenCalledOnce();
    expect(repo.findCompletable).toHaveBeenCalledOnce();
  });

  it('noShow / overstay の set-based 件数をそのまま集約する', async () => {
    const repo = makeMockLifecycleRepo({ noShowRows: 3, overstayRows: 2 });
    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    expect(result.noShow).toBe(3);
    expect(result.overstay).toBe(2);
    // ノーショー猶予が markNoShows に渡る（config 既定 30分）
    expect(repo.markNoShows).toHaveBeenCalledWith(NOW, 30);
  });

  it('autoComplete: 勝者は completed＋Fee を確定する（終了後の通常退出＝超過0）', async () => {
    // 最終出庫 10:30（終了 11:00 より前）→ 超過 0・枠のみ 200円
    const repo = makeMockLifecycleRepo({
      completable: [completable('resv-1', new Date('2026-06-25T10:30:00Z'))],
      completeRows: 1,
    });
    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    expect(result.completed).toBe(1);
    expect(result.feesInserted).toBe(1);
    const feeArg = repo.insertFee.mock.calls[0][1];
    expect(feeArg).toMatchObject({
      reservationId: 'resv-1',
      slotFee: 200,
      overstayFee: 0,
      calculatedAt: NOW,
    });
  });

  it('autoComplete: 超過退出は枠＋超過を確定する', async () => {
    // 最終出庫 11:45（終了 11:00 から 45分超過）→ 超過 2単位 = 200円・枠 200円
    const repo = makeMockLifecycleRepo({
      completable: [completable('resv-1', new Date('2026-06-25T11:45:00Z'))],
    });
    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    const feeArg = repo.insertFee.mock.calls[0][1];
    expect(feeArg).toMatchObject({ slotFee: 200, overstayFee: 200 });
    expect(result.feesInserted).toBe(1);
  });

  it('autoComplete: 競合負け（completeReservation=0）は Fee を INSERT しない', async () => {
    const repo = makeMockLifecycleRepo({
      completable: [completable('resv-1', new Date('2026-06-25T10:30:00Z'))],
      completeRows: 0, // 既にテレメトリ即時確定が勝っている
    });
    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    expect(result.completed).toBe(0);
    expect(result.feesInserted).toBe(0);
    expect(repo.insertFee).not.toHaveBeenCalled();
  });

  it('autoComplete: 1件失敗しても走査は継続し failures に積む', async () => {
    const repo = makeMockLifecycleRepo({
      completable: [
        completable('resv-ng', new Date('2026-06-25T10:30:00Z')),
        completable('resv-ok', new Date('2026-06-25T10:30:00Z')),
      ],
    });
    // resv-ng の確定だけ失敗させる
    repo.completeReservation.mockImplementation((_tx: unknown, id: string) => {
      if (id === 'resv-ng') return Promise.reject(new Error('deadlock'));
      return Promise.resolve(1);
    });

    const result = await new LifecycleService(repo, fakeTxRunner).sweep(NOW);

    expect(result.completed).toBe(1);
    expect(result.feesInserted).toBe(1);
    expect(result.failures).toEqual([{ reservationId: 'resv-ng', error: 'deadlock' }]);
  });
});
