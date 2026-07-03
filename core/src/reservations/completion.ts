import mssql from 'mssql';
import type { Tx } from '../db.js';
import { computeCompletionFee, type OverstayFeeConfig, type SlotFeeConfig } from './fee.js';

/**
 * 予約の「完了確定＋確定料金の記録」を共有する。
 *
 * この操作は3つの経路で必要になる — 出庫検知（telemetry の onExitDetected）・タイマー
 * （lifecycle の autoComplete）・利用終了申告（finish の空車ブランチ）。SQL とオーケストレーションを
 * ここ1箇所に集約し、重複（同じ UPDATE / INSERT を各所に書く）を排除する（ADR 0009）。
 *
 * 中核ルール（CLAUDE.md）: **完了は「現在状態を WHERE に含めた条件付き UPDATE が1件成功した
 * ときだけ」Fee を INSERT する**。これで `UQ_Fee_resv`（予約ごと一意）違反と「completed だが料金なし」を
 * 同時に防ぎ、複数経路が同じ予約を同時に確定しても勝者1つに収束する（二重課金しない）。
 *
 * @module reservations/completion
 */

/** Fee INSERT の入力（確定料金）。 */
export interface FeeInput {
  reservationId: string;
  slotFee: number;
  overstayFee: number;
  calculatedAt: Date;
}

/** 完了確定に必要な最小のデータアクセス（telemetry/lifecycle/finish の各 repo が満たす）。 */
export interface CompletionRepository {
  /**
   * 予約を条件付き UPDATE で completed にする（active/overstay のときだけ）。
   * @param tx サービスが張った SERIALIZABLE トランザクション
   * @param reservationId 対象予約 ID
   * @returns 更新行数（1=確定した勝者 / 0=既に確定 or 対象外）。1 のときだけ Fee を INSERT する。
   */
  completeReservation(tx: Tx, reservationId: string): Promise<number>;
  /**
   * 確定料金を Fee に INSERT する（status='confirmed'）。completeReservation が 1 のときだけ呼ぶ。
   * @param tx サービスが張った SERIALIZABLE トランザクション
   * @param input 確定料金（予約 ID・枠/超過・算出時刻）
   */
  insertFee(tx: Tx, input: FeeInput): Promise<void>;
}

/** {@link settleCompletion} の入力。 */
export interface SettleCompletionParams {
  reservationId: string;
  /** 予約開始（UTC）。枠料金の算出に使う。 */
  start: Date;
  /** 予約終了（UTC）。超過料金の基準。 */
  end: Date;
  /** 最終出庫時刻（UTC）。超過 = max(0, lastExit − end)。 */
  lastExit: Date;
  /** Fee.calculated_at に入れる算出時刻。 */
  calculatedAt: Date;
  /** 単価・課金単位（`config.reservation`）。 */
  cfg: SlotFeeConfig & OverstayFeeConfig;
}

/**
 * 完了確定＋確定料金の記録を1トランザクション内で行う共有オーケストレーション。
 *
 * 条件付き UPDATE（active/overstay→completed）が1件成功した勝者だけが Fee を INSERT する。
 * 0件（既に確定・対象外）なら Fee は作らない。
 *
 * @param tx サービスが張った SERIALIZABLE トランザクション
 * @param repo 完了データアクセス（{@link CompletionRepository}）
 * @param params 予約 ID・期間・最終出庫・算出時刻・料金設定
 * @returns `completed`（この呼び出しで確定した＝Fee を入れた勝者なら true）
 */
export async function settleCompletion(
  tx: Tx,
  repo: CompletionRepository,
  params: SettleCompletionParams,
): Promise<{ completed: boolean }> {
  const rows = await repo.completeReservation(tx, params.reservationId);
  if (rows !== 1) return { completed: false };
  const fee = computeCompletionFee(params.start, params.end, params.lastExit, params.cfg);
  await repo.insertFee(tx, {
    reservationId: params.reservationId,
    slotFee: fee.slotFee,
    overstayFee: fee.overstayFee,
    calculatedAt: params.calculatedAt,
  });
  return { completed: true };
}

/**
 * mssql による {@link CompletionRepository} 実装（完了確定 SQL の唯一の置き場）。
 *
 * telemetry / lifecycle / finish の各 SqlXxxRepository はこれを内部に持ち、
 * `completeReservation` / `insertFee` を委譲する（SQL の重複を作らない）。
 */
export class SqlCompletionRepository implements CompletionRepository {
  /** @inheritDoc */
  async completeReservation(tx: Tx, reservationId: string): Promise<number> {
    // active/overstay のときだけ completed へ。0 件＝既に確定 or 対象外（二重確定防止）。
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query(
        `UPDATE Reservation SET status = 'completed'
         WHERE id = @resv AND status IN ('active','overstay')`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async insertFee(tx: Tx, input: FeeInput): Promise<void> {
    // total は計算列。UQ_Fee_resv があるため completeReservation が 1 を返した勝者だけが到達する。
    await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, input.reservationId)
      .input('slot', mssql.Decimal(10, 2), input.slotFee)
      .input('over', mssql.Decimal(10, 2), input.overstayFee)
      .input('calc', mssql.DateTime2(3), input.calculatedAt)
      .query(
        `INSERT INTO Fee (reservation_id, slot_fee, overstay_fee, status, calculated_at)
         VALUES (@resv, @slot, @over, 'confirmed', @calc)`,
      );
  }
}
