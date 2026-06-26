import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  sha256,
  signAccessToken,
  verifyAccessToken,
} from '../src/auth/tokens.js';

const secret = process.env['JWT_SECRET'] as string;

describe('access token', () => {
  it('sign → verify で sub が一致する', () => {
    const token = signAccessToken('user-1');
    expect(verifyAccessToken(token).sub).toBe('user-1');
  });

  it('sub を持たないトークンは検証で弾く', () => {
    const token = jwt.sign({}, secret, { algorithm: 'HS256', expiresIn: 60 });
    expect(() => verifyAccessToken(token)).toThrow();
  });

  it('期限切れトークンは検証で弾く', () => {
    const token = jwt.sign({}, secret, { algorithm: 'HS256', subject: 'user-1', expiresIn: -10 });
    expect(() => verifyAccessToken(token)).toThrow();
  });
});

describe('refresh token', () => {
  it('raw 文字列と 32byte ハッシュを返し、sha256(raw) と一致する', () => {
    const r = generateRefreshToken();
    expect(typeof r.raw).toBe('string');
    expect(r.raw.length).toBeGreaterThan(20);
    expect(r.hash).toHaveLength(32);
    expect(sha256(r.raw).equals(r.hash)).toBe(true);
  });

  it('生成ごとに異なる値になる', () => {
    expect(generateRefreshToken().raw).not.toBe(generateRefreshToken().raw);
  });
});
