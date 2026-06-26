import { getPool } from '@parking/core';
import mssql from 'mssql';
import type { ReservationStatus } from './repository.js';

/**
 * gate-down（DOWN 指示）のデータアクセス層。SQL はすべてパラメータ化（SQLi 防止）。
 *
 * CommandLog は「要求受信時に pending を1行 INSERT → 結果で UPDATE」に統一する（F4-6）。
 * 冪等性は CommandLog.request_id の UNIQUE 制約（UQ_Cmd_request）で担保する。
 *
 * @module reservations/commandLog.repository
 */

/** gate-down の事前判定に必要なコンテキスト（予約＋区画＋デバイス）。 */
export interface GateDownContext {
  status: ReservationStatus;
  start_time: Date;
  end_time: Date;
  spot_id: string;
  /** ParkingSpot.occupancy（物理占有の事前判定に使う）。 */
  occupancy: 'occupied' | 'vacant';
  /** Device.device_id。デバイス未割当なら null。 */
  device_id: string | null;
  /** Device.last_seen_at。健全性判定に使う。未割当・未受信なら null。 */
  device_last_seen_at: Date | null;
}

/** CommandLog の結果（DDL の CK_Cmd_result に対応）。 */
export type CommandResult = 'pending' | 'success' | 'failure';

/** {@link CommandLogRepository.insertPendingCommand} の戻り値。 */
export type InsertPendingResult = { inserted: true; commandId: string } | { inserted: false };

/** gate-down データアクセスの抽象（テストではモックに差し替え）。 */
export interface CommandLogRepository {
  /**
   * gate-down の判定に使う予約コンテキストを1件取得する。存在しない・他人なら null。
   * @param reservationId 予約 ID
   * @param userId 所有者（本人のみ。他人は null＝404 扱い）
   */
  findGateDownContext(reservationId: string, userId: string): Promise<GateDownContext | null>;
  /**
   * pending の CommandLog を1行 INSERT する。
   * request_id が既出（UNIQUE 違反）なら `{ inserted: false }` を返す（＝冪等再送）。
   * @param input 予約・ユーザー・冪等キー
   */
  insertPendingCommand(input: {
    reservationId: string;
    userId: string;
    requestId: string;
  }): Promise<InsertPendingResult>;
  /**
   * 自分の request_id から既存 CommandLog を引く（冪等再送の結果再現用）。
   * 他人の request_id を推測されても結果を漏らさないよう user_id で絞る（認可）。
   * @param requestId 冪等キー
   * @param userId 所有者（本人以外の行は返さない）
   */
  findCommandByRequestId(
    requestId: string,
    userId: string,
  ): Promise<{ id: string; result: CommandResult } | null>;
  /**
   * CommandLog の結果を更新する（pending → success / failure）。
   * 現在状態 `result='pending'` を WHERE に含めた条件付き UPDATE（CLAUDE.md）。
   * @param commandId 対象 CommandLog.id
   * @param result 確定結果
   * @returns 更新できた行数（0=既に pending でなかった＝競合／二重更新）
   */
  updateCommandResult(commandId: string, result: 'success' | 'failure'): Promise<number>;
}

/**
 * SQL Server のユニーク制約違反（2627/2601）かどうかを判定する。
 * @param err catch した例外
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'number' in err &&
    ((err as { number?: unknown }).number === 2627 || (err as { number?: unknown }).number === 2601)
  );
}

/** mssql による {@link CommandLogRepository} 実装。 */
export class SqlCommandLogRepository implements CommandLogRepository {
  /** @inheritDoc */
  async findGateDownContext(
    reservationId: string,
    userId: string,
  ): Promise<GateDownContext | null> {
    const pool = await getPool();
    // デバイス未割当でも予約行は返せるよう LEFT JOIN（device_id/last_seen_at は null になり得る）。
    const result = await pool
      .request()
      .input('id', mssql.UniqueIdentifier, reservationId)
      .input('user_id', mssql.UniqueIdentifier, userId)
      .query<GateDownContext>(
        `SELECT r.status, r.start_time, r.end_time, r.spot_id,
                s.occupancy, d.device_id, d.last_seen_at AS device_last_seen_at
         FROM Reservation r
         JOIN ParkingSpot s ON s.id = r.spot_id
         LEFT JOIN Device d ON d.spot_id = r.spot_id
         WHERE r.id = @id AND r.user_id = @user_id`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async insertPendingCommand(input: {
    reservationId: string;
    userId: string;
    requestId: string;
  }): Promise<InsertPendingResult> {
    const pool = await getPool();
    try {
      // command_type は DDL の CHECK で 'DOWN' のみ、result 既定は 'pending'。
      const result = await pool
        .request()
        .input('reservation_id', mssql.UniqueIdentifier, input.reservationId)
        .input('user_id', mssql.UniqueIdentifier, input.userId)
        .input('request_id', mssql.NVarChar(100), input.requestId)
        .query<{ id: string }>(
          `INSERT INTO CommandLog (reservation_id, user_id, request_id, command_type, result)
           OUTPUT INSERTED.id
           VALUES (@reservation_id, @user_id, @request_id, 'DOWN', 'pending')`,
        );
      const id = result.recordset[0]?.id;
      if (id === undefined) throw new Error('CommandLog の INSERT で id を取得できませんでした');
      return { inserted: true, commandId: id };
    } catch (err) {
      // request_id の UNIQUE 違反＝同一送信操作の再送。冪等処理は呼び出し側に委ねる。
      if (isUniqueViolation(err)) return { inserted: false };
      throw err;
    }
  }

  /** @inheritDoc */
  async findCommandByRequestId(
    requestId: string,
    userId: string,
  ): Promise<{ id: string; result: CommandResult } | null> {
    const pool = await getPool();
    // user_id を WHERE に含めて他人の CommandLog 結果が漏れないようにする（BOLA 対策）。
    const result = await pool
      .request()
      .input('request_id', mssql.NVarChar(100), requestId)
      .input('user_id', mssql.UniqueIdentifier, userId)
      .query<{ id: string; result: CommandResult }>(
        `SELECT id, result FROM CommandLog WHERE request_id = @request_id AND user_id = @user_id`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async updateCommandResult(commandId: string, result: 'success' | 'failure'): Promise<number> {
    const pool = await getPool();
    // 現在状態 result='pending' を WHERE に含めた条件付き UPDATE（CLAUDE.md）。
    // 0件＝既に pending でない（二重更新・競合）。device_responded_at は結果確定時刻（監査用）。
    const res = await pool
      .request()
      .input('id', mssql.UniqueIdentifier, commandId)
      .input('result', mssql.VarChar(10), result)
      .query(
        `UPDATE CommandLog
         SET result = @result, device_responded_at = SYSUTCDATETIME()
         WHERE id = @id AND result = 'pending'`,
      );
    return res.rowsAffected[0] ?? 0;
  }
}
