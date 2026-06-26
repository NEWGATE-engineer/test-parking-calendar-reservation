import dotenv from 'dotenv';

/**
 * アプリ設定。
 *
 * `.env`（開発はローカル Docker、コミット禁止）や App Settings から環境変数を読み込み、
 * 型付きの定数として公開する。秘密値（JWT 署名鍵・接続文字列）はコードに埋め込まない。
 * 必須値が無ければ**起動時に失敗**させ、不完全な状態で動かないようにする。
 *
 * @module config
 */

// .env を process.env に読み込む（既存の環境変数は上書きしない）
dotenv.config();

/**
 * 必須の環境変数を取得する。未設定なら起動時に例外を投げる。
 *
 * @param name 環境変数名
 * @returns その値
 * @throws {Error} 未設定または空文字の場合
 */
function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`環境変数 ${name} が未設定です`);
  }
  return v;
}

/**
 * 数値の環境変数を取得する。未設定なら既定値、数値でなければ例外。
 *
 * @param name 環境変数名
 * @param fallback 未設定時の既定値
 * @returns 数値
 * @throws {Error} 値が数値として解釈できない場合
 */
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} は数値である必要があります: ${v}`);
  return n;
}

/**
 * アプリ全体の設定値。
 *
 * トークン寿命・ロック閾値は仮値（要件定義 §12・認証設計）。確定したら環境変数で上書きする。
 */
export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  /** SQL Server 接続文字列（mssql 形式）。 */
  sqlConnectionString: required('SQL_CONNECTION_STRING'),
  jwt: {
    /** アクセストークンの HS256 署名鍵。リポジトリに置かず .env / Key Vault から。 */
    secret: required('JWT_SECRET'),
    /** アクセストークン有効秒数。仮: 15分。 */
    accessTtlSec: num('JWT_ACCESS_TTL_SEC', 15 * 60),
    /** リフレッシュトークン有効秒数。仮: 14日。 */
    refreshTtlSec: num('JWT_REFRESH_TTL_SEC', 14 * 24 * 60 * 60),
  },
  /** ログインのレート制限・アカウントロック（F1-5）。値は仮（要件 §12）。 */
  login: {
    /** この回数の連続失敗でロックする。仮: 5回。 */
    maxFailedAttempts: num('LOGIN_MAX_FAILED', 5),
    /** ロックする分数。仮: 15分。 */
    lockMinutes: num('LOGIN_LOCK_MINUTES', 15),
  },
  /** 予約ドメインの設定。いずれも仮値（要件 §12。確定したら env で上書き）。 */
  reservation: {
    /** 近接予約のバッファ時間 B（§12 #4）。仮: 15分。 */
    bufferMinutes: num('RESERVATION_BUFFER_MIN', 15),
    /** 料金単価（§12 #1）。仮: unitMinutes ごとに unitPriceJpy 円。 */
    unitPriceJpy: num('RESERVATION_UNIT_PRICE_JPY', 100),
    /** 課金単位（分）。仮: 30分。 */
    unitMinutes: num('RESERVATION_UNIT_MINUTES', 30),
  },
  /** デバイス健全性（§8・§12 #14）。仮値。 */
  device: {
    /** last_seen_at がこの分数以内なら健全とみなす。仮: 10分。 */
    healthThresholdMinutes: num('DEVICE_HEALTH_THRESHOLD_MIN', 10),
  },
} as const;
