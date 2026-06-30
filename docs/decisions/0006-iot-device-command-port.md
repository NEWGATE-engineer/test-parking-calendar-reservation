# ADR 0006: 実 DeviceCommandPort（IoT Hub ダイレクトメソッド）の実装

- ステータス: 承認
- 日付: 2026-06-30
- 関連: [ADR 0003](0003-gate-down-idempotency.md)（gate-down 冪等性）/ [ADR 0004](0004-monorepo-core-extraction.md)（core 切り出し）/ `device-sim/README.md`（メッセージ契約）/ [CLAUDE.md](../../CLAUDE.md)

## 背景

gate-down（[ADR 0003](0003-gate-down-idempotency.md)）はデバイス送信を `DeviceCommandPort` interface の背後に抽象化し、実 IoT 実装は「IoT 連携スライスで注入する」として既定は未設定スタブ（`notConfiguredDeviceCommandPort`）だった。IoT 連携スライス (a) device-sim・(b) functions テレメトリ受信が完了し、本 ADR の (c) で **backend の実 `DeviceCommandPort`** を実装する。

device-sim/README.md のメッセージ契約 §2 が source of truth: DOWN は IoT Hub の **ダイレクトメソッド `down`**（本文 `{ requestId }`・成功 status `200`）。

## 決定

### 1. 実装は backend に置く（core は Azure 非依存を維持）

`DeviceCommandPort` interface は core に残し、実装（`azure-iothub` 依存）は `backend/src/reservations/iotDeviceCommandPort.ts` に置く。core は Azure/Express/IoT 非依存というレイヤ境界（[ADR 0004](0004-monorepo-core-extraction.md)）を保つ。backend は App Service にデプロイされるため Azure サービス SDK に依存してよい。

### 2. サービス SDK は `azure-iothub`、メソッド invoke は REST

サービス側のダイレクトメソッド呼び出しは `azure-iothub` の `Client.invokeDeviceMethod(deviceId, { methodName: 'down', payload: { requestId }, responseTimeoutInSeconds, connectTimeoutInSeconds })` を使う（device-sim のデバイス側 `azure-iot-device` と対になる）。`invokeDeviceMethod` は内部的にサービス REST API を使うため AMQP の `open()` は不要。

### 3. 結果の写像（DeviceCommandResult は `ok:true` / `timeout` のみ）

| デバイス／SDK の結果 | DeviceCommandResult | HTTP（gate-down サービス） |
| --- | --- | --- |
| 完了応答 status `200` | `{ ok: true }` | 200 |
| 無応答（`GatewayTimeoutError` 等 Timeout 系） | `{ ok: false, reason: 'timeout' }` | 504 `timeout`（retryable） |
| デバイス未接続（`DeviceNotFoundError` / `DeviceNotConnectedError`） | `{ ok: false, reason: 'timeout' }` | 504 `timeout`（retryable） |
| 上記以外（想定外 status・認証/設定不備など） | 例外を伝播 | 500 |

**未接続を timeout に寄せる**: `DeviceCommandResult` は `ok:true` か `timeout` の2値しか表現しない（[ADR 0003](0003-gate-down-idempotency.md) §3 で失敗理由を保持しないと決めたのと整合）。利用者視点では「無応答」も「未接続」も**再試行で回復し得る一過性失敗**なので、まとめて 504 retryable に写像する。デバイス事前 NG（不健全）は IoT を呼ぶ前にサービス側が `last_seen_at` で判定し 503 にするため、ここには現れない。

**想定外 status は contract 違反**: backend は常に UUID の requestId を採番するため device-sim の 400 `invalid_requestId` は正常系で起きない。200 以外は契約違反として例外（→ 500）にし、握り潰さない。

### 4. SDK 呼び出しを `DirectMethodInvoker` で隔離しテスト可能に

写像ロジック（成功 / timeout / 想定外）を Azure なしで単体テストするため、SDK 呼び出しを `interface DirectMethodInvoker` 越しに隠す。本番ファクトリ `createIotDeviceCommandPort()` が `azure-iothub` Client を注入し、テストは偽 invoker を注入して全分岐を検証する（既存の「repo/runTx をコンストラクタ注入してテストはモック」と同じ DI 方針）。

### 5. 配線は接続文字列の有無で分岐（ローカル/テストは IoT なしで起動可）

`backend/src/app.ts` は `config.iot.isConfigured`（接続文字列の有無を throw せず判定）が真なら実ポートを注入し、偽なら `notConfiguredDeviceCommandPort` を使う。これによりローカル開発・テストは IoT 設定なしで起動でき、gate-down を呼んだ時だけ明示的に失敗する。接続文字列の取得は `config.iot.hubConnectionString` で**遅延評価**（functions はテレメトリを Event Hub トリガで受け `IOT_HUB_EVENTS` を使うため、サービス接続文字列は不要。jwt.secret と同じ理由で eager 必須化しない）。環境変数名 `IOT_HUB_CONNECTION_STRING` は config に集約し、app.ts から直接参照しない（リネーム時の漏れを防ぐ）。

## 影響

- 追加: `backend/src/reservations/iotDeviceCommandPort.ts`、`backend/test/iotDeviceCommandPort.test.ts`（6 ケース）。
- 変更: `backend/src/app.ts`（`config.iot.isConfigured` で実ポート/スタブを分岐）、`core/src/config.ts`（`config.iot` に `hubConnectionString` 遅延 getter・`isConfigured`・`methodTimeoutSeconds`）、`device-sim/README.md`（(c) を実装済みに）、`docs/README.md`（ADR 一覧）、`docs/setup/…環境構築手順書.md` §8-2（backend/.env テンプレートに IoT 変数追記）。
- 依存追加: `backend` に `azure-iothub`（サービス SDK・型同梱）。`npm audit --audit-level=high` は pass（high/critical なし）。
- App Settings / `.env`（backend 実環境）: `IOT_HUB_CONNECTION_STRING`（サービスポリシー接続文字列）、任意で `IOT_METHOD_TIMEOUT_SEC`（既定 30）。
- DDL 変更なし。OpenAPI 変更なし（gate-down の振る舞い・契約は不変）。

## 代替案

- **実装を core に置く**: core が Azure SDK に依存し [ADR 0004](0004-monorepo-core-extraction.md) のレイヤ境界を壊すため不採用。
- **`DeviceCommandResult` に failure 理由を増やす**（not_connected / unauthorized 等）: gate-down サービスと [ADR 0003](0003-gate-down-idempotency.md) §3 の写像まで波及する。MVP では timeout 集約で足り、過剰として不採用（将来、失敗理由の可観測性が要るなら再検討）。
- **`azure-iot-hub`/REST 直叩き**: 公式サービス SDK `azure-iothub` が型・リトライを内包するため自前実装は不採用。
