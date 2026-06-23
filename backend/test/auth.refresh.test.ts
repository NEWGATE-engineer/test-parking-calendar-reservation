import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { sha256, verifyAccessToken } from '../src/auth/tokens.js';
import { makeMockRepo } from './helpers/mockRepo.js';

/** 登録して返ってきたリフレッシュトークン（平文）と repo を用意するヘルパ。 */
async function registered() {
  const repo = makeMockRepo();
  const svc = new AuthService(repo);
  const reg = await svc.register({ email: 'a@b.com', password: '12345678', name: null, termsVersion: 'x' });
  return { repo, svc, reg };
}

describe('AuthService.refresh', () => {
  it('正常ローテーション: 新トークン発行・旧トークン失効・family 維持', async () => {
    const { repo, svc, reg } = await registered();
    const oldRaw = reg.refresh_token;

    const res = await svc.refresh(oldRaw);
    expect(res.access_token).toBeTruthy();
    expect(res.refresh_token).not.toBe(oldRaw); // 値がローテーションされている
    expect(repo.refreshInserts).toBe(2); // register + rotation で2件

    const old = repo.refreshTokens.find((t) => t.token_hash.equals(sha256(oldRaw)));
    const fresh = repo.refreshTokens.find((t) => t.token_hash.equals(sha256(res.refresh_token)));
    expect(old?.revoked_at).not.toBeNull(); // 旧トークンは失効済み
    expect(fresh?.revoked_at).toBeNull(); // 新トークンは有効
    expect(fresh?.family_id).toBe(old?.family_id); // family は維持される
  });

  it('並行競合（revokeRefreshTokenById が false）は 401 token_reused かつ family 全失効', async () => {
    const { repo, svc, reg } = await registered();
    // 読み取り後の条件付き UPDATE が 0 件＝他者が先に失効した状況を再現
    repo.revokeRefreshTokenById.mockResolvedValueOnce(false);
    await expect(svc.refresh(reg.refresh_token)).rejects.toMatchObject({
      httpStatus: 401,
      code: 'token_reused',
    });
    expect(repo.revokeFamily).toHaveBeenCalledTimes(1);
  });

  it('失効済みトークンの再使用は 401 token_reused かつ family 全失効', async () => {
    const { repo, svc, reg } = await registered();
    const oldRaw = reg.refresh_token;
    const next = await svc.refresh(oldRaw); // 1回ローテーション（旧を失効）

    // 旧トークンをもう一度使う＝再使用 → 系統一括失効
    await expect(svc.refresh(oldRaw)).rejects.toMatchObject({ httpStatus: 401, code: 'token_reused' });

    // 直近に発行した新トークンも family 失効で無効化されている
    const newer = repo.refreshTokens.find((t) => t.token_hash.equals(sha256(next.refresh_token)));
    expect(newer?.revoked_at).not.toBeNull();
  });

  it('不明なトークンは 401 invalid_token', async () => {
    const repo = makeMockRepo();
    await expect(new AuthService(repo).refresh('unknown-token')).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_token',
    });
  });

  it('期限切れトークンは 401 invalid_token', async () => {
    const repo = makeMockRepo();
    const raw = 'expired-raw-token';
    // 期限を過去にしたトークンを直接投入
    await repo.insertRefreshToken({
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(new AuthService(repo).refresh(raw)).rejects.toMatchObject({
      httpStatus: 401,
      code: 'invalid_token',
    });
  });

  it('期限切れは再使用ではないので revokeFamily を呼ばない', async () => {
    const repo = makeMockRepo();
    const raw = 'expired-raw-token-2';
    await repo.insertRefreshToken({
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(new AuthService(repo).refresh(raw)).rejects.toMatchObject({ code: 'invalid_token' });
    // 失効済み再使用(②)・並行競合(④)とは違い、期限切れ(③)は系統失効しない
    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('提示したリフレッシュを失効し、以後の再利用は拒否される', async () => {
    const { repo, svc, reg } = await registered();
    const userId = verifyAccessToken(reg.access_token).sub;

    await svc.logout(userId, reg.refresh_token);

    // logout で失効済みになったため、その後の refresh は再使用扱い
    await expect(svc.refresh(reg.refresh_token)).rejects.toMatchObject({ httpStatus: 401, code: 'token_reused' });
    // 当該トークンが実際に失効済みになっていることも確認
    const stored = repo.refreshTokens.find((t) => t.token_hash.equals(sha256(reg.refresh_token)));
    expect(stored?.revoked_at).not.toBeNull();
  });

  it('他ユーザーの refresh_token を指定しても失効しない（越権防止）', async () => {
    const { repo, svc, reg } = await registered();
    const ownerToken = reg.refresh_token;
    // 別人の userId で logout を試みる
    await svc.logout('different-user-id', ownerToken);
    const stored = repo.refreshTokens.find((t) => t.token_hash.equals(sha256(ownerToken)));
    expect(stored?.revoked_at).toBeNull(); // 所有者のトークンは失効していない
  });

  it('冪等: 2回 logout を呼んでも例外にならない', async () => {
    const { svc, reg } = await registered();
    const userId = verifyAccessToken(reg.access_token).sub;
    await svc.logout(userId, reg.refresh_token);
    // 2回目（既に失効済み）も例外なく成功扱い
    await expect(svc.logout(userId, reg.refresh_token)).resolves.toBeUndefined();
  });
});
