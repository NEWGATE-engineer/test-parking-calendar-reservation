import { AppError, parseGateDownBody } from '@parking/core';
import { describe, expect, it } from 'vitest';

function expect422(body: unknown): void {
  try {
    parseGateDownBody(body);
    throw new Error('AppError(422) を期待したが投げられなかった');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(422);
    expect((err as AppError).code).toBe('validation_error');
  }
}

describe('parseGateDownBody', () => {
  it('妥当な request_id を返す', () => {
    expect(parseGateDownBody({ request_id: 'req-1' })).toEqual({ requestId: 'req-1' });
  });

  it('欠落は 422', () => {
    expect422({});
  });

  it('空文字は 422', () => {
    expect422({ request_id: '' });
  });

  it('非文字列は 422', () => {
    expect422({ request_id: 123 });
  });

  it('100 文字超は 422', () => {
    expect422({ request_id: 'x'.repeat(101) });
  });

  it('100 文字ちょうどは通す', () => {
    expect(parseGateDownBody({ request_id: 'x'.repeat(100) }).requestId).toHaveLength(100);
  });

  it('非オブジェクトボディは 422', () => {
    expect422(null);
    expect422('str');
    expect422([]);
  });
});
