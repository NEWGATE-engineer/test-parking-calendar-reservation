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
  // 想定外の例外はログのみ（機密が混じり得るためレスポンスには出さない）
  console.error('unhandled error:', err);
  const body: ErrorBody = { code: 'internal_error', message: '内部エラーが発生しました', retryable: false };
  res.status(500).json(body);
};
