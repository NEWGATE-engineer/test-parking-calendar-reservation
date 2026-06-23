import { validationError } from '../http/errors.js';

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

  if (email === undefined || !EMAIL_RE.test(email)) throw validationError('メールアドレスが不正です');
  if (password === undefined || password.length < PASSWORD_MIN) {
    throw validationError(`パスワードは${String(PASSWORD_MIN)}文字以上が必要です`);
  }
  if (termsVersion === undefined || termsVersion === '') throw validationError('terms_version が必要です');
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
