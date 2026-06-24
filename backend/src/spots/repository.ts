import mssql from 'mssql';
import { getPool } from '../db.js';

/**
 * 区画・満空のデータアクセス層。SQL はすべてパラメータ化（SQLi 防止）。
 *
 * @module spots/repository
 */

/** 区画＋紐づくデバイスの最終通信（健全性判定用）。 */
export interface SpotWithDevice {
  id: string;
  name: string;
  /** ParkingSpot.occupancy。DB の CHECK 制約 IN ('occupied','vacant') に対応（unknown は持たない）。 */
  occupancy: 'occupied' | 'vacant';
  /** Device.last_seen_at。デバイス未割当やテレメトリ未受信なら null。 */
  last_seen_at: Date | null;
}

/** availability 算出に使う、ある区画の有効予約の時間帯。 */
export interface ReservationWindow {
  spot_id: string;
  start_time: Date;
  end_time: Date;
}

/** 区画データアクセスの抽象（テストではモックに差し替え）。 */
export interface SpotsRepository {
  /** 全区画とデバイス最終通信を取得。 */
  listSpotsWithDevice(): Promise<SpotWithDevice[]>;
  /**
   * 指定時間帯にバッファ込みで近接する「有効な予約」を取得する（availability/競合判定用）。
   * cancelled / no_show は除外。重なり・バッファ近接の両方を含む superset を返し、分類は呼び出し側で行う。
   * @param start 希望開始（UTC）
   * @param end 希望終了（UTC）
   * @param bufferMinutes バッファ B（分）
   */
  findActiveReservationsInWindow(start: Date, end: Date, bufferMinutes: number): Promise<ReservationWindow[]>;
}

/** mssql による {@link SpotsRepository} 実装。 */
export class SqlSpotsRepository implements SpotsRepository {
  /** @inheritDoc */
  async listSpotsWithDevice(): Promise<SpotWithDevice[]> {
    const pool = await getPool();
    // 区画は必ず返し、デバイス未割当でも last_seen_at=null で扱えるよう LEFT JOIN
    const result = await pool.request().query<SpotWithDevice>(
      `SELECT s.id, s.name, s.occupancy, d.last_seen_at
       FROM ParkingSpot s
       LEFT JOIN Device d ON d.spot_id = s.id
       ORDER BY s.name`,
    );
    return result.recordset;
  }

  /** @inheritDoc */
  async findActiveReservationsInWindow(
    start: Date,
    end: Date,
    bufferMinutes: number,
  ): Promise<ReservationWindow[]> {
    const pool = await getPool();
    // バッファ込みの重なり条件: start < end_existing + B AND start_existing < end + B
    // （DATEADD でバッファを両端に広げて判定）。全区画一括＝spot_id 等値が無いため
    // 先頭キー spot_id の IX_Reservation_spot_time は効かず、IX_Reservation_availability
    // （先頭 start_time・migrations/002）の range シークが効く。
    const result = await pool
      .request()
      .input('start', mssql.DateTime2(3), start)
      .input('end', mssql.DateTime2(3), end)
      .input('buf', mssql.Int, bufferMinutes)
      .query<ReservationWindow>(
        `SELECT spot_id, start_time, end_time
         FROM Reservation
         WHERE status NOT IN ('cancelled','no_show')
           AND start_time < DATEADD(MINUTE, @buf, @end)
           AND @start    < DATEADD(MINUTE, @buf, end_time)`,
      );
    return result.recordset;
  }
}
