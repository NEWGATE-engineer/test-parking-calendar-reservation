/**
 * 業務エラーと、OpenAPI `Error` スキーマに対応するレスポンス型。
 *
 * ハンドラ／サービスは {@link AppError} を投げ、統一エラーハンドラ（errorHandler）が
 * これを HTTP 応答に変換する。
 *
 * @module http/errors
 */

/** OpenAPI の `Error` スキーマに対応するレスポンス本体。 */
export interface ErrorBody {
  /** 機械可読の理由コード（例: `invalid_credentials` / `email_conflict`）。 */
  code: string;
  /** 利用者向けメッセージ。 */
  message: string;
  /** 再試行で解消し得るか（504=true、409 競合=false など）。 */
  retryable?: boolean;
  /** 再試行までの推奨待機秒数（任意）。 */
  retry_after?: number | null;
}

/**
 * 業務エラー。HTTP ステータス・機械可読 code・retryable を持つ。
 *
 * これを投げると errorHandler が {@link ErrorBody} 形式で応答する。
 */
export class AppError extends Error {
  /** 応答する HTTP ステータスコード。 */
  readonly httpStatus: number;
  /** 機械可読の理由コード。 */
  readonly code: string;
  /** 再試行可能か。 */
  readonly retryable: boolean;

  /**
   * @param httpStatus 応答ステータス（例: 401, 409, 422, 429）
   * @param code 機械可読コード（例: `invalid_credentials`）
   * @param message 利用者向けメッセージ
   * @param retryable 再試行で解消し得るか（既定 false）
   */
  constructor(httpStatus: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = retryable;
  }

  /**
   * レスポンス本体（Error スキーマ）へ変換する。
   * @returns code / message / retryable を含むオブジェクト
   */
  toBody(): ErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/**
 * 401 認証エラーを生成するショートカット。
 * @param message 任意のメッセージ
 */
export const unauthorized = (message = '認証が必要です'): AppError =>
  new AppError(401, 'unauthorized', message);

/**
 * 422 入力検証エラーを生成するショートカット。
 * @param message 任意のメッセージ
 */
export const validationError = (message = '入力が不正です'): AppError =>
  new AppError(422, 'validation_error', message);
