import bcrypt from 'bcryptjs';

/**
 * パスワードのハッシュ化・照合（認証設計§5）。
 *
 * パスワードは必ず bcrypt でハッシュして保存し、平文・可逆暗号は使わない。
 * ネイティブビルドが要らない `bcryptjs`（bcrypt 互換ハッシュ）を採用している。
 *
 * トレードオフ（MVP として許容）: `bcryptjs` は純 JS のためハッシュ計算が libuv の
 * スレッドプールに逃げず、コスト12で 1 回あたり数百 ms メインスレッドを占有する。
 * 高同時実行ではレイテンシに影響するため、本番でスケールが要るときは native `bcrypt`
 * へ差し替えるか worker_threads にオフロードする（API は同じなので後から切替可能）。
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
 * 形式上は正しい bcrypt ハッシュ（コスト 12 = 上記 COST と同水準）だが、実在パスワードには
 * 一致しない。COST を変えたらこの値のコスト部（`$2a$12$`）も合わせると時間差がより正確にそろう。
 */
export const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO0000000000000000000000000000000000';
