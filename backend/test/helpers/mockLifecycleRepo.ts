import type { CompletableReservation, LifecycleRepository, Tx } from '@parking/core';
import { vi } from 'vitest';

/**
 * {@link makeMockLifecycleRepo} の挙動を指定するオプション。
 * 省略時は「該当なし（全件 0・候補空）」になる。
 */
export interface MockLifecycleRepoOptions {
  /** markNoShows が返す遷移行数（既定 0）。 */
  noShowRows?: number;
  /** markOverstays が返す遷移行数（既定 0）。 */
  overstayRows?: number;
  /** findCompletable が返す完了候補（既定 空）。 */
  completable?: CompletableReservation[];
  /** completeReservation が返す行数（既定 1＝確定成功）。id で切り替えたいときは {@link completeRowsFor}。 */
  completeRows?: number;
  /** 予約 id ごとに completeReservation の行数を変えたいとき（競合負けの再現など）。 */
  completeRowsFor?: (id: string) => number;
}

/** vi.fn でラップした {@link LifecycleRepository}（呼び出し検証のため各 mock を露出）。 */
export type MockLifecycleRepo = {
  [K in keyof LifecycleRepository]: ReturnType<typeof vi.fn>;
} & LifecycleRepository;

/**
 * テスト用のインメモリ {@link LifecycleRepository}。
 *
 * @param options 各メソッドの振る舞い
 * @returns vi.fn でラップしたモック repo（`repo.insertFee.mock.calls` 等で検証できる）
 */
export function makeMockLifecycleRepo(options: MockLifecycleRepoOptions = {}): MockLifecycleRepo {
  const noShowRows = options.noShowRows ?? 0;
  const overstayRows = options.overstayRows ?? 0;
  const completable = options.completable ?? [];
  const completeRows = options.completeRows ?? 1;

  return {
    markNoShows: vi.fn((): Promise<number> => Promise.resolve(noShowRows)),
    markOverstays: vi.fn((): Promise<number> => Promise.resolve(overstayRows)),
    findCompletable: vi.fn((): Promise<CompletableReservation[]> => Promise.resolve(completable)),
    completeReservation: vi.fn((_tx: Tx, id: string): Promise<number> => {
      const rows = options.completeRowsFor ? options.completeRowsFor(id) : completeRows;
      return Promise.resolve(rows);
    }),
    insertFee: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

/** 完了候補を1件作るヘルパー（10:00 開始 / 11:00 終了・最終出庫は引数）。 */
export function completable(
  id: string,
  lastExit: Date,
  overrides: Partial<CompletableReservation> = {},
): CompletableReservation {
  return {
    id,
    start_time: new Date('2026-06-25T10:00:00Z'),
    end_time: new Date('2026-06-25T11:00:00Z'),
    last_exit_time: lastExit,
    ...overrides,
  };
}
