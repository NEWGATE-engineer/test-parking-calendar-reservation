import express, { type Express } from 'express';
import { errorHandler } from './http/errorHandler.js';
import { createAuthRouter } from './auth/router.js';

/**
 * Express アプリの組み立て。
 *
 * `listen` は呼ばず app インスタンスだけを返すので、テスト（supertest）からも同じ構成で叩ける。
 * 実際の起動（listen・DB ウォームアップ）は index.ts が行う。
 *
 * @module app
 */

/**
 * Express アプリを組み立てて返す。
 *
 * ルートの登録順は「JSON パーサ → 業務ルート → エラーハンドラ（最後）」。
 * エラーハンドラは必ず末尾に置く（Express 5 が前段の例外を受け取れるように）。
 *
 * @returns 設定済みの Express アプリ（listen は呼んでいない）
 */
export function buildApp(): Express {
  const app = express();
  app.use(express.json()); // JSON ボディをパース

  // ヘルスチェック（DB 非依存。コールドスタート/疎通確認用）
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 認証ルート（register / login。refresh / logout は 2c で追加）
  app.use('/auth', createAuthRouter());

  // エラーハンドラは必ず最後（前段ハンドラの例外を集約して整形する）
  app.use(errorHandler);
  return app;
}
