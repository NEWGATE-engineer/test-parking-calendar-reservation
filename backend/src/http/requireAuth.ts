import type { Request, RequestHandler } from 'express';
import { verifyAccessToken } from '../auth/tokens.js';
import { unauthorized } from './errors.js';

/**
 * 認証ミドルウェア。
 *
 * `Authorization: Bearer <JWT>` を検証し、成功時に `req.userId` へ `sub`（user_id）を設定する。
 * 署名・有効期限の検証のみで、MVP は失効リスト（denylist）を持たない（認証設計§4）。
 * 認証が必要なルートの前段に差し込んで使う。
 *
 * @module http/requireAuth
 */

/**
 * Bearer アクセストークンを検証する Express ミドルウェア。
 *
 * @param req リクエスト。Authorization ヘッダを参照し、成功時 `req.userId` を設定
 * @param _res レスポンス（未使用）
 * @param next 成功で `next()`、失敗で `next(unauthorized())` を呼ぶ
 *
 * 失敗時は 401 `unauthorized` を errorHandler 経由で返す（ヘッダ欠落・形式不正・検証失敗）。
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) {
    next(unauthorized());
    return;
  }
  const token = header.slice('Bearer '.length);
  try {
    const claims = verifyAccessToken(token);
    req.userId = claims.sub; // 後続ハンドラはこの userId で本人判定する
    next();
  } catch {
    // 署名不正・期限切れ・sub 欠落などはすべて 401（理由は明かしすぎない）
    next(unauthorized('トークンが無効です'));
  }
};

/**
 * `requireAuth` を通過した Request から認証済みユーザー ID を取り出す。
 *
 * `req.userId` は型上 optional だが、`requireAuth` 通過後は必ず設定されている。
 * もし未設定なら**ミドルウェアの配線ミス（プログラミングエラー）**なので、認証失敗(401)
 * ではなく内部エラー（→ errorHandler が 500）として扱う。各ハンドラの防御コードを集約する。
 *
 * @param req requireAuth 通過後のリクエスト
 * @returns 認証済みユーザー ID（`sub`）
 * @throws {Error} `requireAuth` を前段に置いていない等で `userId` 未設定の場合（内部エラー）
 */
export function getUserId(req: Request): string {
  if (req.userId === undefined) {
    throw new Error('requireAuth invariant violated: req.userId is not set');
  }
  return req.userId;
}
