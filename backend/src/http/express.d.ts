// Express Request に認証済みユーザー ID を持たせるための型拡張。
import 'express';

declare global {
  namespace Express {
    interface Request {
      /** 認証ミドルウェア（requireAuth）が設定する。トークンの sub=user_id。 */
      userId?: string;
    }
  }
}
