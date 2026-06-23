import { Router } from 'express';
import { AuthService } from './service.js';
import { SqlAuthRepository, type AuthRepository } from './repository.js';
import { parseRegister, parseLogin } from './validation.js';

/**
 * /auth ルーター。register/login を提供（refresh/logout は 2c）。
 * repo を差し替え可能にしてテスト容易性を確保（既定は SQL 実装）。
 */
export function createAuthRouter(repo: AuthRepository = new SqlAuthRepository()): Router {
  const service = new AuthService(repo);
  const router = Router();

  router.post('/register', (req, res, next) => {
    void (async () => {
      const tokens = await service.register(parseRegister(req.body));
      res.status(201).json(tokens);
    })().catch(next);
  });

  router.post('/login', (req, res, next) => {
    void (async () => {
      const tokens = await service.login(parseLogin(req.body));
      res.status(200).json(tokens);
    })().catch(next);
  });

  return router;
}
