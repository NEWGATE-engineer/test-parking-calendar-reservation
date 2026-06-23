import { Router } from 'express';
import { AuthService } from './service.js';
import { SqlAuthRepository, type AuthRepository } from './repository.js';
import { parseRegister, parseLogin } from './validation.js';
import { asyncHandler } from '../http/asyncHandler.js';

/**
 * `/auth` ルーター。会員登録・ログインの HTTP 入口（refresh / logout は 2c で追加）。
 *
 * 各ハンドラは「入力検証 → サービス呼び出し → 応答」だけを行い、
 * 失敗はすべて `next(err)` で統一エラーハンドラ（errorHandler）に委譲する。
 *
 * @module auth/router
 */

/**
 * `/auth` ルーターを生成する。
 *
 * リポジトリを引数で差し替え可能にし、テストではモックを注入できる
 * （既定は実 DB を使う {@link SqlAuthRepository}）。
 *
 * @param repo 認証データアクセス層（既定: SqlAuthRepository）
 * @returns `/register`・`/login` を備えた Express Router
 */
export function createAuthRouter(repo: AuthRepository = new SqlAuthRepository()): Router {
  const service = new AuthService(repo);
  const router = Router();

  /**
   * POST /auth/register — 会員登録。成功時 201 で TokenResponse。
   * 検証失敗は 422、メール重複は 409（いずれも errorHandler が整形）。
   */
  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const tokens = await service.register(parseRegister(req.body));
      res.status(201).json(tokens);
    }),
  );

  /**
   * POST /auth/login — ログイン。成功時 200 で TokenResponse。
   * 検証失敗は 422、資格情報不一致は 401、ロック中は 429、無効アカウントは 403。
   */
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const tokens = await service.login(parseLogin(req.body));
      res.status(200).json(tokens);
    }),
  );

  return router;
}
