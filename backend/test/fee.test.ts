import { estimateSlotFee } from '@parking/core';
import { describe, expect, it } from 'vitest';

/** テスト用の単価設定（仮 100円 / 30分）。 */
const cfg = { unitPriceJpy: 100, unitMinutes: 30 };

function at(iso: string): Date {
  return new Date(iso);
}

describe('estimateSlotFee', () => {
  it('ちょうど1単位（30分）は単価1つ分', () => {
    const fee = estimateSlotFee(at('2026-06-25T10:00:00Z'), at('2026-06-25T10:30:00Z'), cfg);
    expect(fee).toBe(100);
  });

  it('割り切れる複数単位（60分）は単価2つ分', () => {
    const fee = estimateSlotFee(at('2026-06-25T10:00:00Z'), at('2026-06-25T11:00:00Z'), cfg);
    expect(fee).toBe(200);
  });

  it('端数は切り上げ（45分→2単位）', () => {
    const fee = estimateSlotFee(at('2026-06-25T10:00:00Z'), at('2026-06-25T10:45:00Z'), cfg);
    expect(fee).toBe(200);
  });

  it('単位未満（1分）でも最低1単位を課金', () => {
    const fee = estimateSlotFee(at('2026-06-25T10:00:00Z'), at('2026-06-25T10:01:00Z'), cfg);
    expect(fee).toBe(100);
  });
});
