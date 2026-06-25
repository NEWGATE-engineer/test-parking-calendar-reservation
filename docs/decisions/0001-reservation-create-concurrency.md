# ADR 0001: 予約作成の競合制御と層の責務

- ステータス: 承認
- 日付: 2026-06-25
- 関連: 要件定義 §8 / API 設計書 `POST /reservations` / [CLAUDE.md](../../CLAUDE.md) ドメイン規約

## 背景

`POST /reservations` は「同一区画・同一時間帯の二重予約」「バッファ時間 B 未満の近接予約」「不健全なデバイスへの予約」を防ぎつつ作成する必要がある。
Azure SQL には PostgreSQL の排他制約（`EXCLUDE USING gist`）のような**範囲排他制約が無い**ため、DB 制約だけでは時間帯の重なりを宣言的に弾けない。判定（SELECT）と作成（INSERT）の間に他トランザクションが割り込む TOCTOU をどう防ぐかが論点。

## 決定

### 1. 単一 SERIALIZABLE トランザクションで判定→INSERT を原子化（Approach A）

「区画＋デバイス SELECT → 同一区画の競合 SELECT → 可否判定 → 条件付き INSERT」を**一つの SERIALIZABLE トランザクション**に束ねる。
SERIALIZABLE の範囲ロックにより、判定に使った時間帯範囲へ他者が INSERT するのをブロックし、TOCTOU を防ぐ。

- 競合判定ロジックは `GET /spots/availability` と同じ純粋関数 `availabilityForSpot` を再利用し、「予約可と表示されたのに作成で弾かれる」食い違いを最小化する。
- 1205（デッドロック被害者）は短い指数バックオフで数回まで再試行し、枯渇したら 500 として伝播（`withSerializableTx`）。

### 2. トランザクション境界はサービス層が所有する

ドメイン判断（可否・コミットするかロールバックするか）を含むため、トランザクション境界は**サービス（ユースケース）層**が持つ。
リポジトリは `tx` を受け取って 1 クエリを実行するだけの薄い層に留める。Laravel の `DB::transaction(fn)` と同じ構図で、`withSerializableTx(fn)` をサービスに注入する（テストでは「コールバックを即実行する偽ランナー」に差し替え、DB なしで分岐を検証できる）。

> 補足: 認証の `createUserWithConsent` はリポジトリがトランザクションを所有しているが、あれは「途中にドメイン判断が無い 2 INSERT の束ね」であり性質が異なる。予約作成は SELECT と INSERT の間に可否判断が入るため、サービス所有が適切。

### 3. エラーの語彙を availability とそろえる

| 状況 | HTTP | code | retryable |
| --- | --- | --- | --- |
| 入力不正 / end≤start / 過去開始 | 422 | `validation_error` | — |
| 区画が存在しない（他人秘匿含む） | 404 | `not_found` | — |
| 時間帯の重複 | 409 | `conflict_overlap` | false |
| バッファ未満の近接 | 409 | `conflict_buffer` | false |
| デバイス不健全 | 409 | `device_unhealthy` | false |

`availabilityForSpot` の reason（`reserved` / `buffer`）は API code（`conflict_overlap` / `conflict_buffer`）へ変換する。
他人・不在の資源は情報漏洩防止のため 403 ではなく 404 に寄せる。

### 4. 作成時は Fee 行を作らない

`estimated_slot_fee` は `config.reservation`（仮 100 円 / 30 分、§12 #1）から算出して 201 で返す**見込み額**のみ。
確定額（Fee テーブル）は完了確定時にのみ INSERT する（`UQ_Fee_resv` 違反回避・CLAUDE.md）。

## 影響

- `backend/src/db.ts` に `withSerializableTx` / `Tx` / `TxRunner` を追加。
- `backend/src/reservations/`（validation / fee / repository / service / router）を追加。
- 料金単価・バッファ B・健全性閾値は**仮値**（要件 §12 未確定）。確定したら環境変数で上書きする。

## 代替案

- **B: 楽観ロック（条件付き INSERT のみ）** — 範囲排他制約が無いため「重なりが無いこと」を WHERE で表現できず、二重予約を取りこぼす。不採用。
- **C: アプリ内ロック / 区画ごとの分散ロック** — 単一プロセス前提が崩れると破綻し、運用が複雑。MVP には過剰。不採用。
