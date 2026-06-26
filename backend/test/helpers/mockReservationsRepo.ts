import type { Tx, TxRunner } from '@parking/core';
import { vi } from 'vitest';
import type {
  CreatedReservation,
  InsertReservationInput,
  ReservationRow,
  ReservationStatus,
  ReservationsRepository,
  SpotForReservation,
} from '../../src/reservations/repository.js';
import type { TimeWindow } from '../../src/spots/availability.js';

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
  /** listReservations が返す一覧（既定 空）。 */
  reservations?: ReservationRow[];
  /** findOwnedReservation が返す対象予約（null で不在/他人。既定は reserved の1件）。 */
  owned?: ReservationRow | null;
  /** updateReservation が返す更新行数（既定 1＝成功）。 */
  updateRows?: number;
  /** cancelReservation が返す取消行数（既定 1＝成功）。 */
  cancelRows?: number;
  /** findOwnedStatus が返す現在 status（404/409 切り分け用。既定 null）。 */
  ownedStatus?: ReservationStatus | null;
}

/**
 * テスト用のインメモリ {@link ReservationsRepository}。
 *
 * @param options 各メソッドの振る舞い
 * @returns vi.fn でラップしたモック repo
 */
export function makeMockReservationsRepo(
  options: MockReservationsRepoOptions = {},
): ReservationsRepository {
  const spot = options.spot === undefined ? defaultSpot() : options.spot;
  const conflicts = options.conflicts ?? [];
  const buildCreated = options.created ?? defaultCreated;
  const reservations = options.reservations ?? [];
  const owned = options.owned === undefined ? defaultOwned() : options.owned;
  const updateRows = options.updateRows ?? 1;
  const cancelRows = options.cancelRows ?? 1;
  const ownedStatus = options.ownedStatus ?? null;

  return {
    findSpotWithDevice: vi.fn(
      (_tx: Tx, _spotId: string): Promise<SpotForReservation | null> => Promise.resolve(spot),
    ),
    findConflictsForSpot: vi.fn((): Promise<TimeWindow[]> => Promise.resolve(conflicts)),
    insertReservation: vi.fn(
      (_tx: Tx, input: InsertReservationInput): Promise<CreatedReservation> =>
        Promise.resolve(buildCreated(input)),
    ),
    listReservations: vi.fn(
      (_userId: string, _status?: ReservationStatus): Promise<ReservationRow[]> =>
        Promise.resolve(reservations),
    ),
    findOwnedReservation: vi.fn(
      (_tx: Tx, _id: string, _userId: string): Promise<ReservationRow | null> =>
        Promise.resolve(owned),
    ),
    updateReservation: vi.fn((): Promise<number> => Promise.resolve(updateRows)),
    cancelReservation: vi.fn((): Promise<number> => Promise.resolve(cancelRows)),
    findOwnedStatus: vi.fn((): Promise<ReservationStatus | null> => Promise.resolve(ownedStatus)),
  };
}

/** 既定の所有予約（reserved・1時間枠）。 */
function defaultOwned(): ReservationRow {
  return {
    id: 'resv-1',
    spot_id: 'spot-1',
    start_time: new Date('2099-06-25T10:00:00Z'),
    end_time: new Date('2099-06-25T11:00:00Z'),
    status: 'reserved',
    created_at: new Date('2026-06-25T00:00:00Z'),
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
