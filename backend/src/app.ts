import { notConfiguredDeviceCommandPort } from '@parking/core';
import express, { type Express } from 'express';
import { createAuthRouter } from './auth/router.js';
import { errorHandler } from './http/errorHandler.js';
import { createGateDownRouter } from './reservations/gateDown.router.js';
import { createIotDeviceCommandPort } from './reservations/iotDeviceCommandPort.js';
import { createReservationsRouter } from './reservations/router.js';
import { createSpotsRouter } from './spots/router.js';

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

  // 認証ルート（register / login / refresh / logout）
  app.use('/auth', createAuthRouter());

  // 区画・満空・予約可否（要認証・読み取り専用）
  app.use('/spots', createSpotsRouter());

  // 予約（要認証・作成・変更・キャンセル・一覧）
  app.use('/reservations', createReservationsRouter());

  // 予約の DOWN 指示（入庫）。CRUD と依存が異なるため同じマウントに別ルーターで併設。
  // IoT Hub 接続文字列があれば実 DeviceCommandPort（azure-iothub）を注入。無ければ未設定スタブ
  // （ローカル開発・テストは IoT なしで起動でき、gate-down 呼び出し時のみ明示的に失敗する）。
  const devicePort = process.env.IOT_HUB_CONNECTION_STRING
    ? createIotDeviceCommandPort()
    : notConfiguredDeviceCommandPort;
  app.use('/reservations', createGateDownRouter(undefined, devicePort));

  // エラーハンドラは必ず最後（前段ハンドラの例外を集約して整形する）
  app.use(errorHandler);
  return app;
}
