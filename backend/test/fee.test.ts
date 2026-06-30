import { computeCompletionFee, estimateOverstayFee, estimateSlotFee } from '@parking/core';
import { describe, expect, it } from 'vitest';

/** テスト用の単価設定（仮 100円 / 30分）。 */
const cfg = { unitPriceJpy: 100, unitMinutes: 30 };
/** 超過込みの設定（超過単価も 100円 / 30分）。 */
const fullCfg = { ...cfg, overstayUnitPriceJpy: 100 };

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

describe('estimateOverstayFee', () => {
  it('終了前に出庫していれば超過なし＝0円', () => {
    const fee = estimateOverstayFee(
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T10:45:00Z'),
      fullCfg,
    );
    expect(fee).toBe(0);
  });

  it('ちょうど終了時刻の出庫も超過なし（0分）', () => {
    const fee = estimateOverstayFee(
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T11:00:00Z'),
      fullCfg,
    );
    expect(fee).toBe(0);
  });

  it('30分超過は1単位（100円）', () => {
    const fee = estimateOverstayFee(
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T11:30:00Z'),
      fullCfg,
    );
    expect(fee).toBe(100);
  });

  it('端数は切り上げ（1分超過でも1単位）', () => {
    const fee = estimateOverstayFee(
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T11:01:00Z'),
      fullCfg,
    );
    expect(fee).toBe(100);
  });
});

describe('computeCompletionFee', () => {
  it('枠（60分=200円）＋超過（30分=100円）の内訳を返す', () => {
    const fee = computeCompletionFee(
      at('2026-06-25T10:00:00Z'),
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T11:30:00Z'),
      fullCfg,
    );
    expect(fee).toEqual({ slotFee: 200, overstayFee: 100 });
  });

  it('超過なしなら overstayFee=0', () => {
    const fee = computeCompletionFee(
      at('2026-06-25T10:00:00Z'),
      at('2026-06-25T11:00:00Z'),
      at('2026-06-25T10:50:00Z'),
      fullCfg,
    );
    expect(fee).toEqual({ slotFee: 200, overstayFee: 0 });
  });
});
