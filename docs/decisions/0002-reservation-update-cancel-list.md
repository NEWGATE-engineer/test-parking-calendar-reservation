# ADR 0002: 予約の変更・キャンセル・一覧の設計

- ステータス: 承認
- 日付: 2026-06-25
- 関連: 要件定義 §8 / API 設計書 `GET/PUT/DELETE /reservations` / [ADR 0001](0001-reservation-create-concurrency.md) / [CLAUDE.md](../../CLAUDE.md)

## 背景

3c で予約の変更（PUT）・キャンセル（DELETE）・一覧（GET）を実装する。
変更・キャンセルは「`reserved` のときだけ可」というドメイン規約があり、タイマー確定やデバイスイベントなど複数アクターが同じ行を触る前提で、競合を取りこぼさず・かつ「存在しない」と「状態が違う」を正しく区別する必要がある。

## 決定

### 1. 状態遷移はすべて「現在状態を WHERE に含めた条件付き UPDATE」（0件＝競合）

CLAUDE.md の原則どおり、変更・キャンセルとも `WHERE id=@id AND user_id=@user_id AND status='reserved'` の条件付き UPDATE で行う。読んでから無条件 UPDATE はしない。

- **変更（PUT）**: 時刻・区画が変わり得るので**競合再チェックが必要 → SERIALIZABLE トランザクション**（ADR 0001 と同じ `withSerializableTx`）。トランザクション内で「対象 SELECT → 状態確認 → 競合再チェック → 条件付き UPDATE」を原子化する。
- **キャンセル（DELETE）**: 時間範囲の競合は無関係なので**単一の条件付き UPDATE（`status='cancelled'`）で十分**。トランザクションは張らない。

### 2. 404 と 409 の切り分け

条件付き UPDATE が 0 件のとき、「存在しない／他人」（404）と「reserved 以外」（409）を区別する：

- **PUT**: トランザクション内でまず所有者付き SELECT。`null` → 404、`status != 'reserved'` → 409。その後 UPDATE（防御的に 0 件なら 409）。
- **DELETE**: 条件付き UPDATE を先に実行。1 件 → 204。0 件のときだけ所有者付きで status を引き、`null` → 404、それ以外 → 409。実状態変更は原子的に済んでおり、追加 SELECT はエラー分類のためだけ（best-effort）。

他人の予約 ID は存在秘匿のため 403 ではなく 404（情報漏洩・列挙対策）。

### 3. 409 の code 語彙は操作別

| 操作 | 状態違反時の code |
| --- | --- |
| PUT | `not_modifiable` |
| DELETE | `not_cancelable` |

競合系（`conflict_overlap` / `conflict_buffer` / `device_unhealthy`、ADR 0001）とは別語彙にして、「状態が理由」か「競合が理由」かをクライアントが code だけで判別できるようにする。いずれも retryable=false。

### 4. PUT は部分更新（PATCH 風マージ）

`UpdateReservationRequest` は全フィールド任意。省略フィールドは**現在値を維持してマージ**し、マージ後の値で不変条件（`end>start`・過去開始でない）と競合を検証する。
更新項目が空のボディは 422（誤呼び出し検知）。competition 再チェックでは**自分自身を除外**する（`findConflictsForSpot` の `excludeReservationId`）。
`estimated_slot_fee` は変更後の時刻で再計算して返す（Fee 行は作らない＝完了時のみ）。

### 5. 一覧（GET）は自分の予約のみ・status 絞り込み

`user_id = 認証ユーザー` で `IX_Reservation_user`（被覆）を使い新しい開始順で返す。`?status=` は enum 検証し、未知の値は 422（黙って全件返しにしない）。トランザクション不要（読み取り）。

## 影響

- `reservations/`（validation / repository / service / router）へ list/update/cancel を追加。`ReservationsService` は1クラスのまま（[[service-split-convention]] の方針。肥大化したら usecases/ 分割）。
- OpenAPI: GET に 422、PUT/DELETE の 409 code（not_modifiable / not_cancelable）を明記。
- 仮値（料金単価・バッファ B・健全性閾値）は引き続き要件 §12 未確定。

## 代替案

- **PUT を全置換**（全フィールド必須）: REST の PUT に忠実だが OpenAPI の optional 定義とずれ、「時間だけ変更」が冗長。部分更新を採用。
- **409 を共通 `invalid_status`**: シンプルだがクライアントが message パースを要する。操作別 code を採用。
