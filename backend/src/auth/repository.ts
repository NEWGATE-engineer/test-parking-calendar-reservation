import mssql from 'mssql';
import { getPool } from '../db.js';

/** 認証で参照する User 行。 */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  failed_attempts: number;
  lock_until: Date | null;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string | null;
  termsVersion: string;
}

export interface InsertRefreshTokenInput {
  userId: string;
  familyId: string;
  tokenHash: Buffer;
  expiresAt: Date;
}

/** メール重複（UQ_User_email 違反）を表すエラー。サービス層で 409 に変換する。 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email already exists');
    this.name = 'DuplicateEmailError';
  }
}

/** 認証データアクセスの抽象。テストではモックに差し替える。 */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRow | null>;
  /** User と Consent を1トランザクションで作成。メール重複は DuplicateEmailError。返り値は user id。 */
  createUserWithConsent(input: CreateUserInput): Promise<string>;
  /** ログイン失敗を記録（失敗数+1、閾値到達でロック時刻を設定）。 */
  recordLoginFailure(userId: string, maxFailedAttempts: number, lockMinutes: number): Promise<void>;
  /** ログイン成功時に失敗数・ロックをリセット。 */
  resetLoginFailures(userId: string): Promise<void>;
  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void>;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'number' in err &&
    (err.number === 2627 || err.number === 2601)
  );
}

/** mssql による AuthRepository 実装。SQL はすべてパラメータ化（SQLi 防止）。 */
export class SqlAuthRepository implements AuthRepository {
  async findUserByEmail(email: string): Promise<UserRow | null> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('email', mssql.NVarChar(255), email)
      .query<UserRow>(
        `SELECT id, email, password_hash, status, failed_attempts, lock_until
         FROM [User] WHERE email = @email`,
      );
    return result.recordset[0] ?? null;
  }

  async createUserWithConsent(input: CreateUserInput): Promise<string> {
    const pool = await getPool();
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
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
      await new mssql.Request(tx)
        .input('user_id', mssql.UniqueIdentifier, userId)
        .input('terms_version', mssql.NVarChar(50), input.termsVersion)
        .query(
          `INSERT INTO Consent (user_id, terms_version) VALUES (@user_id, @terms_version)`,
        );
      await tx.commit();
      return userId;
    } catch (err) {
      await tx.rollback();
      if (isUniqueViolation(err)) throw new DuplicateEmailError();
      throw err;
    }
  }

  async recordLoginFailure(userId: string, maxFailedAttempts: number, lockMinutes: number): Promise<void> {
    const pool = await getPool();
    // 失敗数+1。閾値に達したらロック時刻を設定（条件付き・原子的に1文で）。
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
         WHERE id = @id`,
      );
  }

  async resetLoginFailures(userId: string): Promise<void> {
    const pool = await getPool();
    await pool
      .request()
      .input('id', mssql.UniqueIdentifier, userId)
      .query(`UPDATE [User] SET failed_attempts = 0, lock_until = NULL WHERE id = @id`);
  }

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
}
