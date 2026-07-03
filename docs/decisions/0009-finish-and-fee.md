# ADR 0009: 利用終了申告（finish）・料金取得（fee）と完了確定ロジックの共有化

- ステータス: 承認
- 日付: 2026-07-01
- 関連: API 設計書 `POST /reservations/{id}/finish` / `GET /reservations/{id}/fee` / [バックエンド処理一覧](../architecture/バックエンド処理一覧（トリガ別）.md)（finishUsage）/ [ADR 0005](0005-telemetry-ingestion.md)（onExit 完了確定）/ [ADR 0007](0007-lifecycle-timer-sweep.md)（autoComplete）/ [CLAUDE.md](../../CLAUDE.md)

## 背景

OpenAPI には定義済みだが未実装だった2エンドポイントを実装する。

- **`POST /reservations/{id}/finish`**（利用終了申告）: 在車中は `end_time` を今に前倒し、完了確定は出庫検知に合流。すでに空車なら即完了確定＋料金確定。active/overstay 以外は 409。
- **`GET /reservations/{id}/fee`**（料金取得）: Fee 行があれば返し、無ければ `status=pending` を合成。他人/不在は 404。

また finish の「空車なら完了確定」は、既に **onExitDetected（telemetry）・autoComplete（lifecycle）** に重複していた「完了確定＋料金 INSERT」ロジックの**3番目の利用者**になる。ADR 0007 で「将来 completion repo へ抽出」と先送りしていたが、ここで抽出する。

## 決定

### 1. 完了確定ロジックを `reservations/completion.ts` に共有化

「完了は条件付き UPDATE（active/overstay→completed）が1件成功したときだけ Fee を INSERT する」を、SQL・オーケストレーションともに1箇所へ集約する。

- `SqlCompletionRepository`（`completeReservation` ＋ `insertFee` の SQL の唯一の置き場）。
- `settleCompletion(tx, repo, params)`（完了 UPDATE → 1件成功なら `computeCompletionFee` → `insertFee` のオーケストレーション）。
- `CompletionRepository` interface。

**波及を最小化**するため、既存の `SqlTelemetryRepository` / `SqlLifecycleRepository` は自前 SQL をやめ、内部に `SqlCompletionRepository` を持って `completeReservation`/`insertFee` を**委譲**する（サービスのコンストラクタ・モック・インターフェースは不変＝振る舞い不変で既存 256 テスト green を維持）。両サービスの完了処理は `settleCompletion` を呼ぶ形に統一。finish も同じ委譲で `settleCompletion` を使う。

これで「完了＋料金」の SQL とオーケストレーションが1箇所になり、UQ_Fee_resv 二重防止・勝者1件の不変条件が全経路で共有される（複数経路が同時に確定しても二重課金しない）。

### 2. finish は SERIALIZABLE トランザクションで在車分岐

`finish.service.ts`（`FinishService`）＋`finish.repository.ts`。tx 内で: 所有者付き取得（404）→ active/overstay 以外は 409 `not_finishable` → `end_time > now` なら今に前倒し（早め終了。overstay の過去 end は触らない）→ **open UsageRecord の有無**で分岐:

- **在車中**（open あり）: 完了しない（end_time 前倒しのみ）。出庫検知（onExit）で確定させる。
- **空車**（open なし）: `settleCompletion` で完了確定＋確定料金（最終出庫 = `MAX(exit_time)`）。

在車判定は occupancy ではなく **open UsageRecord の有無**で行う（CLAUDE.md）。`now` はサービス引数で受ける（テスト容易性）。

### 3. fee は読み取りのみ・pending 合成

`fee.service.ts`（`FeeService`）＋`fee.repository.ts`。所有権確認（他人/不在は 404）→ Fee 行があれば返す／無ければ `status=pending`（slot/overstay/total=0・calculated_at=null）を合成。状態遷移が無いためトランザクションは張らない。

## 影響

- 追加（core）: `reservations/{completion,fee.repository,fee.service,finish.repository,finish.service}.ts`。
- 変更（core）: `telemetry/repository.ts`・`lifecycle/repository.ts`（完了確定を委譲・自前 SQL と `FeeInput` 定義を削除し completion から利用）、`telemetry/service.ts`・`lifecycle/service.ts`（`settleCompletion` 利用）、`reservations/index.ts`（バレル公開）。
- 追加（backend）: `reservations/{finish.router,fee.router}.ts`＋`app.ts` 配線。finish ルーターは `runTx` を注入可能（http テストで DB を使わないため）。
- テスト: `finish.service`（6）・`fee.service`（3）・`finish.http`（5）・`fee.http`（4）。既存の telemetry/lifecycle テストは振る舞い不変で green。
- OpenAPI: finish の 409 に `Error.code=not_finishable` を明記。fee は定義済みで変更なし。
- **DDL 変更なし**（Reservation・UsageRecord・Fee は既存）。

## フォローアップ / 残課題

- finish で end_time を前倒し後、在車のままだと次の detectOverstay 走査で overstay になり得る（「申告したのに超過」）。料金・キャンセルポリシー（§12 #1/#2）確定時に「申告後の猶予」を設けるか決める。
- モバイルの利用終了・料金確認 UI（M3 で対象外にしていた分）を後続で実装できるようになった。

## 代替案

- **抽出せず finish に3つ目の重複**: レビューで2度指摘された重複を残すため不採用。3番目の利用者が出た今が抽出の適時。
- **完了 SQL を各 repo に残しオーケストレーションのみ共有**: SQL 重複が残る。委譲方式なら振る舞い不変のまま SQL も1箇所にできるため委譲を採用。
