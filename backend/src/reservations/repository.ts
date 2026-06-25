import mssql from 'mssql';
import type { Tx } from '../db.js';
import type { TimeWindow } from '../spots/availability.js';

/**
 * 予約のデータアクセス層。SQL はすべてパラメータ化（SQLi 防止）。
 *
 * 各メソッドは呼び出し側（サービス）が張ったトランザクション {@link Tx} を受け取り、
 * その中でクエリを実行する。これにより「区画 SELECT → 競合 SELECT → INSERT」を
 * 一つの SERIALIZABLE トランザクションに束ねられる。トランザクション境界・コミット可否の
 * 判断はサービス側が持ち、ここは純粋にデータアクセスに徹する。
 *
 * @module reservations/repository
 */

/** 予約作成の競合判定に必要な区画情報（デバイス健全性の素材）。 */
export interface SpotForReservation {
  id: string;
  /** Device.last_seen_at。デバイス未割当やテレメトリ未受信なら null。 */
  last_seen_at: Date | null;
}

/** 予約 INSERT の入力。 */
export interface InsertReservationInput {
  userId: string;
  spotId: string;
  start: Date;
  end: Date;
}

/** INSERT 後に DB から返る予約行（DB 採番の id・created_at・既定 status を含む）。 */
export interface CreatedReservation {
  id: string;
  spot_id: string;
  start_time: Date;
  end_time: Date;
  status: string;
  created_at: Date;
}

/** 予約データアクセスの抽象（テストではモックに差し替え）。 */
export interface ReservationsRepository {
  /**
   * 区画とそのデバイス最終通信を1件取得する。存在しなければ null。
   * @param tx 実行中のトランザクション
   * @param spotId 区画 ID
   */
  findSpotWithDevice(tx: Tx, spotId: string): Promise<SpotForReservation | null>;
  /**
   * 指定区画の、希望時間帯にバッファ込みで近接する「有効な予約」を取得する。
   * cancelled / no_show は除外。重なり・バッファ近接の両方を含む superset を返し、
   * 重複/近接の分類は呼び出し側（availabilityForSpot）で行う。
   * @param tx 実行中のトランザクション（SERIALIZABLE 下で範囲ロックを保持させる）
   * @param spotId 区画 ID
   * @param start 希望開始（UTC）
   * @param end 希望終了（UTC）
   * @param bufferMinutes バッファ B（分）
   */
  findConflictsForSpot(
    tx: Tx,
    spotId: string,
    start: Date,
    end: Date,
    bufferMinutes: number,
  ): Promise<TimeWindow[]>;
  /**
   * 予約を1件 INSERT し、DB 採番の id・created_at・既定 status を返す。
   * @param tx 実行中のトランザクション
   * @param input ユーザー・区画・時間帯
   */
  insertReservation(tx: Tx, input: InsertReservationInput): Promise<CreatedReservation>;
}

/** mssql による {@link ReservationsRepository} 実装。 */
export class SqlReservationsRepository implements ReservationsRepository {
  /** @inheritDoc */
  async findSpotWithDevice(tx: Tx, spotId: string): Promise<SpotForReservation | null> {
    // デバイス未割当でも区画行は返せるよう LEFT JOIN（last_seen_at は null になり得る）
    const result = await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .query<SpotForReservation>(
        `SELECT s.id, d.last_seen_at
         FROM ParkingSpot s
         LEFT JOIN Device d ON d.spot_id = s.id
         WHERE s.id = @spot_id`,
      );
    // noUncheckedIndexedAccess 対策で ?? null に正規化
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async findConflictsForSpot(
    tx: Tx,
    spotId: string,
    start: Date,
    end: Date,
    bufferMinutes: number,
  ): Promise<TimeWindow[]> {
    // バッファ込みの重なり条件: start_existing < end + B AND start < end_existing + B
    // spot_id 等値があるので IX_Reservation_spot_time（先頭 spot_id）のシークが効く。
    const result = await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .input('start', mssql.DateTime2(3), start)
      .input('end', mssql.DateTime2(3), end)
      .input('buf', mssql.Int, bufferMinutes)
      .query<{ start_time: Date; end_time: Date }>(
        `SELECT start_time, end_time
         FROM Reservation
         WHERE spot_id = @spot_id
           AND status NOT IN ('cancelled','no_show')
           AND start_time < DATEADD(MINUTE, @buf, @end)
           AND @start    < DATEADD(MINUTE, @buf, end_time)`,
      );
    // availabilityForSpot が期待する TimeWindow（start/end）へ写像
    return result.recordset.map((r) => ({ start: r.start_time, end: r.end_time }));
  }

  /** @inheritDoc */
  async insertReservation(tx: Tx, input: InsertReservationInput): Promise<CreatedReservation> {
    // status は DDL の既定 'reserved'、created_at は SYSUTCDATETIME() を DB 側で採番。
    // OUTPUT INSERTED.* でその値をその場で受け取り、追加 SELECT を避ける。
    const result = await new mssql.Request(tx)
      .input('user_id', mssql.UniqueIdentifier, input.userId)
      .input('spot_id', mssql.UniqueIdentifier, input.spotId)
      .input('start', mssql.DateTime2(3), input.start)
      .input('end', mssql.DateTime2(3), input.end)
      .query<CreatedReservation>(
        `INSERT INTO Reservation (user_id, spot_id, start_time, end_time)
         OUTPUT INSERTED.id, INSERTED.spot_id, INSERTED.start_time, INSERTED.end_time,
                INSERTED.status, INSERTED.created_at
         VALUES (@user_id, @spot_id, @start, @end)`,
      );
    const row = result.recordset[0];
    if (row === undefined) {
      throw new Error('Reservation の INSERT で行を取得できませんでした');
    }
    return row;
  }
}
