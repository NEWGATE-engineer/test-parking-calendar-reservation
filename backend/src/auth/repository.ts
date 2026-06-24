import mssql from 'mssql';
import { getPool } from '../db.js';

/**
 * 認証のデータアクセス層。
 *
 * SQL はすべてパラメータ化（SQL インジェクション防止＝CLAUDE.md 原則）。
 * 業務ロジックは持たず「DB をどう読み書きするか」だけに責務を限定する。
 * サービス層は {@link AuthRepository} 抽象に依存し、テストではモックへ差し替える。
 *
 * @module auth/repository
 */

/** 認証で参照する `[User]` 行（必要な列のみ）。 */
export interface UserRow {
  id: string;
  email: string;
  /** bcrypt ハッシュ。 */
  password_hash: string;
  /** `active` / `withdrawn`。 */
  status: string;
  /** 連続ログイン失敗回数（F1-5）。 */
  failed_attempts: number;
  /** ロック解除時刻（UTC）。`null` は未ロック。 */
  lock_until: Date | null;
}

/** 会員作成の入力。 */
export interface CreateUserInput {
  email: string;
  /** 事前に bcrypt 済みのハッシュ（平文は渡さない）。 */
  passwordHash: string;
  name: string | null;
  /** 同意した規約バージョン（Consent に記録）。 */
  termsVersion: string;
}

/** リフレッシュトークン保存の入力。 */
export interface InsertRefreshTokenInput {
  userId: string;
  /** 系統 ID（ローテーションで引き継ぎ、系統一括失効の単位）。 */
  familyId: string;
  /** 平文の SHA-256（VARBINARY(32)）。 */
  tokenHash: Buffer;
  /** 失効時刻（UTC）。 */
  expiresAt: Date;
}

/** 照合で取得する RefreshToken 行（必要な列のみ）。 */
export interface RefreshTokenRow {
  id: string;
  user_id: string;
  /** 系統 ID（系統一括失効の単位）。 */
  family_id: string;
  /** 失効時刻。`null` は有効。 */
  revoked_at: Date | null;
  /** 失効期限（UTC）。 */
  expires_at: Date;
}

/**
 * メール重複（`UQ_User_email` 違反）を表すドメインエラー。
 * サービス層がこれを捕捉して HTTP 409 に変換する。
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email already exists');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * 認証データアクセスの抽象。
 *
 * 本番は {@link SqlAuthRepository}、テストはモックを注入する。
 */
export interface AuthRepository {
  /**
   * メールアドレスで会員を1件引く。
   * @param email 検索するメールアドレス
   * @returns 該当行、無ければ `null`
   */
  findUserByEmail(email: string): Promise<UserRow | null>;
  /**
   * `[User]` と `Consent` を**単一トランザクション**で作成する。
   * @param input 会員作成情報
   * @returns 作成された `[User].id`
   * @throws {DuplicateEmailError} メールが既に存在する場合
   */
  createUserWithConsent(input: CreateUserInput): Promise<string>;
  /**
   * ログイン失敗を記録する（失敗数+1、閾値到達でロック時刻を設定）。
   * @param userId 対象ユーザー
   * @param maxFailedAttempts ロックに至る失敗回数のしきい値
   * @param lockMinutes ロックする分数
   */
  recordLoginFailure(userId: string, maxFailedAttempts: number, lockMinutes: number): Promise<void>;
  /**
   * ログイン成功時に失敗数・ロックをリセットする。
   * @param userId 対象ユーザー
   */
  resetLoginFailures(userId: string): Promise<void>;
  /**
   * リフレッシュトークンを1件保存する。
   * @param input 保存内容（user/family/hash/expires）
   */
  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void>;
  /**
   * ハッシュでリフレッシュトークンを1件引く（ローテーション照合用）。
   * @param tokenHash 提示トークンの SHA-256
   * @returns 該当行、無ければ `null`
   */
  findRefreshTokenByHash(tokenHash: Buffer): Promise<RefreshTokenRow | null>;
  /**
   * 指定 ID のトークンを**条件付き**で失効する（`revoked_at IS NULL` のときのみ）。
   * @param id RefreshToken.id
   * @returns 失効できたら `true`（＝ローテーションの勝者）、既に失効済み等で0件なら `false`
   */
  revokeRefreshTokenById(id: string): Promise<boolean>;
  /**
   * 系統（family）の未失効トークンを一括失効する（リフレッシュ再利用検知時）。
   * @param familyId 系統 ID
   */
  revokeFamily(familyId: string): Promise<void>;
  /**
   * 本人の未失効リフレッシュトークンを失効する（logout）。
   * @param userId 所有者
   * @param tokenHash 失効対象トークンの SHA-256
   */
  revokeRefreshTokenByHashForUser(userId: string, tokenHash: Buffer): Promise<void>;
}

/**
 * SQL Server のユニーク制約違反かどうかを判定する。
 * 2627 = 制約違反（PRIMARY KEY / UNIQUE 制約）、2601 = 一意インデックス違反。
 *
 * @param err catch した例外
 * @returns ユニーク違反なら `true`
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'number' in err &&
    (err.number === 2627 || err.number === 2601)
  );
}

/** mssql による {@link AuthRepository} 実装。SQL はすべてパラメータ化する。 */
export class SqlAuthRepository implements AuthRepository {
  /** @inheritDoc */
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('email', mssql.NVarChar(255), email) // パラメータ化（SQLi 防止）
      .query<UserRow>(
        `SELECT id, email, password_hash, status, failed_attempts, lock_until
         FROM [User] WHERE email = @email`,
      );
    // recordset[0] は noUncheckedIndexedAccess で undefined になり得るため ?? null で正規化
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async createUserWithConsent(input: CreateUserInput): Promise<string> {
    const pool = await getPool();
    // User と Consent はどちらか片方だけ作られると不整合になるため、1トランザクションで束ねる
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      // OUTPUT INSERTED.id で DB 採番（NEWSEQUENTIALID）された id をその場で受け取る
      const userResult = await new mssql.Request(tx)
        .input('email', mssql.NVarChar(255), input.email)
        .input('password_hash', mssql.NVarChar(255), input.passwordHash)
        .input('name', mssql.NVarChar(100), input.name)
        .query<{ id: string }>(
          `INSERT INTO [User] (email, password_hash, name)
           OUTPUT INSERTED.id
           VALUES (@email, @password_hash, @name)`,
        );
      const userId = userResult.recordset[0]?.id;
      if (userId === undefined) {
        throw new Error('User の INSERT で id を取得できませんでした');
      }
      // 同じトランザクションで規約同意を記録
      await new mssql.Request(tx)
        .input('user_id', mssql.UniqueIdentifier, userId)
        .input('terms_version', mssql.NVarChar(50), input.termsVersion)
        .query(`INSERT INTO Consent (user_id, terms_version) VALUES (@user_id, @terms_version)`);
      await tx.commit();
      return userId;
    } catch (err) {
      // 失敗時はロールバックして部分作成を残さない。
      // rollback 自体が失敗しても元の err を握り潰さないよう、ログのみに留める。
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        console.error('トランザクションの rollback に失敗:', rollbackErr);
      }
      // メール一意性は事前 SELECT ではなく DB の UNIQUE 制約に委ねる（TOCTOU 回避）。
      // 違反を 409 用のドメインエラーへ変換する
      if (isUniqueViolation(err)) throw new DuplicateEmailError();
      throw err;
    }
  }

  /** @inheritDoc */
  async recordLoginFailure(userId: string, maxFailedAttempts: number, lockMinutes: number): Promise<void> {
    const pool = await getPool();
    // 失敗数+1 と「閾値到達ならロック時刻設定」を1文で原子的に行う（読み取り→書き込みの競合を避ける）。
    // 無効アカウント（status<>'active'）はカウントしない（CLAUDE.md: 現在状態を WHERE に含める）。
    await pool
      .request()
      .input('id', mssql.UniqueIdentifier, userId)
      .input('max', mssql.Int, maxFailedAttempts)
      .input('lockMin', mssql.Int, lockMinutes)
      .query(
        `UPDATE [User]
         SET failed_attempts = failed_attempts + 1,
             lock_until = CASE WHEN failed_attempts + 1 >= @max
                               THEN DATEADD(MINUTE, @lockMin, SYSUTCDATETIME())
                               ELSE lock_until END
         WHERE id = @id AND status = 'active'`,
      );
  }

  /** @inheritDoc */
  async resetLoginFailures(userId: string): Promise<void> {
    const pool = await getPool();
    // 既にクリーン（失敗0かつ未ロック）なら書き込まない。成功ログインのたびの無駄な
    // UPDATE を避け、serverless の書き込み往復を減らす。
    await pool
      .request()
      .input('id', mssql.UniqueIdentifier, userId)
      .query(
        `UPDATE [User] SET failed_attempts = 0, lock_until = NULL
         WHERE id = @id AND (failed_attempts > 0 OR lock_until IS NOT NULL)`,
      );
  }

  /** @inheritDoc */
  async insertRefreshToken(input: InsertRefreshTokenInput): Promise<void> {
    const pool = await getPool();
    await pool
      .request()
      .input('user_id', mssql.UniqueIdentifier, input.userId)
      .input('family_id', mssql.UniqueIdentifier, input.familyId)
      .input('token_hash', mssql.VarBinary(32), input.tokenHash)
      .input('expires_at', mssql.DateTime2(3), input.expiresAt)
      .query(
        `INSERT INTO RefreshToken (user_id, family_id, token_hash, expires_at)
         VALUES (@user_id, @family_id, @token_hash, @expires_at)`,
      );
  }

  /** @inheritDoc */
  async findRefreshTokenByHash(tokenHash: Buffer): Promise<RefreshTokenRow | null> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('token_hash', mssql.VarBinary(32), tokenHash)
      .query<RefreshTokenRow>(
        `SELECT id, user_id, family_id, revoked_at, expires_at
         FROM RefreshToken WHERE token_hash = @token_hash`,
      );
    return result.recordset[0] ?? null;
  }

  /** @inheritDoc */
  async revokeRefreshTokenById(id: string): Promise<boolean> {
    const pool = await getPool();
    // 「現在状態(revoked_at IS NULL)を WHERE に含めた条件付き UPDATE」。
    // 同時/再送で複数回ローテーションを試みても、失効できるのは1回だけ＝勝者を一意にする。
    const result = await pool
      .request()
      .input('id', mssql.UniqueIdentifier, id)
      .query(
        `UPDATE RefreshToken SET revoked_at = SYSUTCDATETIME()
         WHERE id = @id AND revoked_at IS NULL`,
      );
    // rowsAffected[0] が 1 なら自分が失効できた（＝勝者）
    return (result.rowsAffected[0] ?? 0) === 1;
  }

  /** @inheritDoc */
  async revokeFamily(familyId: string): Promise<void> {
    const pool = await getPool();
    await pool
      .request()
      .input('family_id', mssql.UniqueIdentifier, familyId)
      .query(
        `UPDATE RefreshToken SET revoked_at = SYSUTCDATETIME()
         WHERE family_id = @family_id AND revoked_at IS NULL`,
      );
  }

  /** @inheritDoc */
  async revokeRefreshTokenByHashForUser(userId: string, tokenHash: Buffer): Promise<void> {
    const pool = await getPool();
    await pool
      .request()
      .input('user_id', mssql.UniqueIdentifier, userId)
      .input('token_hash', mssql.VarBinary(32), tokenHash)
      .query(
        `UPDATE RefreshToken SET revoked_at = SYSUTCDATETIME()
         WHERE token_hash = @token_hash AND user_id = @user_id AND revoked_at IS NULL`,
      );
  }
}
