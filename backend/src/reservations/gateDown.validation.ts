import { validationError } from '../http/errors.js';

/**
 * POST /reservations/:id/gate-down のリクエストボディ検証。
 *
 * @module reservations/gateDown.validation
 */

/** 検証済みの gate-down 入力。 */
export interface GateDownInput {
  /** 冪等キー。1 送信操作ごとに採番（トランスポート再送は同一キーで吸収）。 */
  requestId: string;
}

/** CommandLog.request_id は NVARCHAR(100)。これを超える値は受け付けない。 */
const REQUEST_ID_MAX = 100;

/**
 * gate-down ボディを検証し、型付き入力へ変換する。
 *
 * @param body `req.body`（express.json でパース済み）
 * @returns `{ requestId }`
 * @throws {AppError} 422 `validation_error` — request_id が欠落・非文字列・空・長すぎる
 */
export function parseGateDownBody(body: unknown): GateDownInput {
  const b = (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;
  const requestId = b['request_id'];
  if (typeof requestId !== 'string' || requestId === '') {
    throw validationError('request_id は必須の文字列です');
  }
  if (requestId.length > REQUEST_ID_MAX) {
    throw validationError(`request_id は ${REQUEST_ID_MAX} 文字以内で指定してください`);
  }
  return { requestId };
}
