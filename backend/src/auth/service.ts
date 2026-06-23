import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './passwords.js';
import { signAccessToken, generateRefreshToken } from './tokens.js';
import { type AuthRepository, DuplicateEmailError, type CreateUserInput } from './repository.js';
import type { RegisterInput, LoginInput } from './validation.js';

/**
 * 認証ユースケース（会員登録・ログイン）。
 *
 * バリデーション済み入力を受け取り、パスワード照合・トークン発行・DB 更新を組み立てる。
 * データアクセスは {@link AuthRepository} を注入して行うため、テストではモックを渡せる。
 *
 * @module auth/service
 */

/** OpenAPI の `TokenResponse` に対応する発行結果。 */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  /** アクセストークンの有効秒数。 */
  expires_in: number;
}

/** 認証ユースケースの実装。 */
export class AuthService {
  /**
   * @param repo データアクセス層（本番は SqlAuthRepository、テストはモック）
   */
  constructor(private readonly repo: AuthRepository) {}

  /**
   * アクセス＋リフレッシュのトークンペアを発行し、リフレッシュを新しい family で保存する。
   *
   * リフレッシュは平文をクライアントに返し、サーバには SHA-256 のみ保存する。
   *
   * @param userId トークンを発行する対象ユーザー
   * @returns クライアントへ返す {@link TokenResponse}
   */
  private async issueTokens(userId: string): Promise<TokenResponse> {
    const refresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSec * 1000);
    // 保存するのはハッシュのみ。family_id は新規採番（この系統の起点）
    await this.repo.insertRefreshToken({
      userId,
      familyId: randomUUID(),
      tokenHash: refresh.hash,
      expiresAt,
    });
    return {
      access_token: signAccessToken(userId),
      refresh_token: refresh.raw, // 平文はこの応答でのみ返す
      token_type: 'Bearer',
      expires_in: config.jwt.accessTtlSec,
    };
  }

  /**
   * 会員登録（`POST /auth/register` 相当）。
   *
   * パスワードを bcrypt 化し、User と Consent を作成してトークンを発行する。
   *
   * @param input 検証済みの登録入力
   * @returns 発行したトークン（呼び出し側が 201 で返す）
   * @throws {AppError} 409 `email_conflict` — メールアドレスが既に登録済みの場合
   */
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
      // DB のユニーク違反由来のメール重複を 409 に変換する
      if (err instanceof DuplicateEmailError) {
        throw new AppError(409, 'email_conflict', 'このメールアドレスは既に登録されています');
      }
      throw err;
    }
    return this.issueTokens(userId);
  }

  /**
   * ログイン（`POST /auth/login` 相当）。
   *
   * 手順: ①メールで会員取得 → ②ロック確認 → ③パスワード照合 →
   * ④失敗なら失敗記録、成功ならカウントをリセットしてトークン発行。
   *
   * @param input 検証済みのログイン入力
   * @returns 発行したトークン（呼び出し側が 200 で返す）
   * @throws {AppError} 401 `invalid_credentials` — メール不存在 or パスワード不一致（列挙を避け同一応答）
   * @throws {AppError} 429 `account_locked` — 連続失敗でロック中の場合
   */
  async login(input: LoginInput): Promise<TokenResponse> {
    const user = await this.repo.findUserByEmail(input.email);

    // ① ユーザー不在でもダミー比較で処理時間をそろえ、メール存在の推測（列挙）を抑止する
    if (user === null) {
      await verifyPassword(input.password, DUMMY_HASH);
      throw new AppError(401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
    }

    // ② アカウントロック中（F1-5）。lock_until が未来なら拒否
    if (user.lock_until !== null && user.lock_until.getTime() > Date.now()) {
      throw new AppError(429, 'account_locked', 'ログイン試行が多すぎます。しばらくしてからお試しください', true);
    }

    // ③ パスワード照合
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      // ④a 失敗を記録（閾値到達で自動ロック）。同一メッセージで列挙を防ぐ
      await this.repo.recordLoginFailure(user.id, config.login.maxFailedAttempts, config.login.lockMinutes);
      throw new AppError(401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
    }

    // ④b 成功。失敗カウント・ロックを解除してトークン発行
    await this.repo.resetLoginFailures(user.id);
    return this.issueTokens(user.id);
  }
}
