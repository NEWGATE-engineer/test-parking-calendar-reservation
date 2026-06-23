import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * トークンの発行・検証・生成（認証設計§2）。
 *
 * - アクセストークン: ステートレスな JWT（HS256）。`sub` に user_id を入れ、短命（既定15分）。
 * - リフレッシュトークン: 高エントロピー乱数（クライアントへ返す）＋その SHA-256（DB 保存用）。
 *
 * @module auth/tokens
 */

/** アクセストークンに含まれる claims（`sub` = user_id）。 */
export interface AccessClaims {
  /** ユーザー ID（[User].id）。 */
  sub: string;
  /** 発行時刻（UNIX 秒）。jsonwebtoken が自動付与。 */
  iat: number;
  /** 失効時刻（UNIX 秒）。jsonwebtoken が `expiresIn` から算出。 */
  exp: number;
}

/**
 * アクセストークン（JWT/HS256）を発行する。
 *
 * `subject` に user_id を設定し、`exp` は設定値 `jwt.accessTtlSec`（既定15分）後になる。
 *
 * @param userId トークンの所有者（[User].id）
 * @returns 署名済み JWT 文字列。クライアントは Authorization: Bearer で送る
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({}, config.jwt.secret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: config.jwt.accessTtlSec,
  });
}

/**
 * アクセストークンを検証する。
 *
 * 署名（HS256・サーバの秘密鍵）と有効期限（`exp`）を検証し、`sub` が非空文字列であることまで保証する。
 * MVP では失効リスト（denylist）は持たない（認証設計§4）。
 *
 * @param token Bearer で受け取った JWT 文字列
 * @returns 検証済みの claims（`sub`/`iat`/`exp`）
 * @throws {Error} 署名不正・期限切れ・`sub` 不在など、トークンが無効な場合
 */
export function verifyAccessToken(token: string): AccessClaims {
  // jwt.verify は署名・exp を検証し、失敗時は例外を投げる
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  // payload が文字列（非 JSON）や sub 欠落・空文字なら不正として弾く
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('invalid token payload');
  }
  return payload as AccessClaims;
}

/** リフレッシュトークンの素材（クライアント返却用の平文と、DB 保存用のハッシュ）。 */
export interface RefreshTokenMaterial {
  /** クライアントへ返す高エントロピー乱数（base64url）。サーバには保存しない。 */
  raw: string;
  /** サーバ保存用の SHA-256（ソルト無・決定的）。`RefreshToken.token_hash`(VARBINARY(32)) に入れる。 */
  hash: Buffer;
}

/**
 * リフレッシュトークンを新規生成する（認証設計§2）。
 *
 * 平文は十分長い乱数なので、保存はソルト無し SHA-256 で良い（パスワードと違い総当たり対象にならない）。
 * 平文はこの瞬間だけ存在し、サーバはハッシュのみ保持する。
 *
 * @returns 平文（クライアントへ返す）と SHA-256 ハッシュ（DB 保存用）
 */
export function generateRefreshToken(): RefreshTokenMaterial {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}

/**
 * 文字列の SHA-256 を計算する（リフレッシュトークンの保存・照合で共通利用）。
 *
 * @param value ハッシュ化する文字列（リフレッシュトークンの平文）
 * @returns 32 バイトのダイジェスト
 */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
