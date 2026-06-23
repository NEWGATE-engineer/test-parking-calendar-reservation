import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/** アクセストークンの claims（認証設計: sub=user_id）。 */
export interface AccessClaims {
  sub: string;
  iat: number;
  exp: number;
}

/**
 * アクセストークン（JWT/HS256）を検証する。
 * 署名・exp を検証し、不正・期限切れは例外を投げる（呼び出し側で 401 に変換）。
 * ※発行（sign）はログイン実装（2b）で追加する。
 */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('invalid token payload');
  }
  return payload as AccessClaims;
}
