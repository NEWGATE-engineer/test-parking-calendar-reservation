import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

describe('passwords', () => {
  it('hash した値は verify で一致し、誤りは不一致', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('bcrypt ハッシュ形式（$2 で始まる）', async () => {
    const hash = await hashPassword('whatever123');
    expect(hash.startsWith('$2')).toBe(true);
  });
});
