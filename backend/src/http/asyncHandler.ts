import type { RequestHandler } from 'express';

/**
 * async なリクエストハンドラを Express 用にラップするユーティリティ。
 *
 * async 関数が投げた例外（reject）を `next(err)` に転送し、統一エラーハンドラへ確実に届ける。
 * 各ルートで `.catch(next)` を書く定型を1か所にまとめる。
 *
 * @param fn 非同期ハンドラ（`(req, res) => Promise<void>` 等）
 * @returns 例外を next に流す通常の Express ハンドラ
 *
 * @example
 * router.post('/x', asyncHandler(async (req, res) => {
 *   res.json(await doSomething(req.body));
 * }));
 */
export function asyncHandler(
  fn: (...args: Parameters<RequestHandler>) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
