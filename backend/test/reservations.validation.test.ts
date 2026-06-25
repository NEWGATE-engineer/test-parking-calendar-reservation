import { describe, it, expect } from 'vitest';
import {
  parseCreateReservationBody,
  parseUpdateReservationBody,
  parseListQuery,
  parseReservationId,
} from '../src/reservations/validation.js';
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

/** 任意の検証関数が 422（validation_error）を投げることを表明する。 */
function expectThrows422(fn: () => unknown): void {
  try {
    fn();
    throw new Error('AppError(422) を期待したが投げられなかった');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(422);
    expect((err as AppError).code).toBe('validation_error');
  }
}

describe('parseUpdateReservationBody', () => {
  it('指定フィールドのみのパッチを返す', () => {
    const patch = parseUpdateReservationBody({ end_time: '2099-06-25T12:00:00Z' });
    expect(patch.end?.toISOString()).toBe('2099-06-25T12:00:00.000Z');
    expect(patch.spotId).toBeUndefined();
    expect(patch.start).toBeUndefined();
  });

  it('全項目省略（空更新）は 422', () => {
    expectThrows422(() => parseUpdateReservationBody({}));
  });

  it('spot_id が UUID でないと 422', () => {
    expectThrows422(() => parseUpdateReservationBody({ spot_id: 'bad' }));
  });

  it('start_time が日時不正だと 422', () => {
    expectThrows422(() => parseUpdateReservationBody({ start_time: 'いつか' }));
  });

  it('配列ボディは（更新項目なし扱いで）422', () => {
    expectThrows422(() => parseUpdateReservationBody([]));
  });

  it('end<=start の不変条件はここでは見ない（マージ後に検証）', () => {
    // 形式が正しければ通る（cross-field は service 側の assertMergedWindow が担当）
    const patch = parseUpdateReservationBody({
      start_time: '2099-06-25T11:00:00Z',
      end_time: '2099-06-25T10:00:00Z',
    });
    expect(patch.start).toBeInstanceOf(Date);
    expect(patch.end).toBeInstanceOf(Date);
  });
});

describe('parseListQuery', () => {
  it('status 未指定は空オブジェクト', () => {
    expect(parseListQuery({})).toEqual({});
  });

  it('空文字 status は無視（空オブジェクト）', () => {
    expect(parseListQuery({ status: '' })).toEqual({});
  });

  it('既知の status は通す', () => {
    expect(parseListQuery({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
  });

  it('未知の status は 422', () => {
    expectThrows422(() => parseListQuery({ status: 'bogus' }));
  });
});

describe('parseReservationId', () => {
  it('UUID を通す', () => {
    expect(parseReservationId('22222222-2222-2222-2222-222222222222')).toBe(
      '22222222-2222-2222-2222-222222222222',
    );
  });

  it('UUID でない文字列は 422', () => {
    expectThrows422(() => parseReservationId('not-a-uuid'));
  });

  it('undefined（パスパラメータ欠落）は 422', () => {
    expectThrows422(() => parseReservationId(undefined));
  });
});
