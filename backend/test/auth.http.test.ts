import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../src/auth/router.js';
import { errorHandler } from '../src/http/errorHandler.js';
import { makeMockRepo } from './helpers/mockRepo.js';
import type { AuthRepository } from '../src/auth/repository.js';

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
