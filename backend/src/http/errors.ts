/** OpenAPI の Error スキーマに対応するレスポンス本体。 */
export interface ErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  retry_after?: number | null;
}

/**
 * 業務エラー。HTTP ステータス・機械可読 code・retryable を持つ。
 * 投げると errorHandler が Error スキーマで応答する。
 */
export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(httpStatus: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = retryable;
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export const unauthorized = (message = '認証が必要です'): AppError =>
  new AppError(401, 'unauthorized', message);

export const validationError = (message = '入力が不正です'): AppError =>
  new AppError(422, 'validation_error', message);
