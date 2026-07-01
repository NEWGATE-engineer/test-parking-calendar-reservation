import {
  type FeeRepository,
  FeeService,
  parseReservationId,
  SqlFeeRepository,
} from '@parking/core';
import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler.js';
import { getUserId, requireAuth } from '../http/requireAuth.js';

/**
 * `/reservations/:id/fee` ルーター（料金取得）。
 *
 * @module reservations/fee.router
 */

/**
 * fee ルーターを生成する。
 *
 * @param repo 料金データアクセス層（既定: SqlFeeRepository。テストはモック）
 * @returns `GET /:id/fee` を備えた Router
 */
export function createFeeRouter(repo: FeeRepository = new SqlFeeRepository()): Router {
  const service = new FeeService(repo);
  const router = Router();

  /** GET /reservations/:id/fee — 料金取得（200・未確定は pending）。要認証。404。 */
  router.get(
    '/:id/fee',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseReservationId(req.params.id);
      const userId = getUserId(req);
      const result = await service.get(userId, id);
      res.status(200).json(result);
    }),
  );

  return router;
}
