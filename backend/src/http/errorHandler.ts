import type { ErrorRequestHandler } from 'express';
import { AppError, type ErrorBody } from './errors.js';

/**
 * 統一エラーハンドラ（Express 5 のエラーミドルウェア）。
 *
 * - {@link AppError}: 定義どおりの HTTP ステータスと Error スキーマ本体で応答する。
 * - それ以外（想定外の例外）: 500 `internal_error` を返し、内部実装・スタックトレースは
 *   レスポンスに含めない。
 *
 * ミドルウェアの登録順では**必ず最後**に置くこと。
 *
 * @param err 投げられた例外（AppError かそれ以外）
 * @param _req リクエスト（未使用）
 * @param res レスポンス
 * @param _next 次のハンドラ（未使用だが Express がエラーミドルウェアと認識するため4引数必須）
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json(err.toBody());
    return;
  }
  // 想定外の例外は name/message のみログする。err オブジェクト全体は出さない
  // （mssql 等が接続文字列をエラーに含む場合、ログ基盤へパスワードが漏れるのを防ぐ）。
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`unhandled error: ${name}: ${message}`);
  const body: ErrorBody = { code: 'internal_error', message: '内部エラーが発生しました', retryable: false };
  res.status(500).json(body);
};
