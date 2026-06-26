import { vi } from 'vitest';
import type {
  ReservationWindow,
  SpotsRepository,
  SpotWithDevice,
} from '../../src/spots/repository.js';

/**
 * テスト用のインメモリ {@link SpotsRepository}。
 *
 * @param spots listSpotsWithDevice が返す区画
 * @param conflicts findActiveReservationsInWindow が返す競合（既定 空）
 */
export function makeMockSpotsRepo(
  spots: SpotWithDevice[],
  conflicts: ReservationWindow[] = [],
): SpotsRepository {
  return {
    listSpotsWithDevice: vi.fn((): Promise<SpotWithDevice[]> => Promise.resolve(spots)),
    findActiveReservationsInWindow: vi.fn(
      (): Promise<ReservationWindow[]> => Promise.resolve(conflicts),
    ),
  };
}
