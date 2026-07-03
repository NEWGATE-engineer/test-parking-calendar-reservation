import type { FeeInput, FinishRepository, ReservationForFinish, Tx } from '@parking/core';
import { vi } from 'vitest';

/** {@link makeMockFinishRepo} の挙動指定。省略時は「active・在車なし・完了成功」。 */
export interface MockFinishOptions {
  /** findOwnedReservation の戻り（null で不在/他人）。 */
  reservation?: ReservationForFinish | null;
  /** hasOpenUsage の戻り（既定 false＝空車）。 */
  hasOpen?: boolean;
  /** getLastExit の戻り（既定 11:30）。 */
  lastExit?: Date | null;
  /** completeReservation の戻り行数（既定 1＝確定成功）。 */
  completeRows?: number;
  /** bringForwardEndTime の戻り行数（既定 1）。 */
  bringForwardRows?: number;
}

export type MockFinishRepo = {
  [K in keyof FinishRepository]: ReturnType<typeof vi.fn>;
} & FinishRepository;

/** 既定の予約（active・10:00-12:00・作成 09:00）。 */
export function defaultFinishReservation(): ReservationForFinish {
  return {
    id: 'resv-1',
    spot_id: 'spot-1',
    start_time: new Date('2026-06-25T10:00:00Z'),
    end_time: new Date('2026-06-25T12:00:00Z'),
    status: 'active',
    created_at: new Date('2026-06-25T09:00:00Z'),
  };
}

/** テスト用のインメモリ {@link FinishRepository}（呼び出し検証のため各 mock を露出）。 */
export function makeMockFinishRepo(options: MockFinishOptions = {}): MockFinishRepo {
  const reservation =
    options.reservation === undefined ? defaultFinishReservation() : options.reservation;
  const hasOpen = options.hasOpen ?? false;
  const lastExit =
    options.lastExit === undefined ? new Date('2026-06-25T11:30:00Z') : options.lastExit;
  const completeRows = options.completeRows ?? 1;
  const bringForwardRows = options.bringForwardRows ?? 1;

  return {
    findOwnedReservation: vi.fn(
      (_tx: Tx, _id: string, _uid: string): Promise<ReservationForFinish | null> =>
        Promise.resolve(reservation),
    ),
    bringForwardEndTime: vi.fn((): Promise<number> => Promise.resolve(bringForwardRows)),
    hasOpenUsage: vi.fn((): Promise<boolean> => Promise.resolve(hasOpen)),
    getLastExit: vi.fn((): Promise<Date | null> => Promise.resolve(lastExit)),
    completeReservation: vi.fn((): Promise<number> => Promise.resolve(completeRows)),
    insertFee: vi.fn((_tx: Tx, _input: FeeInput): Promise<void> => Promise.resolve()),
  };
}
