# ADR 0007: 予約ライフサイクルの定期走査（タイマー）

- ステータス: 承認
- 日付: 2026-06-30
- 関連: [バックエンド処理一覧（トリガ別）](../architecture/バックエンド処理一覧（トリガ別）.md) C節 / [残りのフロー図（ノーショー）](../architecture/駐車場予約システム%20残りのフロー図（キャンセル／ノーショー／入庫待ちタイムアウト）.md) / [ADR 0005](0005-telemetry-ingestion.md)（テレメトリ受信）/ 要件 §6・§12 / [CLAUDE.md](../../CLAUDE.md)

## 背景

予約ライフサイクルには、イベント（IoT テレメトリ）だけでは確定できない遷移がある。

- **detectNoShow**: 一度も入庫しないまま猶予を過ぎた予約を `no_show` にして区画を解放する。
- **detectOverstay**: 終了時刻を過ぎても在車（出庫していない）予約を `overstay` にする。
- **autoComplete**: 終了後に出庫済みで未確定の予約を `completed` にし確定料金を確定する。出庫イベント
  （onExitDetected）での即時確定の取りこぼし（テレメトリ欠落・終了前の通常退出）の**安全網**。

これらは Azure Functions のタイマートリガで定期走査する（要件 §2「予約ライフサイクルの定期処理」）。

## 決定

### 1. 1 関数・単一 sweep（処理一覧 C の推奨）

`functions/src/functions/lifecycleSweep.ts`（タイマートリガ）が `@parking/core` の `LifecycleService.sweep(now)` に委譲し、3 遷移を **noShow → overstay → autoComplete の順**で実行する。ある瞬間の 1 予約はこの 3 つに同時該当しない（open UsageRecord の有無で排他）ため、順序による二重処理は起きない。テレメトリ slice b と同じ「薄い Functions トリガ → core サービス」の型を踏襲する。

### 2. detectNoShow / detectOverstay は set-based 一括 UPDATE

副作用が status 変更だけなので、該当全行を 1 文の条件付き UPDATE で遷移させる（`WHERE status='reserved' … NOT EXISTS(UsageRecord)` / `WHERE status='active' … EXISTS(open UsageRecord)`）。更新行数を件数として返す。フィルタ索引 `IX_Reservation_noshow` / `IX_Reservation_overstay` を利用。**ノーショー判定は occupancy ではなく UsageRecord の有無**で行う（CLAUDE.md）。

### 3. autoComplete は候補スキャン→1 件ずつトランザクション

予約ごとに確定料金（枠＋超過）を Fee へ INSERT する必要があるため、`findCompletable(now)` で候補（最終出庫 `MAX(exit_time)` つき）を抽出し、**1 件ずつ独立した SERIALIZABLE トランザクション**で確定する。長大トランザクションでロックを抱えないため、1 件ずつに分ける。

**確定は「条件付き UPDATE（`WHERE status IN ('active','overstay')`）が 1 件成功したときだけ Fee を INSERT」**。これは onExitDetected（[ADR 0005](0005-telemetry-ingestion.md)）と同一の共有ドメイン操作で、タイマーとテレメトリ即時確定が同時に走っても `UQ_Fee_resv` と合わせて**勝者 1 件だけが Fee を INSERT**する（二重課金しない）。確定料金は `computeCompletionFee`（既存・`reservations/fee.ts`）を再利用する。

### 4. 失敗は 1 件単位で握り、走査は継続

autoComplete の 1 件が DB エラーで失敗しても他を止めず、`SweepResult.failures` に積んで走査を続ける（安全網なので次回走査で再試行できる）。set-based の no_show/overstay 更新が失敗した場合は例外が伝播し、Functions が次のスケジュールで再実行する。冪等（条件付き UPDATE）なので再実行は安全。

### 5. ノーショー課金は無し（MVP）

要件 §6「課金は予約金導入まで無し（仮置き）」・§12 #3 未決のため、detectNoShow は status 遷移のみで Fee を作らない。

### 6. 走査間隔・猶予は仮値（env 上書き可）

- ノーショー猶予 `config.reservation.noShowGraceMinutes` = 仮 30 分（要件 §6・§12 #3）。入庫待ちタイムアウト（デバイス側・仮 5 分）より長く保つ（逆転すると「DOWN 試行で失敗したのに先にノーショー確定」になる）。
- 走査間隔 NCRONTAB = 仮 5 分毎（`0 */5 * * * *`）。サーバーレス自動停止とのコスト綱引き（§12 #9）。App Settings `LIFECYCLE_SWEEP_SCHEDULE` で上書き可。

## 影響

- 追加: `core/src/lifecycle/{repository,service,index}.ts`、`functions/src/functions/lifecycleSweep.ts`、`backend/test/lifecycle.service.test.ts`＋`helpers/mockLifecycleRepo.ts`、本 ADR。
- 変更: `core/src/config.ts`（`reservation.noShowGraceMinutes` 追加）、`core/src/index.ts`（lifecycle バレル公開）、`docs/README.md`（ADR 一覧）、`docs/architecture/バックエンド処理一覧（トリガ別）.md`（C 節に実装メモ＋本 ADR 参照を追記）。
- App Settings（functions 実環境）: 任意 `LIFECYCLE_SWEEP_SCHEDULE`（既定 `0 */5 * * * *`）。
- DDL 変更なし（既存のフィルタ索引を利用）。

## フォローアップ / 残課題

- `completeReservation` / `insertFee` は telemetry repo と同一 SQL の共有ドメイン操作。MVP は重複を許容するが、将来 `reservations/` 配下の completion repo へ抽出する候補（[[service-split-convention]]）。
- `findCompletable` の `overstay` 候補は `IX_Reservation_overstay`（`WHERE status='active'`）の対象外で索引外スキャンになり得る。ただし通常 overstay→completed は onExitDetected が即時確定するため候補は稀。多発するなら `(status, end_time)` 系の索引を別マイグレーションで検討。
- finishUsage（終了申告 API・end_time 前倒し）は未実装。実装時、detectOverstay との関係（「申告したのに超過」）を §12 #1/#2 と合わせて決める。

## 代替案

- **3 つを別タイマー関数に分割**: トリガ・走査基盤・実行順を共有するため 1 関数に集約（処理一覧 C の推奨）。分割は配線重複を生むため不採用。
- **autoComplete も set-based**: Fee が予約ごとの計算（最終出庫・超過）を要するため純 set-based にできない。候補スキャン→1 件ずつ確定を採用。
