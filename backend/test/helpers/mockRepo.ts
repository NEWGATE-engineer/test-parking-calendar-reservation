import { vi } from 'vitest';
import {
  type AuthRepository,
  type UserRow,
  type CreateUserInput,
  DuplicateEmailError,
} from '../../src/auth/repository.js';

/** テスト用のインメモリ AuthRepository。呼び出しは vi.fn でスパイ可能。 */
export function makeMockRepo(seedUsers: UserRow[] = []): AuthRepository & {
  users: UserRow[];
  refreshInserts: number;
} {
  const users = [...seedUsers];
  let nextId = users.length + 1;
  const state = { users, refreshInserts: 0 };

  return {
    users: state.users,
    get refreshInserts() {
      return state.refreshInserts;
    },
    findUserByEmail: vi.fn(async (email: string): Promise<UserRow | null> => {
      return users.find((u) => u.email === email) ?? null;
    }),
    createUserWithConsent: vi.fn(async (input: CreateUserInput): Promise<string> => {
      if (users.some((u) => u.email === input.email)) throw new DuplicateEmailError();
      const id = `user-${String(nextId++)}`;
      users.push({
        id,
        email: input.email,
        password_hash: input.passwordHash,
        status: 'active',
        failed_attempts: 0,
        lock_until: null,
      });
      return id;
    }),
    recordLoginFailure: vi.fn(async (userId: string, max: number, lockMin: number): Promise<void> => {
      const u = users.find((x) => x.id === userId);
      if (!u) return;
      u.failed_attempts += 1;
      if (u.failed_attempts >= max) u.lock_until = new Date(Date.now() + lockMin * 60_000);
    }),
    resetLoginFailures: vi.fn(async (userId: string): Promise<void> => {
      const u = users.find((x) => x.id === userId);
      if (u) {
        u.failed_attempts = 0;
        u.lock_until = null;
      }
    }),
    insertRefreshToken: vi.fn(async (): Promise<void> => {
      state.refreshInserts += 1;
    }),
  };
}
