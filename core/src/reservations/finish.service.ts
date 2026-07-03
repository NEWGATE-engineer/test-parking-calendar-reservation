import { config } from '../config.js';
import { type TxRunner, withSerializableTx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { settleCompletion } from './completion.js';
import { estimateSlotFee } from './fee.js';
import type { FinishRepository } from './finish.repository.js';
import type { ReservationStatus } from './repository.js';
import type { ReservationResponse } from './service.js';

/**
 * 利用終了申告のユースケース（POST /reservations/{id}/finish）。
 *
 * 終了意思を受け付ける。挙動は在車状況で分岐する（処理一覧・OpenAPI）:
 * - **まだ在車中**（open な UsageRecord あり）: `end_time` を今に前倒しするだけ。completed 確定と
 *   料金確定は出庫検知（onExitDetected）の経路に合流する（在車のまま完了にしない）。
 * - **すでに空車**（open なし）: その場で完了確定＋確定料金（共有 {@link settleCompletion}）。
 *
 * 完了確定は onExitDetected / autoComplete と同一の「条件付き UPDATE が1件成功時のみ Fee」を使うので、
 * 出庫検知やタイマーと同時に走っても二重課金しない。
 *
 * @module reservations/finish.service
 */
export class FinishService {
  /**
   * @param repo 利用終了データアクセス層（既定は SqlFinishRepository を router 側で注入）
   * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナーに差し替え）
   */
  constructor(
    private readonly repo: FinishRepository,
    private readonly runTx: TxRunner = withSerializableTx,
  ) {}

  /**
   * 利用終了を申告する。
   *
   * @param userId 認証済みユーザー ID（所有者）
   * @param id 予約 ID
   * @param now 現在時刻（end_time 前倒し判定の基準。テスト容易性のため引数で受ける）
   * @returns 更新後の予約（見込み料金つき）
   * @throws {AppError} 404 `not_found` — 予約が存在しない／他人の予約
   * @throws {AppError} 409 `not_finishable` — active / overstay 以外
   */
  async finish(userId: string, id: string, now: Date = new Date()): Promise<ReservationResponse> {
    const result = await this.runTx(async (tx) => {
      // 1) 所有者付きで取得（無ければ 404）。SERIALIZABLE 下で行をロックして読む。
      const r = await this.repo.findOwnedReservation(tx, id, userId);
      if (r === null) throw notFound('指定の予約は存在しません');

      // 2) active / overstay 以外は申告不可（既に完了・キャンセル等）。
      if (r.status !== 'active' && r.status !== 'overstay') {
        throw new AppError(409, 'not_finishable', 'この予約は利用終了を申告できません', false);
      }

      // 3) end_time が未来なら今に前倒し（早め終了）。overstay（過去）は触らない。
      let effectiveEnd = r.end_time;
      if (r.end_time.getTime() > now.getTime()) {
        await this.repo.bringForwardEndTime(tx, id, userId, now);
        effectiveEnd = now;
      }

      // 4) 在車中（open UsageRecord あり）は完了しない。出庫検知で確定させる。
      //    空車なら、その場で完了確定＋確定料金（共有オーケストレーション）。
      let status: ReservationStatus = r.status;
      const parked = await this.repo.hasOpenUsage(tx, id);
      if (!parked) {
        const lastExit = await this.repo.getLastExit(tx, id);
        const settled = await settleCompletion(tx, this.repo, {
          reservationId: id,
          start: r.start_time,
          end: effectiveEnd,
          // 入庫記録が無い異常系は effectiveEnd を最終出庫とみなす（超過 0）。
          lastExit: lastExit ?? effectiveEnd,
          calculatedAt: now,
          cfg: config.reservation,
        });
        if (settled.completed) status = 'completed';
      }

      return {
        id: r.id,
        spot_id: r.spot_id,
        start_time: r.start_time,
        end_time: effectiveEnd,
        status,
        created_at: r.created_at,
        // 在車中なら完了せず終了申告のみ＝まだ在車（in_car=true）。空車なら完了済みで in_car=false。
        inCar: parked,
      };
    });

    // 見込み料金つきのレスポンスへ整形（時刻は ISO 文字列）。
    return {
      id: result.id,
      spot_id: result.spot_id,
      start_time: result.start_time.toISOString(),
      end_time: result.end_time.toISOString(),
      status: result.status,
      created_at: result.created_at.toISOString(),
      estimated_slot_fee: estimateSlotFee(result.start_time, result.end_time, config.reservation),
      in_car: result.inCar,
    };
  }
}
