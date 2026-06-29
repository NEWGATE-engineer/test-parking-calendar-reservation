# ADR 0005: テレメトリ受信（onEntry/onExit/onPlateUp）の冪等性・マッピング・完了確定

- ステータス: 承認
- 日付: 2026-06-29
- 関連: 要件 §5.3-5.4 / [バックエンド処理一覧 §B](../architecture/バックエンド処理一覧（トリガ別）.md) / シーケンス図（超過フロー・残りのフロー図）/ [[0001-reservation-create-concurrency]] / [[0003-gate-down-idempotency]] / [[0004-monorepo-core-extraction]] / device-sim/README.md（メッセージ契約）

## 背景

IoT 連携スライス (b)。device-sim が送る entry（在車検知）/ exit（空車検知）/ up（UP 実行）テレメトリを Azure Functions で受け、状態遷移（reserved→active・completed）・UsageRecord・DeviceEvent・占有状態・完了料金を更新する。IoT Hub トリガは **at-least-once**（同じイベントが二度届き得る）で、タイマー（autoComplete 等）とも競合し得る。

## 決定

### 1. 冪等化は「ドメイン条件」で行う（新テーブルなし）

ProcessedEvent(eventId) のような重複排除テーブルは MVP では作らない。代わりに:

- **入庫**: その予約に open（exit_time 未記録）な UsageRecord があれば UsageRecord を挿入しない。
- **状態遷移はすべて条件付き UPDATE**（現在状態を WHERE に含める）。`reserved→active` / `→completed` / 板 `down→up` / 出庫の `exit_time IS NULL` 更新。0 件は「既処理／競合」とみなす。
- **DeviceEvent の記録も「実際に遷移した（行数 1）」ときだけ**に限定し、再配信での重複行を避ける（入庫は UsageRecord 新規挿入時・出庫は close 成功時・UP は raise 成功時）。

テレメトリの `eventId` はメッセージ契約に残すが MVP では未使用（観測・将来の厳密化の余地）。厳密な「全イベント 1 回」保証が必要になったら ProcessedEvent テーブル追加（add-migration）で強化する。

> 例外: 予約に紐づかない入庫（物理占有の残存リスク・§4.3.2）は open ゲートが効かず、再配信で DeviceEvent(entry, reservation_id=null) が重複し得る。稀な異常系の監査目的なので MVP では許容する。

### 2. deviceId → 予約のマッピング

テレメトリの `deviceId` から `Device`（spot と 1:1）→ `spot_id` を得て、その区画の「いま有効な予約」を特定する:

- **入庫**: `status IN ('reserved','active')` かつ発生時刻が `[start_time, end_time]` 内の予約（重複予約は作成時に排除済み＝高々 1 件）。
- **出庫**: その区画の open な UsageRecord（→予約期間）を起点にする（occupancy ではなく open UsageRecord 基準。CLAUDE.md）。

### 3. トランザクション境界は SERIALIZABLE・サービス所有

各ハンドラは `withSerializableTx` の中で read→write を原子的に行う（[[0001-reservation-create-concurrency]] と同方針）。at-least-once の同時再配信やタイマーとの割り込みを範囲ロックで防ぐ。

### 4. 完了確定と Fee は「条件付き UPDATE が 1 件成功時のみ INSERT」

出庫時に「終了時刻を経過 かつ 残 open UsageRecord なし（空車）」なら `completeReservation`（`WHERE status IN ('active','overstay')`）を実行し、**1 件成功した勝者だけ** Fee を INSERT する。これで `UQ_Fee_resv`（reservation 一意）違反と「completed だが Fee 未記録」を同時に防ぐ。タイマー autoComplete も同方式で、イベント欠落時の安全網として両立する（バックエンド処理一覧）。確定料金 = 予約枠（`estimateSlotFee`）＋ 超過（`estimateOverstayFee` = max(0, 最終 exit − end) を単位切り上げ）。

### 5. functions は薄いアダプタ・CommandLog に触らない

functions は「受信→検証（`parseTelemetryEvent`）→ディスパッチ→ログ」に徹し、ドメインは `@parking/core` の `TelemetryService` が持つ。

- **poison メッセージ**（形不正）はログのみで読み飛ばす（throw しない＝無限再試行を避ける）。
- **一時障害**（DB 等）は throw して Functions の再試行に委ねる（冪等なので再処理は安全）。
- **CommandLog には触らない**（DOWN の success/failure 記録は backend の同期応答のみが担当＝論点D）。

### 6. レイヤ配置

新規 IoT ロジックは最初から core に置く（[[0004-monorepo-core-extraction]] の方針）。`core/src/telemetry/{types,validation,repository,service,index}.ts`。functions は `functions/src/functions/telemetry.ts`（Event Hub トリガ）。

### 7. config の調整

- `config.jwt.secret` を **遅延 getter** 化。config は backend（認証あり）と functions（認証なし）が共有する。eager に `required('JWT_SECRET')` すると functions の起動に無関係な JWT_SECRET が必要になるため、auth が触れた時だけ必須化する（SQL 接続文字列は両者が使うので eager のまま）。
- `config.reservation.overstayUnitPriceJpy` を追加（超過単価・仮値・§12 #1 未確定）。

## 影響

- 追加: `core/src/telemetry/*`、`functions/src/functions/telemetry.ts`、`reservations/fee.ts` に `estimateOverstayFee`/`computeCompletionFee`、テスト（telemetry.service・fee 超過）。
- 変更: `config.ts`（jwt.secret 遅延化・overstay 単価追加）、`core/src/index.ts`（telemetry バレル公開）。
- DDL 変更なし（既存テーブルを使用。冪等化テーブルは作らない）。
- フォローアップ（次の add-migration スライス）: `findOpenUsageForSpot` 用に被覆索引
  `IX_UsageRecord_resv_open (reservation_id, exit_time) INCLUDE (entry_time, id)` を追加し、
  SERIALIZABLE 下のスキャン範囲＝ロック保持時間を抑える（コードに TODO コメントを残置）。
- functions の App Settings: `SQL_CONNECTION_STRING`（core 接続）、`IOT_HUB_EVENTS`（IoT Hub 組み込みエンドポイント接続文字列）、`IOT_HUB_EVENT_HUB_NAME`。

## 代替案

- **ProcessedEvent テーブルで eventId 重複排除**: 厳密な「全イベント 1 回」を保証するが DB マイグレーション＋ ER/DDL 同期を伴い本スライスが重くなる。ドメイン条件で実害なく吸収できるため MVP では不採用（将来余地）。
- **3 つの個別トリガ関数**: onEntry/onExit/onPlateUp を別関数に。種別分岐の単一ハンドラの方が配線が単純で、契約（type フィールド）とも一致するため単一に統一。
- **completed を occupancy で判定**: テレメトリ反映遅延で誤判定し得るため、open UsageRecord 基準に統一（CLAUDE.md）。
