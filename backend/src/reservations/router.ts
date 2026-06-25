import { Router } from 'express';
import { ReservationsService } from './service.js';
import { SqlReservationsRepository, type ReservationsRepository } from './repository.js';
import {
  parseCreateReservationBody,
  parseUpdateReservationBody,
  parseListQuery,
  parseReservationId,
} from './validation.js';
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

  /** GET /reservations — 自分の予約一覧（200）。要認証。status 絞り込み可（不正値は 422）。 */
  router.get(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { status } = parseListQuery(req.query);
      const userId = getUserId(req);
      res.status(200).json(await service.list(userId, status));
    }),
  );

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

  /** PUT /reservations/:id — 予約変更（200）。要認証。reserved のみ。404 / 409 / 422。 */
  router.put(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseReservationId(req.params.id);
      const patch = parseUpdateReservationBody(req.body);
      const userId = getUserId(req);
      const updated = await service.update(userId, id, patch);
      res.status(200).json(updated);
    }),
  );

  /** DELETE /reservations/:id — 予約キャンセル（204）。要認証。reserved のみ。404 / 409。 */
  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseReservationId(req.params.id);
      const userId = getUserId(req);
      await service.cancel(userId, id);
      res.status(204).end();
    }),
  );

  return router;
}
