import type { FeeRepository, FeeRow } from '@parking/core';
import { vi } from 'vitest';

/** {@link makeMockFeeRepo} の挙動指定。省略時は「所有あり・Fee 未記録（pending）」。 */
export interface MockFeeOptions {
  /** reservationExistsForUser の戻り（既定 true）。 */
  exists?: boolean;
  /** findFee の戻り（既定 null＝pending）。 */
  fee?: FeeRow | null;
}

export type MockFeeRepo = {
  [K in keyof FeeRepository]: ReturnType<typeof vi.fn>;
} & FeeRepository;

/** テスト用のインメモリ {@link FeeRepository}。 */
export function makeMockFeeRepo(options: MockFeeOptions = {}): MockFeeRepo {
  const exists = options.exists ?? true;
  const fee = options.fee === undefined ? null : options.fee;
  return {
    reservationExistsForUser: vi.fn((): Promise<boolean> => Promise.resolve(exists)),
    findFee: vi.fn((): Promise<FeeRow | null> => Promise.resolve(fee)),
  };
}
