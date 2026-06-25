# ADR 0003: gate-down（DOWN 指示）の冪等性と失敗セマンティクス

- ステータス: 承認
- 日付: 2026-06-25
- 関連: 要件 §4-6 / API 設計書 `POST /reservations/{id}/gate-down` / シーケンス図（DOWN 失敗フロー・F4-6）/ [CLAUDE.md](../../CLAUDE.md)

## 背景

入庫時の DOWN 指示（ロック板を下げる物理動作）は、ネットワーク再送や二重タップで**二重発火すると危険**。一方で「デバイス無応答」「デバイス不健全」「区画が物理占有中」を区別してユーザーに適切な再試行可否を返す必要がある。IoT Hub への実接続はこのスライスでは未配線（device-sim / IoT 連携スライスで実装）。

## 決定

### 1. CommandLog は「pending INSERT → 結果 UPDATE」に統一、冪等性は request_id UNIQUE

全コマンド経路で、まず `CommandLog` を `result='pending'` で 1 行 INSERT し、確定後に `success`/`failure` へ UPDATE する（F4-6）。冪等キー `CommandLog.request_id` の UNIQUE 制約（`UQ_Cmd_request`）で重複を吸収する。

**request_id の採番方針**（CLAUDE.md）: 1 送信操作（初回タップ／再試行タップ）ごとに**新規** request_id。同一送信のトランスポート再送（ネットワーク再試行・二重タップ）だけが同一キーを共有する。

### 2. 処理順（404 のみ CommandLog を書かない）

1. **冪等再送チェック**（`findCommandByRequestId`）→ 既存があれば結果を再現（§3）。
2. コンテキスト取得 → 無ければ **404 `not_found`**（他人秘匿。FK 上 CommandLog を書けない唯一の無ログ経路）。
3. **pending INSERT**（UNIQUE 違反＝並行再送なら §3 に合流）。
4. 状態/期間 NG → failure → **409 `invalid_state`**（reserved 以外、または now が [start, end] 外）。
5. 物理占有（`occupancy='occupied'`）→ failure → **409 `physical_occupancy`**（IoT を呼ぶ前に拒否）。
6. デバイス事前 NG（`last_seen_at` 古い／未割当）→ failure → **503 `device_unhealthy`**（IoT を呼ばず即時失敗。タイムアウト待ちを避ける）。
7. デバイス送信（`DeviceCommandPort`）→ 無応答 → failure → **504 `timeout`（retryable=true）** / 成功 → success → **200**。

### 3. 冪等再送の復元度は MVP=「success のみ厳密復元」

`CommandLog.result` は `pending/success/failure` の 3 値のみで**失敗理由を保持しない**ため、再送時に 503/504/409 を厳密再現できない。MVP では:

- `success` 再送 → 同じ `command_id` で **200**（デバイスを**再発火しない**＝物理安全上もっとも重要なケースを完全保証）。
- `pending` 再送 → **409 `command_in_progress`**（処理中）。
- `failure` 再送 → **409 `command_failed`**（この request_id は失敗済み。**新しい request_id で再試行**させる＝採番方針と整合）。

> 失敗理由まで厳密再現したい場合は `CommandLog` に `fail_reason` 列を追加するマイグレーションが必要（将来課題）。MVP は物理安全に直結する success の冪等のみ保証する。

### 4. デバイス送信は DeviceCommandPort で抽象化（Azure 非依存）

IoT Hub ダイレクトメソッドは `interface DeviceCommandPort` の背後に隠す。サービスのドメインロジックを Azure 非依存にし、テストはモックで全分岐（200/404/409×/503/504/冪等）を DB・IoT なしで検証する。実 IoT 実装は device-sim / IoT 連携スライスで注入する（それまで既定は未設定スタブ）。

### 5. レイヤは予約 CRUD と分離

gate-down は `CommandLog`・`DeviceCommandPort` という CRUD と異なる依存を持つため、`ReservationsService` に足さず `GateDownService` + `CommandLogRepository` + 専用ルーター（同じ `/reservations` マウントに併設）に分離する（[[service-split-convention]] の「依存が分岐したら分割」）。

## 影響

- 追加: `reservations/{gateDown.validation,deviceCommandPort,commandLog.repository,gateDown.service,gateDown.router}.ts`、`app.ts` 配線。
- OpenAPI: gate-down の 409 に invalid_state / command_in_progress / command_failed を明記、code 例に追加。
- DDL 変更なし（既存 CommandLog を使用）。
- 仮値（健全性閾値）は要件 §12 未確定のまま `config.device.healthThresholdMinutes`。

## 代替案

- **失敗理由を保持して全復元**: `fail_reason` 列追加。仕様の「同じ結果を返す」を厳密に満たすが DB マイグレーションを伴う。MVP では過剰として success 復元に限定。
- **invalid_state を 422**: 入力不正でなくドメイン状態の競合なので 409 が適切。422 は採らない。
