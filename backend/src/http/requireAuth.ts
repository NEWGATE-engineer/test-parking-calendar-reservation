import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../auth/tokens.js';
import { unauthorized } from './errors.js';

/**
 * Bearer アクセストークンを検証し、req.userId に sub を設定する認証ミドルウェア。
 * 署名・exp の検証のみ（MVP は access の denylist を持たない＝認証設計§4）。
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
    req.userId = claims.sub;
    next();
  } catch {
    next(unauthorized('トークンが無効です'));
  }
};
