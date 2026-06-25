import { describe, it, expect } from 'vitest';
import { parseCreateReservationBody } from '../src/reservations/validation.js';
import { AppError } from '../src/http/errors.js';

/** 過去日時判定の基準（固定）。これより後の時刻を「未来」とみなす。 */
const NOW = new Date('2026-06-25T00:00:00Z');
const SPOT_ID = '11111111-1111-1111-1111-111111111111';

/** 妥当な未来ボディ（個別フィールドを上書きして異常系を作るための土台）。 */
function base(): Record<string, unknown> {
  return {
    spot_id: SPOT_ID,
    start_time: '2026-06-25T10:00:00Z',
    end_time: '2026-06-25T11:00:00Z',
  };
}

/** 422（validation_error）を投げることを表明するヘルパ。 */
function expect422(body: unknown): void {
  try {
    parseCreateReservationBody(body, NOW);
    throw new Error('AppError(422) を期待したが投げられなかった');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(422);
    expect((err as AppError).code).toBe('validation_error');
  }
}

describe('parseCreateReservationBody', () => {
  it('妥当な入力は型付き値を返す（時刻は Date）', () => {
    const out = parseCreateReservationBody(base(), NOW);
    expect(out.spotId).toBe(SPOT_ID);
    expect(out.start.toISOString()).toBe('2026-06-25T10:00:00.000Z');
    expect(out.end.toISOString()).toBe('2026-06-25T11:00:00.000Z');
  });

  describe('spot_id', () => {
    it('UUID でない文字列は 422', () => {
      expect422({ ...base(), spot_id: 'not-a-uuid' });
    });
    it('欠落は 422', () => {
      const b = base();
      delete b['spot_id'];
      expect422(b);
    });
    it('非文字列（数値）は 422', () => {
      expect422({ ...base(), spot_id: 12345 });
    });
  });

  describe('start_time / end_time', () => {
    it('start_time 欠落は 422', () => {
      const b = base();
      delete b['start_time'];
      expect422(b);
    });
    it('end_time 欠落は 422', () => {
      const b = base();
      delete b['end_time'];
      expect422(b);
    });
    it('非文字列（数値）は 422', () => {
      expect422({ ...base(), start_time: 1000 });
    });
    it('非文字列（配列）は 422', () => {
      expect422({ ...base(), end_time: ['2026-06-25T11:00:00Z'] });
    });
    it('日時として解釈できない文字列は 422', () => {
      expect422({ ...base(), start_time: 'いつか' });
    });
  });

  describe('時間帯の不変条件', () => {
    it('end == start（ゼロ幅）は 422', () => {
      expect422({ ...base(), start_time: '2026-06-25T10:00:00Z', end_time: '2026-06-25T10:00:00Z' });
    });
    it('end < start（逆転）は 422', () => {
      expect422({ ...base(), start_time: '2026-06-25T11:00:00Z', end_time: '2026-06-25T10:00:00Z' });
    });
    it('過去開始は 422', () => {
      expect422({
        ...base(),
        start_time: '2020-01-01T10:00:00Z',
        end_time: '2020-01-01T11:00:00Z',
      });
    });
  });

  describe('ボディ自体が不正', () => {
    it('null は（{} フォールバック後）spot_id 欠落で 422', () => {
      expect422(null);
    });
    it('配列は 422', () => {
      expect422([]);
    });
    it('文字列は 422', () => {
      expect422('not-an-object');
    });
  });
});
