import { validationError } from '@parking/core';

/**
 * `/spots/availability` のクエリ検証。
 *
 * @module spots/validation
 */

/** 検証済みの availability クエリ（UTC の Date）。 */
export interface AvailabilityQuery {
  start: Date;
  end: Date;
}

/**
 * クエリ値を Date に変換する。ISO 日時として解釈できなければ `undefined`。
 *
 * @param v クエリ文字列（`req.query` の値は string | undefined 等）
 * @returns 妥当な Date、不正なら undefined
 */
function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * `start` / `end` クエリを検証する。
 *
 * @param query `req.query`
 * @returns 検証済みの `{ start, end }`
 * @throws {AppError} 422 `validation_error` — start/end が日時として不正、または end <= start
 */
export function parseAvailabilityQuery(query: unknown): AvailabilityQuery {
  const q = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const start = parseDate(q['start']);
  const end = parseDate(q['end']);
  if (start === undefined) throw validationError('start は ISO 日時で指定してください');
  if (end === undefined) throw validationError('end は ISO 日時で指定してください');
  if (end.getTime() <= start.getTime())
    throw validationError('end は start より後である必要があります');
  return { start, end };
}
