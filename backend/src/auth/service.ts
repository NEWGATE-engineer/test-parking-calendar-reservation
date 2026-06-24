import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './passwords.js';
import { signAccessToken, generateRefreshToken, sha256 } from './tokens.js';
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
   * アクセス＋リフレッシュのトークンペアを発行し、リフレッシュトークンを保存する。
   *
   * リフレッシュは平文をクライアントに返し、サーバには SHA-256 のみ保存する。
   * `familyId` を渡すとその系統で発行（＝ローテーション）、省略すると新規系統を起点にする。
   *
   * @param userId トークンを発行する対象ユーザー
   * @param familyId 系統 ID（省略時は新規採番＝ログイン/登録の起点）
   * @returns クライアントへ返す {@link TokenResponse}
   */
  private async issueTokens(userId: string, familyId: string = randomUUID()): Promise<TokenResponse> {
    const refresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSec * 1000);
    // 保存するのはハッシュのみ。family_id はログイン/登録で新規、refresh では引き継ぐ
    await this.repo.insertRefreshToken({
      userId,
      familyId,
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
   * @throws {AppError} 403 `account_disabled` — 退会等で `status` が `active` でない場合
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

    // ④b アカウント状態の確認（退会等の無効アカウントはトークンを発行しない）。
    // パスワード照合に成功した後に判定することで、誤パスワード試行に対しては
    // 「アカウントが無効」という情報を返さず列挙を防ぐ（OWASP A07）。
    if (user.status !== 'active') {
      throw new AppError(403, 'account_disabled', 'このアカウントは利用できません');
    }

    // ④c 成功。失敗カウント・ロックを解除してトークン発行
    await this.repo.resetLoginFailures(user.id);
    return this.issueTokens(user.id);
  }

  /**
   * トークン再発行（`POST /auth/refresh` 相当）＝リフレッシュトークンのローテーション。
   *
   * 手順（認証設計§3）: ①ハッシュで照合 → ②失効済みの再使用なら系統一括失効 →
   * ③期限切れは拒否 → ④`revoked_at IS NULL` の条件付き UPDATE で旧トークンを失効、
   * 1件成功した側だけ同じ family で新ペアを発行。0件なら再使用とみなし系統失効。
   *
   * @param rawToken クライアントが提示したリフレッシュトークン平文
   * @returns 新しい {@link TokenResponse}（access + 新 refresh）
   * @throws {AppError} 401 `invalid_token` — トークンが存在しない（不明）場合
   * @throws {AppError} 401 `invalid_token` — トークンが期限切れの場合
   * @throws {AppError} 401 `token_reused` — 失効済みトークンの再使用・並行使用（系統を一括失効）
   */
  async refresh(rawToken: string): Promise<TokenResponse> {
    const tokenHash = sha256(rawToken);
    const row = await this.repo.findRefreshTokenByHash(tokenHash);

    // ① 不明なトークン（存在しない）。失効すべき family も分からないので単に拒否
    if (row === null) {
      throw new AppError(401, 'invalid_token', 'リフレッシュトークンが無効です');
    }

    // ② 既に失効済みトークンの再使用 = 盗難・複製の兆候。系統(family)を全失効して締め出す
    if (row.revoked_at !== null) {
      await this.repo.revokeFamily(row.family_id);
      throw new AppError(401, 'token_reused', 'リフレッシュトークンが再使用されました。再ログインしてください');
    }

    // ③ 期限切れ
    if (row.expires_at.getTime() <= Date.now()) {
      throw new AppError(401, 'invalid_token', 'リフレッシュトークンの有効期限が切れています');
    }

    // ④ ローテーション: 旧トークンを条件付きで失効。勝者（1件失効できた側）だけ新ペアを発行
    const won = await this.repo.revokeRefreshTokenById(row.id);
    if (!won) {
      // 読み取りから更新までの間に他者が失効済み = 並行した再使用。系統を全失効
      await this.repo.revokeFamily(row.family_id);
      throw new AppError(401, 'token_reused', 'リフレッシュトークンが再使用されました。再ログインしてください');
    }
    return this.issueTokens(row.user_id, row.family_id);
  }

  /**
   * ログアウト（`POST /auth/logout` 相当）。
   *
   * 本人のリフレッシュトークンを失効する。アクセストークンは短命なためクライアントが破棄する
   * 前提で、MVP では access の denylist は持たない（認証設計§4）。
   * 既に失効済み・存在しない場合も成功扱い（冪等）。
   *
   * @param userId 認証済みユーザー（requireAuth が設定した sub）
   * @param rawToken 失効するリフレッシュトークン平文
   * @throws 業務例外は投げない（冪等。既に失効済み・不存在でも成功扱い）。
   *   DB 障害などの想定外例外は捕捉せずそのまま伝播し、errorHandler が 500 にする。
   */
  async logout(userId: string, rawToken: string): Promise<void> {
    await this.repo.revokeRefreshTokenByHashForUser(userId, sha256(rawToken));
  }
}
