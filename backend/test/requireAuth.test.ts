import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/http/errorHandler.js';
import { requireAuth } from '../src/http/requireAuth.js';

function appWithGuard(): express.Express {
  const app = express();
  app.get('/me', requireAuth, (req, res) => {
    res.json({ userId: req.userId });
  });
  app.use(errorHandler);
  return app;
}

const secret = process.env['JWT_SECRET'] as string;

describe('requireAuth', () => {
  it('Authorization 無しは 401 unauthorized', async () => {
    const res = await request(appWithGuard()).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('改ざん/不正トークンは 401', async () => {
    const res = await request(appWithGuard()).get('/me').set('authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('有効な HS256 トークンは通過し userId を設定する', async () => {
    const token = jwt.sign({ sub: 'user-123' }, secret, { algorithm: 'HS256', expiresIn: 60 });
    const res = await request(appWithGuard()).get('/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-123');
  });

  it('期限切れトークンは 401', async () => {
    const token = jwt.sign({ sub: 'user-123' }, secret, { algorithm: 'HS256', expiresIn: -10 });
    const res = await request(appWithGuard()).get('/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('別の鍵で署名されたトークンは 401', async () => {
    const token = jwt.sign({ sub: 'user-123' }, 'wrong-secret', {
      algorithm: 'HS256',
      expiresIn: 60,
    });
    const res = await request(appWithGuard()).get('/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
