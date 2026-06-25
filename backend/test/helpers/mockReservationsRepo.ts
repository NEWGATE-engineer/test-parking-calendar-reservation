import { vi } from 'vitest';
import type { Tx, TxRunner } from '../../src/db.js';
import type { TimeWindow } from '../../src/spots/availability.js';
import type {
  ReservationsRepository,
  SpotForReservation,
  CreatedReservation,
  InsertReservationInput,
} from '../../src/reservations/repository.js';

/**
 * 偽のトランザクションランナー。実 DB を張らず、コールバックを即実行するだけ。
 *
 * サービスは tx を「不透明値」として repo に渡すだけなので、ダミーの tx を流し込めば
 * DB なしでユースケース全体（SELECT→判定→INSERT）の分岐を検証できる。
 */
export const fakeTxRunner: TxRunner = (fn) => fn({} as Tx);

/** {@link makeMockReservationsRepo} の挙動を指定するオプション。 */
export interface MockReservationsRepoOptions {
  /** findSpotWithDevice が返す区画（null で「存在しない」を表す）。 */
  spot?: SpotForReservation | null;
  /** findConflictsForSpot が返す競合（既定 空＝競合なし）。 */
  conflicts?: TimeWindow[];
  /** insertReservation が返す作成行を組み立てる関数（既定は入力をそのまま反映）。 */
  created?: (input: InsertReservationInput) => CreatedReservation;
}

/**
 * テスト用のインメモリ {@link ReservationsRepository}。
 *
 * @param options 区画・競合・作成行の振る舞い
 * @returns vi.fn でラップしたモック repo
 */
export function makeMockReservationsRepo(
  options: MockReservationsRepoOptions = {},
): ReservationsRepository {
  const spot = options.spot === undefined ? defaultSpot() : options.spot;
  const conflicts = options.conflicts ?? [];
  const buildCreated = options.created ?? defaultCreated;

  return {
    findSpotWithDevice: vi.fn(
      (_tx: Tx, _spotId: string): Promise<SpotForReservation | null> => Promise.resolve(spot),
    ),
    findConflictsForSpot: vi.fn(
      (): Promise<TimeWindow[]> => Promise.resolve(conflicts),
    ),
    insertReservation: vi.fn(
      (_tx: Tx, input: InsertReservationInput): Promise<CreatedReservation> =>
        Promise.resolve(buildCreated(input)),
    ),
  };
}

/** 既定の区画（健全なデバイス＝last_seen_at が現在時刻）。 */
function defaultSpot(): SpotForReservation {
  return { id: 'spot-1', last_seen_at: new Date() };
}

/** 既定の作成行（入力をそのまま反映し、id/status/created_at を補う）。 */
function defaultCreated(input: InsertReservationInput): CreatedReservation {
  return {
    id: 'resv-1',
    spot_id: input.spotId,
    start_time: input.start,
    end_time: input.end,
    status: 'reserved',
    created_at: new Date('2026-06-25T00:00:00Z'),
  };
}
