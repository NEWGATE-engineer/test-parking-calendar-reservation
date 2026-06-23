import { validationError } from '../http/errors.js';

// 簡易メール形式チェック（厳密判定はせず、明らかな不正のみ弾く）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

export interface RegisterInput {
  email: string;
  password: string;
  name: string | null;
  termsVersion: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function parseRegister(body: unknown): RegisterInput {
  if (typeof body !== 'object' || body === null) throw validationError('リクエスト本文が不正です');
  const b = body as Record<string, unknown>;
  const email = asString(b['email']);
  const password = asString(b['password']);
  const termsVersion = asString(b['terms_version']);
  const name = asString(b['name']) ?? null;

  if (email === undefined || !EMAIL_RE.test(email)) throw validationError('メールアドレスが不正です');
  if (password === undefined || password.length < PASSWORD_MIN) {
    throw validationError(`パスワードは${PASSWORD_MIN}文字以上が必要です`);
  }
  if (termsVersion === undefined || termsVersion === '') throw validationError('terms_version が必要です');
  return { email, password, name, termsVersion };
}

export function parseLogin(body: unknown): LoginInput {
  if (typeof body !== 'object' || body === null) throw validationError('リクエスト本文が不正です');
  const b = body as Record<string, unknown>;
  const email = asString(b['email']);
  const password = asString(b['password']);
  if (email === undefined || email === '') throw validationError('メールアドレスが必要です');
  if (password === undefined || password === '') throw validationError('パスワードが必要です');
  return { email, password };
}
