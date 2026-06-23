import dotenv from 'dotenv';

dotenv.config();

/** 必須環境変数を取得。未設定なら起動時に失敗させる。 */
function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`環境変数 ${name} が未設定です`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} は数値である必要があります: ${v}`);
  return n;
}

/**
 * アプリ設定。秘密値はリポジトリに置かず .env / App Settings から読む。
 * トークン寿命は仮値（要件定義 §12・認証設計）。確定時は環境変数で上書きする。
 */
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  sqlConnectionString: required('SQL_CONNECTION_STRING'),
  jwt: {
    secret: required('JWT_SECRET'),
    accessTtlSec: num('JWT_ACCESS_TTL_SEC', 15 * 60), // 仮: 15分
    refreshTtlSec: num('JWT_REFRESH_TTL_SEC', 14 * 24 * 60 * 60), // 仮: 14日
  },
} as const;
