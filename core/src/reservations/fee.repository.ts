import mssql from 'mssql';
import { getPool } from '../db.js';

/**
 * 料金取得（GET /reservations/{id}/fee）のデータアクセス層。SQL はパラメータ化。
 *
 * 単体取得系の読み取りのみでトランザクションは張らない（状態遷移が無いため）。
 *
 * @module reservations/fee.repository
 */

/** Fee 行（OpenAPI Fee スキーマ相当）。 */
export interface FeeRow {
  reservation_id: string;
  slot_fee: number;
  overstay_fee: number;
  total: number;
  status: 'pending' | 'confirmed';
  /** 確定時刻（UTC）。未確定なら null。 */
  calculated_at: Date | null;
}

/** 料金取得のデータアクセス抽象（テストではモックに差し替え）。 */
export interface FeeRepository {
  /**
   * 予約が存在し、かつ指定ユーザーの所有かを判定する。
   * @param id 予約 ID
   * @param userId 所有者
   * @returns 存在し所有していれば true（他人・不在は false → 呼び出し側で 404）
   */
  reservationExistsForUser(id: string, userId: string): Promise<boolean>;
  /**
   * 予約の確定料金（Fee 行）を取得する。未記録なら null（＝pending）。
   * @param reservationId 予約 ID
   */
  findFee(reservationId: string): Promise<FeeRow | null>;
}

/** mssql による {@link FeeRepository} 実装。 */
export class SqlFeeRepository implements FeeRepository {
  /** @inheritDoc */
  async reservationExistsForUser(id: string, userId: string): Promise<boolean> {
    const result = await new mssql.Request(await getPool())
      .input('id', mssql.UniqueIdentifier, id)
      .input('uid', mssql.UniqueIdentifier, userId)
      .query<{ one: number }>(
        `SELECT TOP 1 1 AS one FROM Reservation WHERE id = @id AND user_id = @uid`,
      );
    return result.recordset.length > 0;
  }

  /** @inheritDoc */
  async findFee(reservationId: string): Promise<FeeRow | null> {
    const result = await new mssql.Request(await getPool())
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query<FeeRow>(
        `SELECT reservation_id, slot_fee, overstay_fee, total, status, calculated_at
         FROM Fee WHERE reservation_id = @resv`,
      );
    return result.recordset[0] ?? null;
  }
}
