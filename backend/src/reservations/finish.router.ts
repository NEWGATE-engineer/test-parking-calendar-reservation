import {
  type FinishRepository,
  FinishService,
  parseReservationId,
  SqlFinishRepository,
  type TxRunner,
  withSerializableTx,
} from '@parking/core';
import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler.js';
import { getUserId, requireAuth } from '../http/requireAuth.js';

/**
 * `/reservations/:id/finish` ルーター（利用終了の申告）。
 *
 * CRUD とは独立したユースケース（end_time 前倒し＋条件付き完了確定）のため専用ルーターにし、
 * 同じ `/reservations` マウントに併設する。
 *
 * @module reservations/finish.router
 */

/**
 * finish ルーターを生成する。
 *
 * @param repo 利用終了データアクセス層（既定: SqlFinishRepository。テストはモック）
 * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナー）
 * @returns `POST /:id/finish` を備えた Router
 */
export function createFinishRouter(
  repo: FinishRepository = new SqlFinishRepository(),
  runTx: TxRunner = withSerializableTx,
): Router {
  const service = new FinishService(repo, runTx);
  const router = Router();

  /** POST /reservations/:id/finish — 利用終了申告（200）。要認証。404 / 409。 */
  router.post(
    '/:id/finish',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseReservationId(req.params.id);
      const userId = getUserId(req);
      const result = await service.finish(userId, id);
      res.status(200).json(result);
    }),
  );

  return router;
}
