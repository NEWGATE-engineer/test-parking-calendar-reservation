import mssql from 'mssql';
import type { Tx } from '../db.js';
import { type CompletionRepository, type FeeInput, SqlCompletionRepository } from './completion.js';
import type { ReservationStatus } from './repository.js';

/**
 * 利用終了申告（POST /reservations/{id}/finish）のデータアクセス層。SQL はパラメータ化。
 *
 * 状態遷移（end_time 前倒し・完了確定）はサービスが張る SERIALIZABLE トランザクション内で行う。
 * 完了確定は共有の {@link SqlCompletionRepository} に委譲する（SQL の重複を作らない・ADR 0009）。
 *
 * @module reservations/finish.repository
 */

/** finish 処理に必要な予約行。 */
export interface ReservationForFinish {
  id: string;
  spot_id: string;
  start_time: Date;
  end_time: Date;
  status: ReservationStatus;
  created_at: Date;
}

/** 利用終了申告のデータアクセス抽象（テストではモックに差し替え）。{@link CompletionRepository} を含む。 */
export interface FinishRepository extends CompletionRepository {
  /**
   * 自分の予約を1件取得する（存在しない・他人のものなら null）。SERIALIZABLE 下で行をロックして読む。
   * @param tx トランザクション
   * @param id 予約 ID
   * @param userId 所有者
   */
  findOwnedReservation(tx: Tx, id: string, userId: string): Promise<ReservationForFinish | null>;
  /**
   * end_time を「今」に前倒しする（`end_time > @now` のときだけ＝早め終了。overstay は触らない）。
   * @returns 更新行数（1=前倒しした / 0=既に過去 or 対象外）
   */
  bringForwardEndTime(tx: Tx, id: string, userId: string, now: Date): Promise<number>;
  /** その予約に open（exit_time 未記録）な UsageRecord があるか（＝まだ在車中か）。 */
  hasOpenUsage(tx: Tx, reservationId: string): Promise<boolean>;
  /** その予約の最終出庫時刻（MAX(exit_time)）。入庫記録が無ければ null。 */
  getLastExit(tx: Tx, reservationId: string): Promise<Date | null>;
}

/** mssql による {@link FinishRepository} 実装。 */
export class SqlFinishRepository implements FinishRepository {
  /** 完了確定 SQL は共有実装に委譲する（ADR 0009）。 */
  private readonly completion = new SqlCompletionRepository();

  /** @inheritDoc */
  async findOwnedReservation(
    tx: Tx,
    id: string,
    userId: string,
  ): Promise<ReservationForFinish | null> {
    const result = await new mssql.Request(tx)
      .input('id', mssql.UniqueIdentifier, id)
      .input('uid', mssql.UniqueIdentifier, userId)
      .query<ReservationForFinish>(
        `SELECT id, spot_id, start_time, end_time, status, created_at
         FROM Reservation WHERE id = @id AND user_id = @uid`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async bringForwardEndTime(tx: Tx, id: string, userId: string, now: Date): Promise<number> {
    // 早め終了のみ（end_time > now）。overstay（end が過去）は前倒し対象外＝触らない。
    const result = await new mssql.Request(tx)
      .input('id', mssql.UniqueIdentifier, id)
      .input('uid', mssql.UniqueIdentifier, userId)
      .input('now', mssql.DateTime2(3), now)
      .query(
        `UPDATE Reservation SET end_time = @now
         WHERE id = @id AND user_id = @uid
           AND status IN ('active','overstay') AND end_time > @now`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async hasOpenUsage(tx: Tx, reservationId: string): Promise<boolean> {
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query<{ one: number }>(
        `SELECT TOP 1 1 AS one FROM UsageRecord
         WHERE reservation_id = @resv AND exit_time IS NULL`,
      );
    return result.recordset.length > 0;
  }

  /** @inheritDoc */
  async getLastExit(tx: Tx, reservationId: string): Promise<Date | null> {
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query<{ last_exit: Date | null }>(
        `SELECT MAX(exit_time) AS last_exit FROM UsageRecord WHERE reservation_id = @resv`,
      );
    return result.recordset[0]?.last_exit ?? null;
  }

  /** @inheritDoc（共有の完了確定 SQL に委譲） */
  completeReservation(tx: Tx, reservationId: string): Promise<number> {
    return this.completion.completeReservation(tx, reservationId);
  }

  /** @inheritDoc（共有の Fee INSERT に委譲） */
  insertFee(tx: Tx, input: FeeInput): Promise<void> {
    return this.completion.insertFee(tx, input);
  }
}
