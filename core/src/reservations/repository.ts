import mssql from 'mssql';
import { getPool, type Tx } from '../db.js';
import type { TimeWindow } from '../spots/availability.js';

/**
 * 予約のデータアクセス層。SQL はすべてパラメータ化（SQLi 防止）。
 *
 * 競合判定を伴う操作（作成・変更）のメソッドは、呼び出し側（サービス）が張った
 * トランザクション {@link Tx} を受け取り、その中でクエリを実行する。これにより
 * 「区画 SELECT → 競合 SELECT → INSERT/UPDATE」を一つの SERIALIZABLE トランザクションに
 * 束ねられる。トランザクション境界・コミット可否の判断はサービス側が持ち、ここは
 * 純粋にデータアクセスに徹する。トランザクション不要な読み取り（一覧）や単発の状態遷移
 * （キャンセル）は共有プールを直接使う。
 *
 * @module reservations/repository
 */

/** Reservation.status の取り得る値（DDL の CK_Resv_status と一致）。 */
export const RESERVATION_STATUSES = [
  'reserved',
  'active',
  'completed',
  'cancelled',
  'no_show',
  'overstay',
] as const;

/** 予約のステータス（OpenAPI ReservationStatus と一致）。 */
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** 予約1行（一覧・変更で返す DB の生の行）。 */
export interface ReservationRow {
  id: string;
  spot_id: string;
  start_time: Date;
  end_time: Date;
  status: ReservationStatus;
  created_at: Date;
}

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
  status: ReservationStatus;
  created_at: Date;
}

/** 予約変更の条件付き UPDATE 入力（マージ後の最終値）。 */
export interface UpdateReservationInput {
  id: string;
  userId: string;
  spotId: string;
  start: Date;
  end: Date;
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
   * @param excludeReservationId 競合から除外する予約 ID（変更時に自分自身を除く。作成時は null）
   */
  findConflictsForSpot(
    tx: Tx,
    spotId: string,
    start: Date,
    end: Date,
    bufferMinutes: number,
    excludeReservationId?: string | null,
  ): Promise<TimeWindow[]>;
  /**
   * 予約を1件 INSERT し、DB 採番の id・created_at・既定 status を返す。
   * @param tx 実行中のトランザクション
   * @param input ユーザー・区画・時間帯
   */
  insertReservation(tx: Tx, input: InsertReservationInput): Promise<CreatedReservation>;
  /**
   * 自分の予約を全件（任意で status 絞り込み）取得する。新しい開始順。
   * @param userId 所有者
   * @param status 絞り込む status（省略時は全件）
   */
  listReservations(userId: string, status?: ReservationStatus): Promise<ReservationRow[]>;
  /**
   * 自分の予約を1件取得する。存在しない・他人のものなら null。
   * @param tx 実行中のトランザクション（変更時に行をロックして読むため）
   * @param id 予約 ID
   * @param userId 所有者
   */
  findOwnedReservation(tx: Tx, id: string, userId: string): Promise<ReservationRow | null>;
  /**
   * 予約を条件付き UPDATE で変更する（`status='reserved'` のときだけ）。
   * 競合再チェック後に呼ぶ前提。更新できた行数を返す（0=現在状態が変わっていた＝競合）。
   * @param tx 実行中のトランザクション
   * @param input マージ後の最終値
   * @returns 更新できた行数（0 または 1）
   */
  updateReservation(tx: Tx, input: UpdateReservationInput): Promise<number>;
  /**
   * 予約を条件付き UPDATE でキャンセルする（`status='reserved'` のときだけ）。
   * @param id 予約 ID
   * @param userId 所有者
   * @returns 取り消せた行数（0 または 1）
   */
  cancelReservation(id: string, userId: string): Promise<number>;
  /**
   * 自分の予約の現在 status を取得する（404/409 切り分け用）。存在しない・他人なら null。
   * @param id 予約 ID
   * @param userId 所有者
   */
  findOwnedStatus(id: string, userId: string): Promise<ReservationStatus | null>;
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
    excludeReservationId: string | null = null,
  ): Promise<TimeWindow[]> {
    // バッファ込みの重なり条件: start_existing < end + B AND start < end_existing + B
    // spot_id 等値があるので IX_Reservation_spot_time（先頭 spot_id）のシークが効く。
    // 変更時は自分自身を競合に含めないよう id <> @exclude で除外（@exclude が NULL なら無効化）。
    const result = await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .input('start', mssql.DateTime2(3), start)
      .input('end', mssql.DateTime2(3), end)
      .input('buf', mssql.Int, bufferMinutes)
      .input('exclude', mssql.UniqueIdentifier, excludeReservationId)
      .query<{ start_time: Date; end_time: Date }>(
        `SELECT start_time, end_time
         FROM Reservation
         WHERE spot_id = @spot_id
           AND status NOT IN ('cancelled','no_show')
           AND (@exclude IS NULL OR id <> @exclude)
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

  /** @inheritDoc */
  async listReservations(userId: string, status?: ReservationStatus): Promise<ReservationRow[]> {
    const pool = await getPool();
    // status はパラメータ。未指定（NULL）なら絞り込まない（@status IS NULL OR status = @status）。
    // user_id 等値＋start_time 順なので IX_Reservation_user が被覆シークで効く。
    const result = await pool
      .request()
      .input('user_id', mssql.UniqueIdentifier, userId)
      .input('status', mssql.VarChar(20), status ?? null)
      .query<ReservationRow>(
        `SELECT id, spot_id, start_time, end_time, status, created_at
         FROM Reservation
         WHERE user_id = @user_id
           AND (@status IS NULL OR status = @status)
         ORDER BY start_time DESC`,
      );
    return result.recordset;
  }

  /** @inheritDoc */
  async findOwnedReservation(tx: Tx, id: string, userId: string): Promise<ReservationRow | null> {
    // 変更トランザクション内で対象行を読む（SERIALIZABLE 下でロックを取得し、
    // 判定→UPDATE の間に他者が割り込めないようにする）。
    const result = await new mssql.Request(tx)
      .input('id', mssql.UniqueIdentifier, id)
      .input('user_id', mssql.UniqueIdentifier, userId)
      .query<ReservationRow>(
        `SELECT id, spot_id, start_time, end_time, status, created_at
         FROM Reservation
         WHERE id = @id AND user_id = @user_id`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async updateReservation(tx: Tx, input: UpdateReservationInput): Promise<number> {
    // 現在状態を WHERE に含めた条件付き UPDATE（status='reserved' のときだけ）。
    // 0 件＝判定後に状態が変わった＝競合（CLAUDE.md のドメイン規約）。
    const result = await new mssql.Request(tx)
      .input('id', mssql.UniqueIdentifier, input.id)
      .input('user_id', mssql.UniqueIdentifier, input.userId)
      .input('spot_id', mssql.UniqueIdentifier, input.spotId)
      .input('start', mssql.DateTime2(3), input.start)
      .input('end', mssql.DateTime2(3), input.end)
      .query(
        `UPDATE Reservation
         SET spot_id = @spot_id, start_time = @start, end_time = @end
         WHERE id = @id AND user_id = @user_id AND status = 'reserved'`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async cancelReservation(id: string, userId: string): Promise<number> {
    const pool = await getPool();
    // 状態遷移は単一の条件付き UPDATE（reserved → cancelled）。競合の範囲ロックは不要なので
    // トランザクションを張らず1文で原子的に行う。0 件＝reserved でなかった/他人/不在。
    const result = await pool
      .request()
      .input('id', mssql.UniqueIdentifier, id)
      .input('user_id', mssql.UniqueIdentifier, userId)
      .query(
        `UPDATE Reservation
         SET status = 'cancelled'
         WHERE id = @id AND user_id = @user_id AND status = 'reserved'`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async findOwnedStatus(id: string, userId: string): Promise<ReservationStatus | null> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', mssql.UniqueIdentifier, id)
      .input('user_id', mssql.UniqueIdentifier, userId)
      .query<{ status: ReservationStatus }>(
        `SELECT status FROM Reservation WHERE id = @id AND user_id = @user_id`,
      );
    return result.recordset[0]?.status ?? null;
  }
}
