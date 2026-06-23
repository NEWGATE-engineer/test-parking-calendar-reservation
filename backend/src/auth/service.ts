import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './passwords.js';
import { signAccessToken, generateRefreshToken } from './tokens.js';
import {
  type AuthRepository,
  DuplicateEmailError,
  type CreateUserInput,
} from './repository.js';
import type { RegisterInput, LoginInput } from './validation.js';

/** OpenAPI TokenResponse に対応する発行結果。 */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** 認証ユースケース。AuthRepository を注入し、テストではモックを渡す。 */
export class AuthService {
  constructor(private readonly repo: AuthRepository) {}

  /** トークンペアを発行し、リフレッシュトークンを新規 family で保存する。 */
  private async issueTokens(userId: string): Promise<TokenResponse> {
    const refresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSec * 1000);
    await this.repo.insertRefreshToken({
      userId,
      familyId: randomUUID(),
      tokenHash: refresh.hash,
      expiresAt,
    });
    return {
      access_token: signAccessToken(userId),
      refresh_token: refresh.raw,
      token_type: 'Bearer',
      expires_in: config.jwt.accessTtlSec,
    };
  }

  async register(input: RegisterInput): Promise<TokenResponse> {
    const passwordHash = await hashPassword(input.password);
    const insert: CreateUserInput = {
      email: input.email,
      passwordHash,
      name: input.name,
      termsVersion: input.termsVersion,
    };
    let userId: string;
    try {
      userId = await this.repo.createUserWithConsent(insert);
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        throw new AppError(409, 'email_conflict', 'このメールアドレスは既に登録されています');
      }
      throw err;
    }
    return this.issueTokens(userId);
  }

  async login(input: LoginInput): Promise<TokenResponse> {
    const user = await this.repo.findUserByEmail(input.email);

    // ユーザー不在でもダミー比較で時間をそろえ、メール存在の推測を抑止する。
    if (user === null) {
      await verifyPassword(input.password, DUMMY_HASH);
      throw new AppError(401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
    }

    // アカウントロック中（F1-5）
    if (user.lock_until !== null && user.lock_until.getTime() > Date.now()) {
      throw new AppError(429, 'account_locked', 'ログイン試行が多すぎます。しばらくしてからお試しください', true);
    }

    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      await this.repo.recordLoginFailure(user.id, config.login.maxFailedAttempts, config.login.lockMinutes);
      throw new AppError(401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
    }

    await this.repo.resetLoginFailures(user.id);
    return this.issueTokens(user.id);
  }
}
