import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { hashPassword } from '../src/auth/passwords.js';
import { makeMockRepo } from './helpers/mockRepo.js';
import type { UserRow } from '../src/auth/repository.js';

async function seededUser(password = '12345678'): Promise<UserRow> {
  return {
    id: 'user-1',
    email: 'a@b.com',
    password_hash: await hashPassword(password),
    status: 'active',
    failed_attempts: 0,
    lock_until: null,
  };
}

describe('AuthService.register', () => {
  it('成功でトークン発行＋refresh 保存＋User 作成', async () => {
    const repo = makeMockRepo();
    const res = await new AuthService(repo).register({
      email: 'a@b.com',
      password: '12345678',
      name: null,
      termsVersion: '2026-01',
    });
    expect(res.token_type).toBe('Bearer');
    expect(res.access_token).toBeTruthy();
    expect(res.refresh_token).toBeTruthy();
    expect(res.expires_in).toBeGreaterThan(0);
    expect(repo.refreshInserts).toBe(1);
    expect(repo.users).toHaveLength(1);
  });

  it('メール重複は 409 email_conflict', async () => {
    const repo = makeMockRepo();
    const svc = new AuthService(repo);
    await svc.register({ email: 'a@b.com', password: '12345678', name: null, termsVersion: 'x' });
    await expect(
      svc.register({ email: 'a@b.com', password: '12345678', name: null, termsVersion: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'email_conflict' });
  });
});

describe('AuthService.login', () => {
  it('成功でトークン発行＋失敗カウントをリセット', async () => {
    const repo = makeMockRepo([await seededUser()]);
    const res = await new AuthService(repo).login({ email: 'a@b.com', password: '12345678' });
    expect(res.access_token).toBeTruthy();
    expect(repo.resetLoginFailures).toHaveBeenCalledWith('user-1');
  });

  it('パスワード誤りは 401 ＋失敗を記録', async () => {
    const repo = makeMockRepo([await seededUser()]);
    await expect(
      new AuthService(repo).login({ email: 'a@b.com', password: 'wrong-pass' }),
    ).rejects.toMatchObject({ httpStatus: 401, code: 'invalid_credentials' });
    expect(repo.recordLoginFailure).toHaveBeenCalled();
  });

  it('ユーザー不在は 401（列挙を避け同一メッセージ）', async () => {
    const repo = makeMockRepo();
    await expect(
      new AuthService(repo).login({ email: 'none@x.com', password: '12345678' }),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('ロック中は 429 account_locked', async () => {
    const user = await seededUser();
    user.lock_until = new Date(Date.now() + 60_000);
    const repo = makeMockRepo([user]);
    await expect(
      new AuthService(repo).login({ email: 'a@b.com', password: '12345678' }),
    ).rejects.toMatchObject({ httpStatus: 429, code: 'account_locked' });
  });
});
