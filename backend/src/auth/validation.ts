import { validationError } from '@parking/core';

/**
 * `/auth/*` のリクエスト本文バリデーション。
 *
 * Express の `req.body`（`unknown`）から必要な値を安全に取り出し、形式が不正なら
 * 422（`validation_error`）を投げる。ここを通った後の値は型が保証される。
 *
 * @module auth/validation
 */

/** 明らかに不正なメールだけを弾く簡易チェック（厳密な RFC 準拠判定はしない）。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** パスワードの最小長（OpenAPI の minLength と一致）。 */
const PASSWORD_MIN = 8;
/** リフレッシュトークンの上限長。正規は base64url 43文字だが余裕を持たせる。 */
const REFRESH_TOKEN_MAX_LEN = 128;

/** `parseRegister` が返す、検証済みの会員登録入力。 */
export interface RegisterInput {
  email: string;
  password: string;
  /** 任意。未指定は `null`（[User].name は NULL 許容）。 */
  name: string | null;
  /** 同意した規約バージョン（Consent に記録）。 */
  termsVersion: string;
}

/** `parseLogin` が返す、検証済みのログイン入力。 */
export interface LoginInput {
  email: string;
  password: string;
}

/** refresh / logout が必要とする本文（`refresh_token`）。 */
export interface RefreshTokenBody {
  refreshToken: string;
}

/**
 * `unknown` を安全に文字列として取り出す。文字列でなければ `undefined`。
 *
 * @param v 任意の値
 * @returns 文字列ならその値、そうでなければ `undefined`
 */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 会員登録リクエスト本文を検証する。
 *
 * @param body `req.body`（型は `unknown`）
 * @returns 検証済みの登録入力
 * @throws {AppError} 422 `validation_error` — 本文が非オブジェクト、メール形式不正、
 *   パスワードが8文字未満、`terms_version` 欠落のいずれか
 */
export function parseRegister(body: unknown): RegisterInput {
  if (typeof body !== 'object' || body === null) throw validationError('リクエスト本文が不正です');
  const b = body as Record<string, unknown>;
  const email = asString(b['email']);
  const password = asString(b['password']);
  const termsVersion = asString(b['terms_version']);
  const name = asString(b['name']) ?? null; // 任意項目。未指定は null

  if (email === undefined || !EMAIL_RE.test(email))
    throw validationError('メールアドレスが不正です');
  if (password === undefined || password.length < PASSWORD_MIN) {
    throw validationError(`パスワードは${String(PASSWORD_MIN)}文字以上が必要です`);
  }
  if (termsVersion === undefined || termsVersion === '')
    throw validationError('terms_version が必要です');
  return { email, password, name, termsVersion };
}

/**
 * ログインリクエスト本文を検証する。
 *
 * @param body `req.body`（型は `unknown`）
 * @returns 検証済みのログイン入力
 * @throws {AppError} 422 `validation_error` — 本文が非オブジェクト、または email/password 欠落
 */
export function parseLogin(body: unknown): LoginInput {
  if (typeof body !== 'object' || body === null) throw validationError('リクエスト本文が不正です');
  const b = body as Record<string, unknown>;
  const email = asString(b['email']);
  const password = asString(b['password']);
  // ログインでは register と違いメール「形式」までは検査しない（意図的に緩い）。
  // 形式不正なメールはどの会員にも一致せず 401 になるだけで、ここで 422 にして
  // 形式ルールを攻撃者に伝える必要がない。存在チェック（空でない）のみ行う。
  if (email === undefined || email === '') throw validationError('メールアドレスが必要です');
  if (password === undefined || password === '') throw validationError('パスワードが必要です');
  return { email, password };
}

/**
 * refresh / logout リクエスト本文を検証する（`refresh_token` 必須）。
 *
 * @param body `req.body`（型は `unknown`）
 * @returns 検証済みの `{ refreshToken }`
 * @throws {AppError} 422 `validation_error` — 本文が非オブジェクト、`refresh_token` 欠落、または長すぎる場合
 */
export function parseRefreshToken(body: unknown): RefreshTokenBody {
  if (typeof body !== 'object' || body === null) throw validationError('リクエスト本文が不正です');
  const b = body as Record<string, unknown>; // 他の parse 関数と書き方をそろえる
  const refreshToken = asString(b['refresh_token']);
  if (refreshToken === undefined || refreshToken === '')
    throw validationError('refresh_token が必要です');
  // 多層防御: 正規トークンは base64url 43文字固定。極端に長い入力は早期に弾く
  // （express.json の 100KB 制限に依存しない上限長チェック）。
  if (refreshToken.length > REFRESH_TOKEN_MAX_LEN)
    throw validationError('refresh_token が不正です');
  return { refreshToken };
}
