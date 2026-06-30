import mssql from 'mssql';
import { getPool, type Tx } from '../db.js';

/**
 * 予約ライフサイクルの定期走査（タイマー）のデータアクセス層。SQL はすべてパラメータ化。
 *
 * 状態遷移はすべて「現在状態を WHERE に含めた条件付き UPDATE」で行う（CLAUDE.md・ADR 0007）:
 * - **detectNoShow / detectOverstay** は副作用が status 変更だけなので **set-based の一括 UPDATE**
 *   （該当全行を1文で遷移）。更新行数を返す。
 * - **autoComplete** は予約ごとに確定料金（枠＋超過）を Fee へ INSERT する必要があるため、
 *   候補を {@link findCompletable} で抽出し、サービスが1件ずつトランザクションで確定する。
 *
 * `completeReservation` / `insertFee` はテレメトリの出庫確定（onExitDetected）と**同一の共有
 * ドメイン操作**（同じ SQL）。タイマーはイベント欠落時の安全網としてこれを再実行する。両者は
 * 条件付き UPDATE（`WHERE status IN ('active','overstay')`）＋ `UQ_Fee_resv` で、同時に走っても
 * 勝者1件だけが Fee を INSERT する（二重課金しない）。将来 `reservations/` 配下の completion repo へ
 * 抽出する候補だが、MVP は重複を許容する。
 *
 * @module lifecycle/repository
 */

/** Fee INSERT の入力（完了確定時）。telemetry の FeeInput と同形。 */
export interface FeeInput {
  reservationId: string;
  slotFee: number;
  overstayFee: number;
  calculatedAt: Date;
}

/** autoComplete の完了候補（確定料金の計算に必要な期間と最終出庫つき）。 */
export interface CompletableReservation {
  id: string;
  start_time: Date;
  end_time: Date;
  /**
   * その予約の最終出庫時刻（MAX(exit_time)）。候補は「open な UsageRecord が無い＝全て閉じている」
   * ものに限るため必ず非 null。超過料金は max(0, last_exit − end) で算出する。
   */
  last_exit_time: Date;
}

/** ライフサイクル走査のデータアクセス抽象（テストではモックに差し替え）。 */
export interface LifecycleRepository {
  /**
   * ノーショー確定（set-based）。`reserved` かつ「開始＋猶予」を経過し、その予約の UsageRecord が
   * 一度も無い予約を一括で `no_show` にする（区画は入庫が無いため occupancy は触らない）。
   *
   * @param now 走査時刻（UTC）
   * @param graceMinutes 開始からの猶予（分）
   * @returns no_show へ遷移した行数
   */
  markNoShows(now: Date, graceMinutes: number): Promise<number>;
  /**
   * 超過確定（set-based）。`active` かつ終了時刻を経過し、open（exit_time 未記録）な UsageRecord が
   * 残る（＝在車中のまま終了を超えた）予約を一括で `overstay` にする。
   *
   * @param now 走査時刻（UTC）
   * @returns overstay へ遷移した行数
   */
  markOverstays(now: Date): Promise<number>;
  /**
   * 完了候補を抽出する。`active`/`overstay` かつ終了時刻を経過し、open な UsageRecord が無い
   * （＝出庫済みだが完了未確定）予約。出庫イベントでの即時確定の取りこぼし（テレメトリ欠落・
   * 通常退出＝終了前に出庫）の安全網。
   *
   * @param now 走査時刻（UTC）
   * @returns 完了候補（最終出庫つき）
   */
  findCompletable(now: Date): Promise<CompletableReservation[]>;
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

/** mssql による {@link LifecycleRepository} 実装。 */
export class SqlLifecycleRepository implements LifecycleRepository {
  /** @inheritDoc */
  async markNoShows(now: Date, graceMinutes: number): Promise<number> {
    // set-based: reserved かつ 開始+猶予 経過 かつ UsageRecord 無 を一括 no_show。
    // フィルタ索引 IX_Reservation_noshow (start_time) WHERE status='reserved' を利用。
    const result = await new mssql.Request(await getPool())
      .input('now', mssql.DateTime2(3), now)
      .input('grace', mssql.Int, graceMinutes)
      .query(
        // start_time に関数を当てると索引シークが効かない（non-sargable）。@now 側を変換して
        // 「start_time < now - 猶予」の形にし、IX_Reservation_noshow のシークを効かせる。
        `UPDATE Reservation SET status = 'no_show'
         WHERE status = 'reserved'
           AND start_time < DATEADD(MINUTE, -@grace, @now)
           AND NOT EXISTS (
             SELECT 1 FROM UsageRecord u WHERE u.reservation_id = Reservation.id
           )`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async markOverstays(now: Date): Promise<number> {
    // set-based: active かつ 終了経過 かつ open UsageRecord あり を一括 overstay。
    // フィルタ索引 IX_Reservation_overstay (end_time) WHERE status='active' を利用。
    const result = await new mssql.Request(await getPool())
      .input('now', mssql.DateTime2(3), now)
      .query(
        `UPDATE Reservation SET status = 'overstay'
         WHERE status = 'active'
           AND end_time < @now
           AND EXISTS (
             SELECT 1 FROM UsageRecord u
             WHERE u.reservation_id = Reservation.id AND u.exit_time IS NULL
           )`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async findCompletable(now: Date): Promise<CompletableReservation[]> {
    // active/overstay かつ 終了経過 かつ open 無し。最終出庫 MAX(exit_time) も取得。
    // active は IX_Reservation_overstay で絞れるが overstay 分は索引外スキャンになり得る
    // （通常 overstay→completed は onExitDetected が即時確定するため候補は稀。ADR 0007 フォローアップ）。
    const result = await new mssql.Request(await getPool())
      .input('now', mssql.DateTime2(3), now)
      .query<CompletableReservation>(
        `SELECT r.id, r.start_time, r.end_time, MAX(u.exit_time) AS last_exit_time
         FROM Reservation r
         JOIN UsageRecord u ON u.reservation_id = r.id
         WHERE r.status IN ('active','overstay')
           AND r.end_time < @now
         GROUP BY r.id, r.start_time, r.end_time
         HAVING COUNT(CASE WHEN u.exit_time IS NULL THEN 1 END) = 0`,
      );
    return result.recordset;
  }

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
