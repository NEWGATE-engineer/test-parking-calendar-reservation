import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/passwords.js';
import type { AuthRepository, UserRow } from '../src/auth/repository.js';
import { createAuthRouter } from '../src/auth/router.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { makeMockRepo } from './helpers/mockRepo.js';

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

function buildTestApp(repo: AuthRepository = makeMockRepo()): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(repo));
  app.use(errorHandler);
  return app;
}

describe('POST /auth/register', () => {
  it('201 で TokenResponse を返す', async () => {
    const res = await request(buildTestApp())
      .post('/auth/register')
      .send({ email: 'a@b.com', password: '12345678', terms_version: '2026-01' });
    expect(res.status).toBe(201);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('入力不正は 422 validation_error', async () => {
    const res = await request(buildTestApp())
      .post('/auth/register')
      .send({ email: 'bad', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
  });

  it('メール重複は 409', async () => {
    const app = buildTestApp(makeMockRepo());
    const body = { email: 'a@b.com', password: '12345678', terms_version: 'x' };
    await request(app).post('/auth/register').send(body);
    const res = await request(app).post('/auth/register').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_conflict');
  });
});

describe('POST /auth/login', () => {
  it('正しい資格情報は 200 で TokenResponse を返す', async () => {
    const repo = makeMockRepo([await seededUser()]);
    const res = await request(buildTestApp(repo))
      .post('/auth/login')
      .send({ email: 'a@b.com', password: '12345678' });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('誤った資格情報は 401', async () => {
    const res = await request(buildTestApp())
      .post('/auth/login')
      .send({ email: 'none@x.com', password: '12345678' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_credentials');
  });

  it('入力欠落は 422', async () => {
    const res = await request(buildTestApp()).post('/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(422);
  });
});

describe('POST /auth/refresh', () => {
  it('正しいリフレッシュトークンで 200・新トークン', async () => {
    const app = buildTestApp(); // 同一 app（＝同一 repo）で登録→更新
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'a@b.com', password: '12345678', terms_version: 'x' });
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: reg.body.refresh_token });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(reg.body.refresh_token);
  });

  it('不明なトークンは 401 invalid_token', async () => {
    const res = await request(buildTestApp()).post('/auth/refresh').send({ refresh_token: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_token'); // 401 の中の意味も検証
  });

  it('ローテーション後に旧トークンを再使用すると 401 token_reused（HTTP 層）', async () => {
    const app = buildTestApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'a@b.com', password: '12345678', terms_version: 'x' });
    await request(app).post('/auth/refresh').send({ refresh_token: reg.body.refresh_token });
    const reuse = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: reg.body.refresh_token });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('token_reused'); // invalid_token と区別される
  });

  it('refresh_token 欠落は 422', async () => {
    const res = await request(buildTestApp()).post('/auth/refresh').send({});
    expect(res.status).toBe(422);
  });
});

describe('POST /auth/logout', () => {
  it('Bearer 無しは 401', async () => {
    const res = await request(buildTestApp()).post('/auth/logout').send({ refresh_token: 'x' });
    expect(res.status).toBe(401);
  });

  it('認証あり＋refresh_token で 204', async () => {
    const app = buildTestApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'a@b.com', password: '12345678', terms_version: 'x' });
    const res = await request(app)
      .post('/auth/logout')
      .set('authorization', `Bearer ${reg.body.access_token}`)
      .send({ refresh_token: reg.body.refresh_token });
    expect(res.status).toBe(204);
  });

  it('認証ありでも refresh_token 欠落は 422', async () => {
    const app = buildTestApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'a@b.com', password: '12345678', terms_version: 'x' });
    const res = await request(app)
      .post('/auth/logout')
      .set('authorization', `Bearer ${reg.body.access_token}`)
      .send({}); // refresh_token なし
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
  });
});
