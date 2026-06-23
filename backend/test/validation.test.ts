import { describe, it, expect } from 'vitest';
import { parseRegister, parseLogin } from '../src/auth/validation.js';
import { AppError } from '../src/http/errors.js';

describe('parseRegister', () => {
  it('正常な入力を受理（name 省略は null）', () => {
    const r = parseRegister({ email: 'a@b.com', password: '12345678', terms_version: '2026-01' });
    expect(r).toEqual({ email: 'a@b.com', password: '12345678', name: null, termsVersion: '2026-01' });
  });

  it('メール不正は 422', () => {
    expect(() => parseRegister({ email: 'bad', password: '12345678', terms_version: 'x' })).toThrow(AppError);
  });

  it('パスワード8文字未満は 422', () => {
    expect(() => parseRegister({ email: 'a@b.com', password: 'short', terms_version: 'x' })).toThrow(AppError);
  });

  it('terms_version 欠落は 422', () => {
    expect(() => parseRegister({ email: 'a@b.com', password: '12345678' })).toThrow(AppError);
  });
});

describe('parseLogin', () => {
  it('正常な入力を受理', () => {
    expect(parseLogin({ email: 'a@b.com', password: 'x' })).toEqual({ email: 'a@b.com', password: 'x' });
  });

  it('欠落は 422', () => {
    expect(() => parseLogin({ email: 'a@b.com' })).toThrow(AppError);
  });
});
