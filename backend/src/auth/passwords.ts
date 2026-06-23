import bcrypt from 'bcryptjs';

/**
 * パスワードのハッシュ化・照合（認証設計§5）。
 *
 * パスワードは必ず bcrypt でハッシュして保存し、平文・可逆暗号は使わない。
 * ネイティブビルドが要らない `bcryptjs`（bcrypt 互換ハッシュ）を採用している。
 *
 * @module auth/passwords
 */

/**
 * bcrypt のコストファクタ（ストレッチ回数の指数）。
 * 大きいほど総当たり耐性が上がるが計算が重くなる。認証設計の推奨値 ~12。
 */
const COST = 12;

/**
 * 平文パスワードを bcrypt でハッシュ化する。
 *
 * @param plain ユーザーが入力した平文パスワード
 * @returns ソルトを内包した bcrypt ハッシュ文字列（`$2...`）。そのまま DB に保存してよい
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

/**
 * 平文パスワードが保存済みハッシュと一致するか照合する。
 *
 * @param plain 照合する平文パスワード
 * @param hash 保存済みの bcrypt ハッシュ（`hashPassword` の出力）
 * @returns 一致すれば `true`、不一致なら `false`（例外は投げない）
 */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * ログイン時、ユーザーが存在しない場合でも照合と同等の処理時間を消費するためのダミーハッシュ。
 *
 * これを比較に通すことで「メールが存在する場合だけ遅い」という応答時間差を無くし、
 * メールアドレスの存在をタイミングから推測される攻撃（ユーザー列挙）を抑止する。
 * 形式上は正しい bcrypt ハッシュだが、実在パスワードには一致しない。
 */
export const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO0000000000000000000000000000000000';
