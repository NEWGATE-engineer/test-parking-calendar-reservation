import type { ErrorRequestHandler } from 'express';
import { AppError, type ErrorBody } from './errors.js';

/**
 * 統一エラーハンドラ。AppError は定義どおりに、それ以外は 500 internal_error として
 * 返す（内部実装・スタックトレースはレスポンスに漏らさない）。Express 5 では末尾に置く。
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json(err.toBody());
    return;
  }
  // 想定外の例外はログのみ。err オブジェクト全体は出さない（mssql 等が接続文字列を
  // メッセージに含む場合にログ基盤へ漏れるのを防ぐ）。name と message に限定する。
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`unhandled error: ${name}: ${message}`);
  const body: ErrorBody = { code: 'internal_error', message: '内部エラーが発生しました', retryable: false };
  res.status(500).json(body);
};
