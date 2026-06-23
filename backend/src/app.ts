import express, { type Express } from 'express';
import { errorHandler } from './http/errorHandler.js';
import { createAuthRouter } from './auth/router.js';

/**
 * Express アプリを組み立てる（テストからも利用するため listen はしない）。
 * 認証・予約などの業務ルートは後続 PR でここにマウントする。
 */
export function buildApp(): Express {
  const app = express();
  app.use(express.json());

  // ヘルスチェック（DB 非依存。コールドスタート/疎通確認用）
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 認証ルート（register / login。refresh / logout は 2c）
  app.use('/auth', createAuthRouter());

  // エラーハンドラは必ず最後
  app.use(errorHandler);
  return app;
}
