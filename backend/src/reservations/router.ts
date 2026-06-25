import { Router } from 'express';
import { ReservationsService } from './service.js';
import { SqlReservationsRepository, type ReservationsRepository } from './repository.js';
import { parseCreateReservationBody } from './validation.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { requireAuth, getUserId } from '../http/requireAuth.js';
import { withSerializableTx, type TxRunner } from '../db.js';

/**
 * `/reservations` ルーター。予約の作成（認証必須）。
 *
 * @module reservations/router
 */

/**
 * `/reservations` ルーターを生成する。
 *
 * @param repo 予約データアクセス層（既定: SqlReservationsRepository。テストはモック）
 * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナー）
 * @returns `POST /`（作成）を備えた Router
 */
export function createReservationsRouter(
  repo: ReservationsRepository = new SqlReservationsRepository(),
  runTx: TxRunner = withSerializableTx,
): Router {
  const service = new ReservationsService(repo, runTx);
  const router = Router();

  /** POST /reservations — 予約作成（201）。要認証。不正入力 422 / 不在 404 / 競合 409。 */
  router.post(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      // 過去日時判定の基準を now で固定してから検証する
      const input = parseCreateReservationBody(req.body, new Date());
      const userId = getUserId(req);
      const created = await service.create(userId, input);
      res.status(201).json(created);
    }),
  );

  return router;
}
