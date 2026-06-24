import { vi } from 'vitest';
import {
  type AuthRepository,
  type UserRow,
  type CreateUserInput,
  type InsertRefreshTokenInput,
  type RefreshTokenRow,
  DuplicateEmailError,
} from '../../src/auth/repository.js';

/** モック内部で保持するリフレッシュトークン1件。 */
interface StoredRefresh {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  revoked_at: Date | null;
  expires_at: Date;
}

/** モックが公開する追加状態（テストの検証用）。 */
export interface MockRepoState {
  users: UserRow[];
  refreshTokens: StoredRefresh[];
  refreshInserts: number;
}

/**
 * テスト用のインメモリ {@link AuthRepository}。各メソッドは vi.fn でスパイ可能。
 *
 * @param seedUsers 初期投入する User 行
 * @returns AuthRepository 実装＋検証用の内部状態（users / refreshTokens / refreshInserts）
 */
export function makeMockRepo(seedUsers: UserRow[] = []): AuthRepository & MockRepoState {
  const users = [...seedUsers];
  const refreshTokens: StoredRefresh[] = [];
  let nextUserId = users.length + 1;
  let nextRtId = 1;

  return {
    users,
    refreshTokens,
    get refreshInserts() {
      return refreshTokens.length;
    },

    findUserByEmail: vi.fn((email: string): Promise<UserRow | null> => {
      return Promise.resolve(users.find((u) => u.email === email) ?? null);
    }),

    createUserWithConsent: vi.fn((input: CreateUserInput): Promise<string> => {
      if (users.some((u) => u.email === input.email)) return Promise.reject(new DuplicateEmailError());
      const id = `user-${String(nextUserId++)}`;
      users.push({
        id,
        email: input.email,
        password_hash: input.passwordHash,
        status: 'active',
        failed_attempts: 0,
        lock_until: null,
      });
      return Promise.resolve(id);
    }),

    recordLoginFailure: vi.fn((userId: string, max: number, lockMin: number): Promise<void> => {
      const u = users.find((x) => x.id === userId);
      if (u && u.status === 'active') {
        u.failed_attempts += 1;
        if (u.failed_attempts >= max) u.lock_until = new Date(Date.now() + lockMin * 60_000);
      }
      return Promise.resolve();
    }),

    resetLoginFailures: vi.fn((userId: string): Promise<void> => {
      const u = users.find((x) => x.id === userId);
      if (u) {
        u.failed_attempts = 0;
        u.lock_until = null;
      }
      return Promise.resolve();
    }),

    insertRefreshToken: vi.fn((input: InsertRefreshTokenInput): Promise<void> => {
      refreshTokens.push({
        id: `rt-${String(nextRtId++)}`,
        user_id: input.userId,
        family_id: input.familyId,
        token_hash: input.tokenHash,
        revoked_at: null,
        expires_at: input.expiresAt,
      });
      return Promise.resolve();
    }),

    findRefreshTokenByHash: vi.fn((tokenHash: Buffer): Promise<RefreshTokenRow | null> => {
      const t = refreshTokens.find((x) => x.token_hash.equals(tokenHash));
      if (!t) return Promise.resolve(null);
      return Promise.resolve({
        id: t.id,
        user_id: t.user_id,
        family_id: t.family_id,
        revoked_at: t.revoked_at,
        expires_at: t.expires_at,
      });
    }),

    revokeRefreshTokenById: vi.fn((id: string): Promise<boolean> => {
      const t = refreshTokens.find((x) => x.id === id);
      if (t && t.revoked_at === null) {
        t.revoked_at = new Date();
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    }),

    revokeFamily: vi.fn((familyId: string): Promise<void> => {
      for (const t of refreshTokens) {
        if (t.family_id === familyId && t.revoked_at === null) t.revoked_at = new Date();
      }
      return Promise.resolve();
    }),

    revokeRefreshTokenByHashForUser: vi.fn((userId: string, tokenHash: Buffer): Promise<void> => {
      const t = refreshTokens.find(
        (x) => x.user_id === userId && x.token_hash.equals(tokenHash) && x.revoked_at === null,
      );
      if (t) t.revoked_at = new Date();
      return Promise.resolve();
    }),
  };
}
