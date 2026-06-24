import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthService } from './service.js';
import { SqlAuthRepository, type AuthRepository } from './repository.js';
import { parseRegister, parseLogin, parseRefreshToken } from './validation.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { requireAuth, getUserId } from '../http/requireAuth.js';

/**
 * `/auth` ルーター。会員登録・ログイン・トークン更新・ログアウトの HTTP 入口。
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
 * @returns `/register`・`/login`・`/refresh`・`/logout` を備えた Express Router
 */
export function createAuthRouter(repo: AuthRepository = new SqlAuthRepository()): Router {
  const service = new AuthService(repo);
  const router = Router();

  // 認証エンドポイントの IP レート制限（DoS・総当たり対策）。
  // login のアカウントロック(F1-5)とは別レイヤ。refresh は認証不要の公開口かつ
  // 失効済みトークン再送で revokeFamily の書き込みが走るため、ここで上限をかける。
  //
  // ⚠️ 既知の限界（本番デプロイ前に対処）: 既定の MemoryStore はインスタンス単位で
  // カウントするため、App Service をスケールアウトすると「インスタンス数 × limit」が
  // 実効上限になりバイパスされ得る。本番では (a) rate-limit-redis + Azure Cache for Redis の
  // 分散ストア、または (b) Azure Front Door / API Management のエッジ制限を主とし本 MemoryStore は
  // 補助、のいずれかにする。MVP（単一インスタンス）では MemoryStore で許容。
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15分（仮値・運用で調整）
      limit: 30, // IP あたり 30 リクエスト/窓（仮値・運用で調整）
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

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

  /**
   * POST /auth/refresh — リフレッシュトークンのローテーション。成功時 200 で新 TokenResponse。
   * 不明・期限切れ・再使用は 401（認証不要のエンドポイント）。
   */
  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const { refreshToken } = parseRefreshToken(req.body);
      const tokens = await service.refresh(refreshToken);
      res.status(200).json(tokens);
    }),
  );

  /**
   * POST /auth/logout — リフレッシュトークンを失効。成功時 204。
   * Bearer アクセストークンで本人認証する（requireAuth）。本文に refresh_token が必要。
   */
  router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { refreshToken } = parseRefreshToken(req.body);
      // requireAuth 通過後の userId 取り出し（未設定は配線ミス＝内部エラー扱い）
      await service.logout(getUserId(req), refreshToken);
      res.status(204).end();
    }),
  );

  return router;
}
