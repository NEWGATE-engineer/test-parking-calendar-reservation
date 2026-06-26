import { config } from '@parking/core';
import { type AvailabilityReason, availabilityForSpot, isDeviceHealthy } from './availability.js';
import type { ReservationWindow, SpotsRepository } from './repository.js';

/**
 * 区画・満空・予約可否のユースケース。
 *
 * @module spots/service
 */

/** GET /spots の1区画（OpenAPI Spot）。 */
export interface SpotView {
  id: string;
  name: string;
  /** occupied / vacant / unknown（デバイス不健全時は unknown）。OpenAPI Occupancy enum と一致。 */
  occupancy: 'occupied' | 'vacant' | 'unknown';
  device_healthy: boolean;
}

/** GET /spots/availability の1区画（OpenAPI SpotAvailability）。 */
export interface SpotAvailabilityView {
  spot_id: string;
  name: string;
  available: boolean;
  reason: AvailabilityReason;
}

export class SpotsService {
  constructor(private readonly repo: SpotsRepository) {}

  /**
   * 区画一覧＋現在の満空を返す。
   *
   * デバイスが不健全（最終通信が古い）な区画は occupancy を `unknown` にする（§8）。
   * これにより「壊れたデバイスの古い満空」をそのまま見せない。
   *
   * @returns 区画ビューの配列
   * @throws 業務例外は投げない。DB 例外はそのまま上位（asyncHandler→errorHandler で 500）へ伝播する。
   */
  async listSpots(): Promise<SpotView[]> {
    const now = new Date();
    const threshold = config.device.healthThresholdMinutes;
    const spots = await this.repo.listSpotsWithDevice();
    return spots.map((s) => {
      const healthy = isDeviceHealthy(s.last_seen_at, threshold, now);
      return {
        id: s.id,
        name: s.name,
        occupancy: healthy ? s.occupancy : 'unknown',
        device_healthy: healthy,
      };
    });
  }

  /**
   * 指定時間帯の予約可否を区画ごとに返す（best-effort）。
   *
   * 確定ではなく参照時点の暫定値。確定判定は予約作成時の競合チェックで行う（TOCTOU 許容・§8）。
   *
   * @param start 希望開始（UTC）
   * @param end 希望終了（UTC）
   * @returns 区画ごとの可否
   * @throws 業務例外は投げない。DB 例外はそのまま上位（asyncHandler→errorHandler で 500）へ伝播する。
   */
  async getAvailability(start: Date, end: Date): Promise<SpotAvailabilityView[]> {
    const now = new Date();
    const threshold = config.device.healthThresholdMinutes;
    const buffer = config.reservation.bufferMinutes;

    const spots = await this.repo.listSpotsWithDevice();
    const conflicts = await this.repo.findActiveReservationsInWindow(start, end, buffer);

    // 区画ごとに競合をまとめておく（区画数 × 予約数の総当たりを避ける）
    const bySpot = new Map<string, ReservationWindow[]>();
    for (const c of conflicts) {
      const list = bySpot.get(c.spot_id);
      // 初回だけ set（以降は同じ配列参照に push するので set 不要）
      if (list === undefined) bySpot.set(c.spot_id, [c]);
      else list.push(c);
    }

    return spots.map((s) => {
      const healthy = isDeviceHealthy(s.last_seen_at, threshold, now);
      const spotConflicts = (bySpot.get(s.id) ?? []).map((c) => ({
        start: c.start_time,
        end: c.end_time,
      }));
      const { available, reason } = availabilityForSpot({
        deviceHealthy: healthy,
        window: { start, end },
        conflicts: spotConflicts,
        bufferMinutes: buffer,
      });
      return { spot_id: s.id, name: s.name, available, reason };
    });
  }
}
