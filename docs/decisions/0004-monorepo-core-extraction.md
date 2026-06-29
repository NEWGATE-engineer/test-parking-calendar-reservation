# ADR 0004: ドメインロジックの `core` パッケージ切り出し（npm workspaces 化）

- ステータス: 承認
- 日付: 2026-06-26
- 関連: 要件 §4-6 / [CLAUDE.md](../../CLAUDE.md)（状態遷移は条件付き UPDATE）/ [[0001-reservation-create-concurrency]] / [[0003-gate-down-idempotency]] / IoT 連携スライス（device-sim / functions テレメトリ受信）

## 背景

IoT 連携の次スライスで、**Azure Functions（テレメトリ受信・タイマー）が backend と同じドメインロジックを実行する**必要が出る。具体的には:

- `onEntry`（在車検知）: `reserved → active` への**条件付き UPDATE** ＋ `UsageRecord` INSERT
- `onExit`（空車検知）: 完了確定の**条件付き UPDATE** ＋ `Fee` INSERT
- タイマー: `detectNoShow` / `detectOverstay` / `autoComplete`（いずれも UsageRecord 基準・条件付き UPDATE）

これらは本 PJ の生命線である「**現在状態を WHERE に含めた条件付き UPDATE**」（CLAUDE.md）と、`withSerializableTx`（[[0001-reservation-create-concurrency]]）に依存する。この資産は現在 `backend/src/db.ts` と `backend/src/reservations/` にあり、**backend からしか import できない**。

### 何が問題か

| 選択肢 | 内容 | 評価 |
| --- | --- | --- |
| B1 共有パッケージ | `core` を新設し backend / functions 双方が import | **採用**。規約（条件付き UPDATE）を 1 箇所に集約しドリフトを防ぐ |
| B2 functions に再実装 | functions 側で独自に SQL | 状態遷移規約が 2 箇所に分散。直し忘れで「片方だけ腐る」事故が実務最多。不採用 |
| B3 functions→内部 API | functions が backend のエンドポイントを叩く | 同一 DB を共有する構成で遅延・認証の二重コスト。過剰。不採用 |

Express の API と Functions のトリガが**同じ Service / Action を呼ぶ**——Laravel なら Controller と Queue Job が同じサービスクラスを共有する自然な形。TS では実行環境が App Service と Functions に分かれるため、**workspaces で `core` を明示的に切り出す**一手間が要る。

加えて、`reserved → active` 等の状態遷移ロジックは **backend にもまだ無い（これから書く新規コード）**。既存資産の共有化リファクタではなく「最初から `core` に置けばドリフトが発生しない」——core 切り出しの最適タイミングである。

## 決定

### 1. npm workspaces で `core` パッケージを新設（B1）

ルートに `package.json`（`"workspaces"`）を置き、既存の `backend` / `functions` / `device-sim` をメンバとしたまま、ドメイン層を `core` パッケージに切り出す。Nx / Turborepo は本規模では過剰のため**素の npm workspaces**を採る。

```
（ルート）
  package.json          ← 新規。"workspaces": ["core","backend","functions","device-sim"]
  package-lock.json     ← 各パッケージの lock を統合した単一 lock
  core/                 ← 新規。Azure 非依存のドメイン層
    package.json        ← name: "@parking/core"
    src/
      db.ts             ← backend から移設（getPool/withSerializableTx/Tx/TxRunner）
      config.ts         ← DB 接続・reservation・device の設定（一部）
      errors.ts         ← ドメイン例外 AppError（HTTP マッピングは backend に残す）
      reservations/     ← repository / service / fee / validation / commandLog.repository / deviceCommandPort（ポート interface）/ gateDown.* + index.ts（バレル）
      spots/            ← repository / service / availability / validation + index.ts（バレル）
  backend/              ← Express アダプタ。@parking/core を import
  functions/            ← IoT/Timer アダプタ。@parking/core を import
  device-sim/           ← core 非依存（デバイス SDK のみ）。workspaces メンバだが core を使わない
```

### 2. `core` の境界原則（何を入れ、何を入れないか）

- **入れる**: Azure / Express / IoT に依存しない「ドメインロジック・DB アクセス・状態遷移・純粋計算（料金等）・ポート interface」。
- **入れない（アダプタ側に残す）**:
  - Express / HTTP（router・errorHandler・requireAuth・asyncHandler）→ `backend`。なお入力バリデーション（`unknown` → 型付きへ parse する純粋関数）は Express 非依存かつ service が依存するため `core/{reservations,spots}/validation.ts` に移設済み（第2段・§4）。
  - IoT Hub / Functions ランタイム（トリガ・テレメトリ parse）→ `functions`
  - デバイス SDK（azure-iot-device）→ `device-sim`、および `DeviceCommandPort` の**実 IoT 実装**（アダプタ）→ `backend`/`functions`
- **ポート&アダプタ**: `DeviceCommandPort`（[[0003-gate-down-idempotency]] §4）の interface は `core/reservations/deviceCommandPort.ts`、実装は注入。テストは引き続きモックで DB・IoT なし検証。

### 3. モジュール系を ESM に統一し、functions を ESM 化

現状 backend=ESM（`type:module`, `nodenext`, TS 6.x）に対し functions=CJS（`commonjs`, `es6`, `strict:false`, TS 5.x）。`core` を両者が import するには系を揃える必要がある。

- `core` を **ESM**（backend と同じ `nodenext` / TS 6.x / `strict:true`）で書く。
- **functions を ESM 化**する（`@azure/functions` v4 は Node 18+ で ESM 対応）。`tsconfig` を `nodenext`・`type:module`・`strict:true` に寄せ、TS / `@types/node` を backend と同一バージョンに統一。
- `device-sim` は core 非依存なので CJS のまま据え置き（変更を最小化）。

### 4. 段階移行（一度に全部移さない）

IoT スライスが必要とする最小限から `core` へ移す:

1. 第1段（完了・PR #20）: `db.ts` ＋ `config.ts`（DB/reservation/device 設定）＋ `errors.ts`（AppError）を `core` へ。backend の import を `@parking/core` に張り替え、既存 190 テストが green を維持。
2. 第2段（完了）: `reservations/{repository,service,fee,validation,commandLog.repository,deviceCommandPort,gateDown.service,gateDown.validation}`・`spots/{repository,service,availability,validation}` を `core` へ（状態遷移リポジトリ・ポート interface を含む）。`router` のみ backend に残す（Express 依存層）。core は `reservations/index.ts`・`spots/index.ts` のバレル経由で公開。
   - **当初案からの変更**: テストは `core` へ移設せず backend に据え置き、import のみ `@parking/core` に張り替えた。理由は mock helper（`mockReservationsRepo` / `mockSpotsRepo` / `mockGateDown`）が **ドメイン単体テストと HTTP（supertest）テストで共有**されており、helper を core へ移すと backend 側 HTTP テストが壊れ、複製すると drift するため。テスト移設は core が共有 helper に依存しない単体テストを持つ第3段（IoT 新規ロジック）以降に再検討する。
3. 以降の IoT スライスで `reserved→active` 等の新規ロジックは最初から `core` に書く。

各段でビルド・テストを通し、PR を分けてリスクを抑える。

### 5. CI / lint の再配線

- `ci.yml`: 現在 `working-directory: backend`・`cache-dependency-path: backend/package-lock.json` 前提。**ルートで `npm ci`** → `core` と `backend` で typecheck / lint / test を回すよう変更（`npm test --workspaces` 等）。`paths` に `core/**`・ルート lock を追加。
- `biome.json`: `backend/biome.json` をルートへ昇格し `core`・`functions` も対象化（PostToolUse hook の対象も拡張）。
- `supply-chain-audit.yml` / `db-test.yml`: 単一 lock 化に伴う `npm ci` パスを点検。

## 影響

- 追加: ルート `package.json`（workspaces）・統合 `package-lock.json`・`core/` パッケージ。
- 変更: backend の import パス（`./db.js` → `@parking/core`）、functions の tsconfig（ESM 化）、CI 3 本、biome 配置、各 `.gitignore`（`*/node_modules` → ルート集約）。
- 不変: DDL / OpenAPI / ドメインの振る舞い（リファクタであり機能変更なし）。テスト 190 件 green の維持が完了条件。
- リスク: ESM 化に伴う import 拡張子（`.js`）・`__dirname` 不在・`func start` の ESM 起動確認。functions は現状テスト基盤が無いため、最小の smoke を別途用意するか手動確認する。

## 代替案

- **B2（functions 再実装）/ B3（内部 API）**: §背景の表のとおり不採用。
- **`packages/` ディレクトリへ集約**（`packages/backend` 等へ移動）: npm の慣習に沿うが、既存ディレクトリ移動で import / CI パスの差分が大きい。本 ADR は**既存ディレクトリを動かさず `core/` を足す**最小変更を採る。
- **core を dual build（CJS+ESM 両出力）**: functions を CJS のまま維持できるが、ビルド構成が複雑化。functions の ESM 化（v4 が対応済み）の方が単純なため採らない。
- **段階移行せず一括切り出し**: 差分が巨大化しレビュー・ロールバックが困難。段階移行を採る。
