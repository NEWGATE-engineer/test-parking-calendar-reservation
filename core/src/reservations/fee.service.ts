import { notFound } from '../errors.js';
import type { FeeRepository } from './fee.repository.js';

/**
 * 料金取得のユースケース（GET /reservations/{id}/fee）。
 *
 * Fee 行があればそれを返し、無ければ `status='pending'`（確定待ち）を合成して返す（OpenAPI 準拠）。
 * 他人／不在の予約は存在を秘匿して 404（403 は使わない・列挙対策）。
 *
 * @module reservations/fee.service
 */

/** 料金レスポンス（OpenAPI Fee スキーマ）。 */
export interface FeeResponse {
  reservation_id: string;
  slot_fee: number;
  overstay_fee: number;
  total: number;
  status: 'pending' | 'confirmed';
  /** ISO 8601・UTC。未確定なら null。 */
  calculated_at: string | null;
}

export class FeeService {
  /**
   * @param repo 料金データアクセス層（既定は SqlFeeRepository を router 側で注入）
   */
  constructor(private readonly repo: FeeRepository) {}

  /**
   * 予約の料金を取得する。
   *
   * @param userId 認証済みユーザー ID（所有者）
   * @param id 予約 ID
   * @returns 確定料金、または未確定時の pending
   * @throws {AppError} 404 `not_found` — 予約が存在しない／他人の予約
   */
  async get(userId: string, id: string): Promise<FeeResponse> {
    // 所有権チェック（他人・不在は 404 に集約）。
    const owned = await this.repo.reservationExistsForUser(id, userId);
    if (!owned) throw notFound('指定の予約は存在しません');

    const fee = await this.repo.findFee(id);
    if (fee === null) {
      // Fee 未記録＝完了前。pending をゼロ額で合成して返す（OpenAPI: 確定待ち）。
      return {
        reservation_id: id,
        slot_fee: 0,
        overstay_fee: 0,
        total: 0,
        status: 'pending',
        calculated_at: null,
      };
    }
    return {
      reservation_id: fee.reservation_id,
      slot_fee: fee.slot_fee,
      overstay_fee: fee.overstay_fee,
      total: fee.total,
      status: fee.status,
      calculated_at: fee.calculated_at === null ? null : fee.calculated_at.toISOString(),
    };
  }
}
