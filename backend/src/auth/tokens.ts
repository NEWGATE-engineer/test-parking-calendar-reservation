import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/** アクセストークンの claims（認証設計: sub=user_id）。 */
export interface AccessClaims {
  sub: string;
  iat: number;
  exp: number;
}

/** アクセストークン（JWT/HS256）を発行する。sub に user_id を入れ、exp は accessTtlSec。 */
export function signAccessToken(userId: string): string {
  return jwt.sign({}, config.jwt.secret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: config.jwt.accessTtlSec,
  });
}

/**
 * アクセストークンを検証する。署名・exp を検証し、不正・期限切れは例外を投げる。
 * sub は非空文字列であることを保証する。
 */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('invalid token payload');
  }
  return payload as AccessClaims;
}

/** 発行したリフレッシュトークンの平文（クライアントへ返す値）と保存用ハッシュ。 */
export interface RefreshTokenMaterial {
  /** クライアントへ返す高エントロピー乱数（base64url）。 */
  raw: string;
  /** サーバ保存用の SHA-256（ソルト無・決定的）。VARBINARY(32) に格納。 */
  hash: Buffer;
}

/** リフレッシュトークンを生成する（認証設計§2: 高エントロピー乱数 + SHA-256 ソルト無）。 */
export function generateRefreshToken(): RefreshTokenMaterial {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}

/** リフレッシュトークン平文の SHA-256（照合・保存共通）。 */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
