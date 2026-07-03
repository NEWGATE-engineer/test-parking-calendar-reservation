import mssql from 'mssql';
import type { Tx } from '../db.js';
import { type FeeInput, SqlCompletionRepository } from '../reservations/completion.js';
import type { ReservationStatus } from '../reservations/repository.js';
import type { TelemetryType } from './types.js';

/**
 * テレメトリ処理のデータアクセス層。SQL はすべてパラメータ化（SQLi 防止）。
 *
 * 状態遷移はすべて「現在状態を WHERE に含めた条件付き UPDATE」で行い、更新行数を返す。
 * 0 件＝既に遷移済み（再配信）か競合とみなし、サービスが冪等に扱う。各メソッドは
 * サービスが張った SERIALIZABLE トランザクション {@link Tx} を受け取り、その中で実行する
 * （read→write の隙間に他テレメトリ／タイマーが割り込むのを防ぐ）。
 *
 * @module telemetry/repository
 */

/** Device 行（テレメトリ処理に必要な範囲）。 */
export interface DeviceRow {
  device_id: string;
  spot_id: string;
  plate_position: 'up' | 'down';
  last_seen_at: Date | null;
}

/** 入庫時に対応づける「その区画の現予約」。 */
export interface CurrentReservation {
  id: string;
  status: ReservationStatus;
  start_time: Date;
  end_time: Date;
}

/** 出庫時に閉じる対象の open な利用記録（予約の確定料金計算に必要な期間つき）。 */
export interface OpenUsageForSpot {
  usage_id: string;
  reservation_id: string;
  reservation_start: Date;
  reservation_end: Date;
  reservation_status: ReservationStatus;
}

/** DeviceEvent INSERT の入力。 */
export interface DeviceEventInput {
  deviceId: string;
  /** 予約に紐づかないイベント（予約なし入庫・タイムアウト UP 等）は null。 */
  reservationId: string | null;
  type: TelemetryType;
  occurredAt: Date;
}

/** テレメトリ処理のデータアクセス抽象（テストではモックに差し替え）。 */
export interface TelemetryRepository {
  /** deviceId から Device を取得。未登録デバイスなら null。 */
  findDeviceById(tx: Tx, deviceId: string): Promise<DeviceRow | null>;
  /**
   * Device の最終通信時刻（と任意で生の在車状態）を更新する。全テレメトリで last_seen_at を更新（§8）。
   * @param lastOccupancy 'occupied'/'vacant' を渡すと last_occupancy も更新。null なら据え置き（up 用）。
   */
  touchDevice(
    tx: Tx,
    deviceId: string,
    lastSeenAt: Date,
    lastOccupancy: 'occupied' | 'vacant' | null,
  ): Promise<void>;
  /** 区画の確定在車状態 occupancy を設定する（表示・物理占有事前判定に使う）。 */
  setSpotOccupancy(tx: Tx, spotId: string, occupancy: 'occupied' | 'vacant'): Promise<void>;
  /**
   * 区画の「いま有効な予約」（reserved/active かつ at が期間内）を1件取得する。無ければ null。
   * 重複予約は作成時に排除済みなので該当は高々1件。
   */
  findActiveReservationForSpotAt(
    tx: Tx,
    spotId: string,
    at: Date,
  ): Promise<CurrentReservation | null>;
  /** その予約に open（exit_time 未記録）な UsageRecord があるか。入庫の冪等化に使う。 */
  hasOpenUsageRecord(tx: Tx, reservationId: string): Promise<boolean>;
  /** 入庫記録（entry_time）を1件 INSERT する。 */
  insertUsageEntry(tx: Tx, reservationId: string, entryTime: Date): Promise<void>;
  /**
   * 予約を条件付き UPDATE で reserved→active にする（初回入庫のみ）。
   * @returns 更新行数（1=遷移した / 0=既に active 等）
   */
  activateReservation(tx: Tx, reservationId: string): Promise<number>;
  /** DeviceEvent を1件記録する（監査）。 */
  insertDeviceEvent(tx: Tx, input: DeviceEventInput): Promise<void>;
  /** 区画の open な利用記録（＋予約期間）を1件取得する。無ければ null。出庫処理に使う。 */
  findOpenUsageForSpot(tx: Tx, spotId: string): Promise<OpenUsageForSpot | null>;
  /**
   * 利用記録を条件付き UPDATE で閉じる（exit_time 未記録のときだけ）。
   * @returns 更新行数（1=閉じた / 0=既に閉じている＝再配信）
   */
  closeUsageRecord(tx: Tx, usageId: string, exitTime: Date): Promise<number>;
  /** その予約の open な利用記録の件数（完了可否＝空車判定に使う）。 */
  countOpenUsageForReservation(tx: Tx, reservationId: string): Promise<number>;
  /**
   * 予約を条件付き UPDATE で completed にする（active/overstay のときだけ）。
   * @returns 更新行数（1=確定した / 0=既に確定 or 対象外）。1 のときだけ Fee を INSERT する。
   */
  completeReservation(tx: Tx, reservationId: string): Promise<number>;
  /** 確定料金を Fee に INSERT する（status='confirmed'）。completeReservation が 1 のときだけ呼ぶ。 */
  insertFee(tx: Tx, input: FeeInput): Promise<void>;
  /**
   * デバイスのロック板を条件付き UPDATE で down→up にする。
   * @returns 更新行数（1=上げた / 0=既に up）
   */
  raisePlate(tx: Tx, deviceId: string): Promise<number>;
}

/** mssql による {@link TelemetryRepository} 実装。 */
export class SqlTelemetryRepository implements TelemetryRepository {
  /** 完了確定 SQL は共有実装に委譲する（SQL の重複を作らない・ADR 0009）。 */
  private readonly completion = new SqlCompletionRepository();

  /** @inheritDoc */
  async findDeviceById(tx: Tx, deviceId: string): Promise<DeviceRow | null> {
    const result = await new mssql.Request(tx)
      .input('device_id', mssql.UniqueIdentifier, deviceId)
      .query<DeviceRow>(
        `SELECT device_id, spot_id, plate_position, last_seen_at
         FROM Device WHERE device_id = @device_id`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async touchDevice(
    tx: Tx,
    deviceId: string,
    lastSeenAt: Date,
    lastOccupancy: 'occupied' | 'vacant' | null,
  ): Promise<void> {
    // last_occupancy は値が来たときだけ更新（@occ が NULL なら現在値を維持＝up 用）。
    await new mssql.Request(tx)
      .input('device_id', mssql.UniqueIdentifier, deviceId)
      .input('seen', mssql.DateTime2(3), lastSeenAt)
      .input('occ', mssql.VarChar(20), lastOccupancy)
      .query(
        `UPDATE Device
         SET last_seen_at = @seen,
             last_occupancy = CASE WHEN @occ IS NULL THEN last_occupancy ELSE @occ END
         WHERE device_id = @device_id`,
      );
  }

  /** @inheritDoc */
  async setSpotOccupancy(tx: Tx, spotId: string, occupancy: 'occupied' | 'vacant'): Promise<void> {
    await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .input('occ', mssql.VarChar(20), occupancy)
      .query(`UPDATE ParkingSpot SET occupancy = @occ WHERE id = @spot_id`);
  }

  /** @inheritDoc */
  async findActiveReservationForSpotAt(
    tx: Tx,
    spotId: string,
    at: Date,
  ): Promise<CurrentReservation | null> {
    const result = await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .input('at', mssql.DateTime2(3), at)
      .query<CurrentReservation>(
        `SELECT TOP 1 id, status, start_time, end_time
         FROM Reservation
         WHERE spot_id = @spot_id
           AND status IN ('reserved','active')
           AND @at >= start_time AND @at <= end_time
         ORDER BY start_time ASC`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async hasOpenUsageRecord(tx: Tx, reservationId: string): Promise<boolean> {
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query<{ one: number }>(
        `SELECT TOP 1 1 AS one FROM UsageRecord
         WHERE reservation_id = @resv AND exit_time IS NULL`,
      );
    return result.recordset.length > 0;
  }

  /** @inheritDoc */
  async insertUsageEntry(tx: Tx, reservationId: string, entryTime: Date): Promise<void> {
    await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .input('entry', mssql.DateTime2(3), entryTime)
      .query(`INSERT INTO UsageRecord (reservation_id, entry_time) VALUES (@resv, @entry)`);
  }

  /** @inheritDoc */
  async activateReservation(tx: Tx, reservationId: string): Promise<number> {
    // reserved のときだけ active へ。0 件＝既に active（再配信・再入庫）。
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query(
        `UPDATE Reservation SET status = 'active'
         WHERE id = @resv AND status = 'reserved'`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async insertDeviceEvent(tx: Tx, input: DeviceEventInput): Promise<void> {
    await new mssql.Request(tx)
      .input('device_id', mssql.UniqueIdentifier, input.deviceId)
      .input('resv', mssql.UniqueIdentifier, input.reservationId)
      .input('type', mssql.VarChar(20), input.type)
      .input('at', mssql.DateTime2(3), input.occurredAt)
      .query(
        `INSERT INTO DeviceEvent (device_id, reservation_id, event_type, occurred_at)
         VALUES (@device_id, @resv, @type, @at)`,
      );
  }

  /** @inheritDoc */
  async findOpenUsageForSpot(tx: Tx, spotId: string): Promise<OpenUsageForSpot | null> {
    // TODO(次スライス add-migration): `exit_time IS NULL` と `entry_time` を被覆する索引が無く、
    // 予約履歴の増加とともに SERIALIZABLE 下のスキャン範囲＝ロック保持時間が伸び得る。
    //   CREATE INDEX IX_UsageRecord_resv_open ON UsageRecord (reservation_id, exit_time)
    //     INCLUDE (entry_time, id);
    // を別マイグレーションで追加する（本スライスは DDL 変更なしの方針・ADR 0005）。
    const result = await new mssql.Request(tx)
      .input('spot_id', mssql.UniqueIdentifier, spotId)
      .query<OpenUsageForSpot>(
        `SELECT TOP 1 u.id AS usage_id, u.reservation_id,
                r.start_time AS reservation_start, r.end_time AS reservation_end,
                r.status AS reservation_status
         FROM UsageRecord u
         JOIN Reservation r ON r.id = u.reservation_id
         WHERE r.spot_id = @spot_id AND u.exit_time IS NULL
         ORDER BY u.entry_time DESC`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async closeUsageRecord(tx: Tx, usageId: string, exitTime: Date): Promise<number> {
    // exit_time 未記録のときだけ閉じる。0 件＝既に閉じている（再配信）。
    const result = await new mssql.Request(tx)
      .input('usage_id', mssql.UniqueIdentifier, usageId)
      .input('exit', mssql.DateTime2(3), exitTime)
      .query(
        `UPDATE UsageRecord SET exit_time = @exit
         WHERE id = @usage_id AND exit_time IS NULL`,
      );
    return result.rowsAffected[0] ?? 0;
  }

  /** @inheritDoc */
  async countOpenUsageForReservation(tx: Tx, reservationId: string): Promise<number> {
    const result = await new mssql.Request(tx)
      .input('resv', mssql.UniqueIdentifier, reservationId)
      .query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM UsageRecord
         WHERE reservation_id = @resv AND exit_time IS NULL`,
      );
    return result.recordset[0]?.cnt ?? 0;
  }

  /** @inheritDoc（共有の完了確定 SQL に委譲） */
  completeReservation(tx: Tx, reservationId: string): Promise<number> {
    return this.completion.completeReservation(tx, reservationId);
  }

  /** @inheritDoc（共有の Fee INSERT に委譲） */
  insertFee(tx: Tx, input: FeeInput): Promise<void> {
    return this.completion.insertFee(tx, input);
  }

  /** @inheritDoc */
  async raisePlate(tx: Tx, deviceId: string): Promise<number> {
    // down のときだけ up へ。0 件＝既に up（再配信・冗長 up）。
    const result = await new mssql.Request(tx)
      .input('device_id', mssql.UniqueIdentifier, deviceId)
      .query(
        `UPDATE Device SET plate_position = 'up'
         WHERE device_id = @device_id AND plate_position = 'down'`,
      );
    return result.rowsAffected[0] ?? 0;
  }
}
