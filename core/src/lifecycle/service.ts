import { config } from '../config.js';
import { type TxRunner, withSerializableTx } from '../db.js';
import { settleCompletion } from '../reservations/completion.js';
import type { LifecycleRepository } from './repository.js';

/**
 * 予約ライフサイクルの定期走査（タイマー）のユースケース。
 *
 * Functions のタイマートリガから {@link sweep} が呼ばれ、3 つの遷移を順に実行する:
 *   1. **detectNoShow**: reserved かつ開始＋猶予経過かつ未入庫 → no_show（区画解放）
 *   2. **detectOverstay**: active かつ終了経過かつ在車（open UsageRecord あり）→ overstay
 *   3. **autoComplete**: active/overstay かつ終了経過かつ空車 → completed＋確定料金（枠＋超過）
 *
 * ある瞬間の 1 予約はこの 3 つに同時該当しない（open UsageRecord の有無で排他）ため、実行順による
 * 二重処理は起きない。autoComplete は出庫イベント（onExitDetected）での即時確定の取りこぼし
 * （テレメトリ欠落・終了前の通常退出）の**安全網**で、同じ「条件付き UPDATE が 1 件成功時のみ
 * Fee INSERT」を踏襲するため、テレメトリと同時に走っても二重課金しない（ADR 0007）。
 *
 * @module lifecycle/service
 */

/** 1 回の走査で何件遷移したかの内訳（ログ・テスト用）。 */
export interface SweepResult {
  /** no_show へ遷移した件数。 */
  noShow: number;
  /** overstay へ遷移した件数。 */
  overstay: number;
  /**
   * completed へ確定し確定料金を INSERT した件数。
   * 完了と Fee INSERT は同一トランザクションで原子的なので「完了＝必ず課金」。別カウンターは持たない。
   */
  completed: number;
  /** autoComplete の確定に失敗した予約（1 件失敗しても走査は継続し、次走査で再試行）。 */
  failures: { reservationId: string; error: string }[];
}

export class LifecycleService {
  /**
   * @param repo ライフサイクルデータアクセス層（既定は SqlLifecycleRepository を functions 側で注入）
   * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナーに差し替え）
   */
  constructor(
    private readonly repo: LifecycleRepository,
    private readonly runTx: TxRunner = withSerializableTx,
  ) {}

  /**
   * ライフサイクルを 1 回走査し、該当予約を遷移させる。
   *
   * @param now 走査時刻（UTC）。テスト容易性と確定料金の calculated_at の一貫性のため引数で受ける
   * @returns 各遷移の件数と autoComplete の失敗内訳
   * @throws set-based の no_show/overstay 更新が DB エラーで失敗した場合（タイマーは次走査で再試行）
   */
  async sweep(now: Date): Promise<SweepResult> {
    // 1) ノーショー（set-based 一括 UPDATE）。副作用は status 変更のみ。
    const noShow = await this.repo.markNoShows(now, config.reservation.noShowGraceMinutes);

    // 2) 超過（set-based 一括 UPDATE）。
    const overstay = await this.repo.markOverstays(now);

    // 3) 自動完了。Fee 確定があるので候補を 1 件ずつ独立トランザクションで処理する。
    const candidates = await this.repo.findCompletable(now);
    let completed = 0;
    const failures: { reservationId: string; error: string }[] = [];

    for (const c of candidates) {
      try {
        // 完了確定＋料金確定は共有オーケストレーションへ（条件付き UPDATE が1件成功時のみ Fee）。
        // 同一 tx なので insertFee が throw すれば UPDATE もロールバック＝「完了したが Fee 未挿入」は
        // 構造上発生しない。テレメトリ即時確定と競合しても勝者は1つに収束する（UQ_Fee_resv）。
        const settled = await this.runTx((tx) =>
          settleCompletion(tx, this.repo, {
            reservationId: c.id,
            start: c.start_time,
            end: c.end_time,
            lastExit: c.last_exit_time,
            calculatedAt: now,
            cfg: config.reservation,
          }),
        );
        if (settled.completed) completed++;
      } catch (err) {
        // 1 件の確定失敗は走査全体を止めない（安全網なので次回走査で再試行できる）。
        // err は unknown。Error 以外（文字列 throw 等）でも message を string に保つ。
        failures.push({
          reservationId: c.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { noShow, overstay, completed, failures };
  }
}
