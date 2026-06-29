# device-sim（AUTOSTAND 疑似デバイス）

ロック板（AUTOSTAND）を模した疑似デバイス。IoT 連携スライスの (a) として、クラウドとの
**メッセージ契約**を実機なしで検証できるようにする最小骨組み。

- **DOWN ダイレクトメソッド**を受けて板を down にし応答する（冪等・[ADR 0003](../docs/decisions/0003-gate-down-idempotency.md)）。
- **テレメトリ（entry / exit / up）を手動送出**する（functions が消費・[バックエンド処理一覧 §B](../docs/architecture/バックエンド処理一覧（トリガ別）.md)）。

状態機械は簡易。§5.3 の安全インターロック（自動 UP 条件）は実装せず、UP は手動コマンドで送る。

## 実行

```bash
# オフライン（dry-run）: Azure 不要。テレメトリは標準出力に出る。DOWN は手動コマンドで模擬。
npm start

# オンライン: 実 IoT Hub に接続（device-sim/.env に接続文字列が必要・コミット禁止）
npm run start:env
```

`.env`（gitignore 済み）:

```
IOT_DEVICE_CONNECTION_STRING=HostName=...;DeviceId=...;SharedAccessKey=...
```

接続文字列が無ければ自動でオフライン dry-run になる。`DEVICE_ID` 環境変数で deviceId を上書き可（既定 `sim-device-01`）。

## REPL コマンド

| コマンド | 動作 | クラウド側の対応 |
| --- | --- | --- |
| `entry` | 在車検知テレメトリ送出 | functions: `onEntryDetected` |
| `exit` | 空車検知テレメトリ送出 | functions: `onExitDetected` |
| `up` | UP 実行テレメトリ送出（板=up） | functions: `onPlateUp` |
| `down [requestId]` | DOWN を手動実行（オフライン検証用） | backend: `gateDown` / `DeviceCommandPort.sendDown` |
| `mode ok\|timeout` | DOWN の挙動切替（timeout=無応答で 504 経路を模擬） | backend の 504 `timeout` 検証 |
| `status` | 現在状態を表示 | — |
| `help` / `quit` | ヘルプ / 終了 | — |

## メッセージ契約（functions / backend と共有）

> ここが本スライスで定める取り決め。functions（(b)）・backend の実 DeviceCommandPort（(c)）は
> これに一致させる。破壊的変更時は `schemaVersion` を上げる。

### 1. テレメトリ（device → IoT Hub → functions）

device→cloud（D2C）メッセージ。本文は JSON（`contentType: application/json`）。
アプリプロパティ `telemetryType` にも種別を載せる（ルーティング用）。

```jsonc
{
  "schemaVersion": 1,
  "type": "entry" | "exit" | "up", // 在車検知 / 空車検知 / UP 実行
  "deviceId": "sim-device-01",
  "eventId": "<uuid>",             // at-least-once 配信の冪等キー（functions 側で重複吸収）
  "occurredAt": "2026-06-29T12:34:56.789Z" // UTC（CLAUDE.md: 時刻は UTC 保存）
}
```

- **冪等化**: IoT Hub トリガは at-least-once。functions は `eventId`（または onEntry の open UsageRecord 有無）で二度処理を防ぐ。
- **deviceId** は本文にも入れるが、実際の IoT Hub では system property `iothub-connection-device-id` も使える。

### 2. DOWN ダイレクトメソッド（backend → IoT Hub → device）

- メソッド名: **`down`**
- リクエスト本文:

  ```json
  { "requestId": "<uuid>" }
  ```

- 成功応答: status `200`

  ```json
  { "ok": true, "requestId": "<uuid>", "plate": "down", "replayed": false }
  ```

- **冪等性**: 同一 `requestId` の再送は板を再発火せず成功を返す（`replayed: true`）。物理安全上もっとも重要（ADR 0003 §3 の「success のみ厳密復元」とデバイス側で整合）。
- **タイムアウト**: `mode timeout` のとき device は応答しない。呼び出し側（backend `DeviceCommandPort`）はタイムアウトし `504 timeout`（retryable）にマップする。

## このスライスの範囲外（次段以降）

- (b) functions のテレメトリ受信ハンドラ（onEntry/onExit/onPlateUp）— 別 PR。
- (c) backend の実 `DeviceCommandPort` 実装（IoT Hub サービス SDK で `down` を invoke）— 別 PR。
- §5.3 安全インターロックの自動 UP ロジック、満空センサーの自動検知。
