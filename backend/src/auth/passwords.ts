import bcrypt from 'bcryptjs';

// 認証設計§5: パスワードは bcrypt（コストファクタ ~12）でハッシュ。平文保存は不可。
// ネイティブビルド不要の bcryptjs を採用（bcrypt 互換ハッシュ）。
const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ユーザー不在時もハッシュ比較の時間をそろえ、メール存在の有無を時間差から推測されにくくするためのダミー。
// 形式上の bcrypt ハッシュ（実在パスワードには一致しない）。
export const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO0000000000000000000000000000000000';
