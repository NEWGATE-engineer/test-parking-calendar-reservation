import {
  type CommandLogRepository,
  type DeviceCommandPort,
  GateDownService,
  notConfiguredDeviceCommandPort,
  parseGateDownBody,
  parseReservationId,
  SqlCommandLogRepository,
} from '@parking/core';
import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler.js';
import { getUserId, requireAuth } from '../http/requireAuth.js';

/**
 * `/reservations/:id/gate-down` ルーター（DOWN 指示・入庫）。
 *
 * CRUD とは依存（CommandLog・DeviceCommandPort）が異なるため、予約 CRUD ルーターとは
 * 分けて構成する（同じ `/reservations` マウントに併設）。
 *
 * @module reservations/gateDown.router
 */

/**
 * gate-down ルーターを生成する。
 *
 * @param repo CommandLog データアクセス層（既定: SqlCommandLogRepository。テストはモック）
 * @param devicePort デバイスコマンド送信ポート（既定: 未設定スタブ。本番は IoT 実装、テストはモック）
 * @returns `POST /:id/gate-down` を備えた Router
 */
export function createGateDownRouter(
  repo: CommandLogRepository = new SqlCommandLogRepository(),
  devicePort: DeviceCommandPort = notConfiguredDeviceCommandPort,
): Router {
  const service = new GateDownService(repo, devicePort);
  const router = Router();

  /** POST /reservations/:id/gate-down — DOWN 指示（200）。要認証。404/409/422/503/504。 */
  router.post(
    '/:id/gate-down',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = parseReservationId(req.params.id);
      const { requestId } = parseGateDownBody(req.body);
      const userId = getUserId(req);
      const result = await service.execute(userId, id, requestId);
      res.status(200).json(result);
    }),
  );

  return router;
}
