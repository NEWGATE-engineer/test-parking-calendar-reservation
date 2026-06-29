import {
  parseAvailabilityQuery,
  type SpotsRepository,
  SpotsService,
  SqlSpotsRepository,
} from '@parking/core';
import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler.js';
import { requireAuth } from '../http/requireAuth.js';

/**
 * `/spots` ルーター。区画一覧と予約可否（いずれも認証必須・読み取り専用）。
 *
 * @module spots/router
 */

/**
 * `/spots` ルーターを生成する。
 *
 * @param repo 区画データアクセス層（既定: SqlSpotsRepository。テストはモック）
 * @returns `/`（一覧）・`/availability` を備えた Router
 */
export function createSpotsRouter(repo: SpotsRepository = new SqlSpotsRepository()): Router {
  const service = new SpotsService(repo);
  const router = Router();

  /** GET /spots — 区画一覧＋満空（200）。要認証。 */
  router.get(
    '/',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.status(200).json(await service.listSpots());
    }),
  );

  /** GET /spots/availability?start&end — 予約可否（200）。要認証。不正クエリは 422。 */
  router.get(
    '/availability',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { start, end } = parseAvailabilityQuery(req.query);
      res.status(200).json(await service.getAvailability(start, end));
    }),
  );

  return router;
}
