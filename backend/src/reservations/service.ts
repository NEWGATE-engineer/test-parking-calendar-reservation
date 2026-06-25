import { config } from '../config.js';
import { AppError, notFound } from '../http/errors.js';
import { withSerializableTx, type TxRunner } from '../db.js';
import { availabilityForSpot, isDeviceHealthy, type AvailabilityReason } from '../spots/availability.js';
import { estimateSlotFee } from './fee.js';
import type { CreateReservationInput } from './validation.js';
import type { ReservationsRepository } from './repository.js';

/**
 * 予約のユースケース。
 *
 * トランザクション境界（SERIALIZABLE）はこのサービスが所有し、その中で
 * 「区画 SELECT → 競合判定 → 条件付き INSERT」を原子的に行う。判定ロジックは
 * 純粋関数 {@link availabilityForSpot}（GET /spots/availability と共有）を再利用し、
 * 「予約可と出たのに作れない」食い違いを防ぐ。
 *
 * @module reservations/service
 */

/** POST /reservations の 201 レスポンス（OpenAPI ReservationResponse）。 */
export interface ReservationResponse {
  id: string;
  spot_id: string;
  /** ISO 8601・UTC。 */
  start_time: string;
  /** ISO 8601・UTC。 */
  end_time: string;
  status: string;
  /** ISO 8601・UTC。 */
  created_at: string;
  /** 予約枠の見込み額（円）。確定額は Fee（完了時）。 */
  estimated_slot_fee: number;
}

/**
 * availability の reason を、予約作成 API のエラー（HTTP status / code）へ変換する。
 *
 * availability と語彙をそろえつつ、API 側の code 命名（conflict_overlap / conflict_buffer）に
 * 寄せる。いずれも retryable=false（別時間・別区画の再選択を促す）。
 *
 * @param reason availabilityForSpot が返した不可理由
 * @returns 対応する {@link AppError}
 */
function conflictError(reason: AvailabilityReason): AppError {
  switch (reason) {
    // 素の時間帯重複
    case 'reserved':
      return new AppError(409, 'conflict_overlap', '指定の時間帯はすでに予約されています', false);
    // バッファ未満の近接
    case 'buffer':
      return new AppError(409, 'conflict_buffer', '前後の予約とのバッファ時間が不足しています', false);
    // デバイス不健全
    case 'device_unhealthy':
      return new AppError(409, 'device_unhealthy', 'デバイスが応答していないため予約できません', false);
    // ok は available=true 側で扱うのでここには来ないが、網羅性のため保険
    default:
      return new AppError(409, 'conflict', '予約できません', false);
  }
}

export class ReservationsService {
  /**
   * @param repo 予約データアクセス層（既定は SqlReservationsRepository を router 側で注入）
   * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナーに差し替え）
   */
  constructor(
    private readonly repo: ReservationsRepository,
    private readonly runTx: TxRunner = withSerializableTx,
  ) {}

  /**
   * 予約を作成する。
   *
   * SERIALIZABLE トランザクション内で区画存在・デバイス健全性・時間帯競合を確認し、
   * 問題なければ INSERT する。競合判定と INSERT を同一トランザクションに束ねることで、
   * 判定と書き込みの隙間に他者が割り込む TOCTOU を防ぐ（範囲排他制約は Azure SQL に無い）。
   *
   * @param userId 認証済みユーザー ID（予約の所有者）
   * @param input 検証済みの作成入力（区画・時間帯）
   * @returns 作成された予約（見込み料金つき）
   * @throws {AppError} 404 `not_found` — 区画が存在しない
   * @throws {AppError} 409 `conflict_overlap` / `conflict_buffer` / `device_unhealthy` — 競合・不健全
   */
  async create(userId: string, input: CreateReservationInput): Promise<ReservationResponse> {
    const now = new Date();
    const threshold = config.device.healthThresholdMinutes;
    const buffer = config.reservation.bufferMinutes;

    // トランザクション境界はサービスが所有し、ドメイン判断（可否）もこの中で下す。
    // repo には tx を渡すだけ。違反時は throw でロールバック（INSERT させない）。
    const created = await this.runTx(async (tx) => {
      // 1) 区画＋デバイス最終通信を取得。存在しなければ 404（他人秘匿と同じ語彙）。
      const spot = await this.repo.findSpotWithDevice(tx, input.spotId);
      if (spot === null) throw notFound('指定の区画は存在しません');

      // 2) 同一区画のバッファ込み競合を取得（SERIALIZABLE 下で範囲ロックを保持）
      const conflicts = await this.repo.findConflictsForSpot(tx, input.spotId, input.start, input.end, buffer);

      // 3) デバイス健全性＋競合から可否を判定（GET availability と同じ純粋ロジックを再利用）
      const healthy = isDeviceHealthy(spot.last_seen_at, threshold, now);
      const { available, reason } = availabilityForSpot({
        deviceHealthy: healthy,
        window: { start: input.start, end: input.end },
        conflicts,
        bufferMinutes: buffer,
      });
      if (!available) throw conflictError(reason);

      // 4) 条件を満たしたので INSERT（status は既定 'reserved'）
      return this.repo.insertReservation(tx, {
        userId,
        spotId: input.spotId,
        start: input.start,
        end: input.end,
      });
    });

    // 見込み料金は作成済みの確定時刻から算出（Fee 行はここでは作らない＝完了時のみ）
    const estimatedSlotFee = estimateSlotFee(created.start_time, created.end_time, config.reservation);
    return {
      id: created.id,
      spot_id: created.spot_id,
      start_time: created.start_time.toISOString(),
      end_time: created.end_time.toISOString(),
      status: created.status,
      created_at: created.created_at.toISOString(),
      estimated_slot_fee: estimatedSlotFee,
    };
  }
}
