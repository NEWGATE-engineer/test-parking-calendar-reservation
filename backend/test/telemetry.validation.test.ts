import { AppError, parseTelemetryEvent } from '@parking/core';
import { describe, expect, it } from 'vitest';

/** 妥当な entry メッセージ（個別フィールドを上書きして異常系を作る土台）。 */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'entry',
    deviceId: 'dev-1',
    eventId: 'evt-1',
    occurredAt: '2026-06-25T10:00:00.000Z',
    ...overrides,
  };
}

/** parseTelemetryEvent が 422 validation_error を投げることを表明する。 */
function expect422(raw: unknown): void {
  try {
    parseTelemetryEvent(raw);
    throw new Error('AppError(422) を期待したが投げられなかった');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(422);
    expect((err as AppError).code).toBe('validation_error');
  }
}

describe('parseTelemetryEvent', () => {
  it('妥当な entry を型付き値に変換する（occurredAt は Date）', () => {
    const ev = parseTelemetryEvent(validRaw());
    expect(ev.type).toBe('entry');
    expect(ev.deviceId).toBe('dev-1');
    expect(ev.eventId).toBe('evt-1');
    expect(ev.occurredAt).toBeInstanceOf(Date);
    expect(ev.occurredAt.toISOString()).toBe('2026-06-25T10:00:00.000Z');
  });

  it('exit / up も受け付ける', () => {
    expect(parseTelemetryEvent(validRaw({ type: 'exit' })).type).toBe('exit');
    expect(parseTelemetryEvent(validRaw({ type: 'up' })).type).toBe('up');
  });

  it('null / 非オブジェクトは 422', () => {
    expect422(null);
    expect422('string');
    expect422(42);
  });

  it('type が未知の値は 422', () => {
    expect422(validRaw({ type: 'down' }));
    expect422(validRaw({ type: 'unknown' }));
    expect422(validRaw({ type: 123 }));
  });

  it('deviceId が空文字・非文字列は 422', () => {
    expect422(validRaw({ deviceId: '' }));
    expect422(validRaw({ deviceId: 123 }));
    expect422(validRaw({ deviceId: undefined }));
  });

  it('eventId が空文字・欠落は 422', () => {
    expect422(validRaw({ eventId: '' }));
    expect422(validRaw({ eventId: undefined }));
  });

  it('occurredAt が非文字列・日時として不正は 422', () => {
    expect422(validRaw({ occurredAt: 123 }));
    expect422(validRaw({ occurredAt: 'not-a-date' }));
  });
});
