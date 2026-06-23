# CLAUDE.md

このリポジトリで作業する際の共通ルールと文脈。全エージェント・全ワークフローがまず参照する。

## プロジェクト概要

駐車場予約システム（仮）。利用者がアプリから駐車区画を事前予約し、予約に基づいて AUTOSTAND（ロック板）を IoT 経由で制御して入出庫する。空満表示・料金計算・利用履歴を提供。現状は**環境構築済み・ロジック実装はこれから**。

詳細設計は [docs/](docs/) に集約。最重要は [要件定義書 v5](docs/requirements/) と [API 仕様](docs/api/)・[ER図/DDL](docs/database/)。

## 技術スタック

| 層 | 技術 | 配置 |
| --- | --- | --- |
| モバイル | Flutter / Dart（Web 中心で開発） | [mobile/](mobile/) |
| バックエンド API | TypeScript / Node.js（Express） | [backend/](backend/) → Azure App Service |
| 非同期・イベント | Azure Functions（TypeScript） | [functions/](functions/) |
| デバイス疑似 | Node.js（`azure-iot-device`） | [device-sim/](device-sim/) |
| DB | Azure SQL Database（serverless） | ローカルは Docker SQL Server 2025 |
| ストレージ | Azure Blob | ローカルは Azurite |
| デバイス連携 | Azure IoT Hub | — |
| 監視 | Application Insights / Log Analytics | — |

## 開発コマンド

```bash
# ローカル基盤（SQL / Azurite）
docker compose up -d
docker compose ps

# backend（backend/ で）
npx tsc                 # 型チェック / ビルド

# functions（functions/ で）
npm start               # prestart で clean+build 後 func start

# mobile（mobile/ で）
flutter run -d web-server --web-port 5000 --dart-define=API_BASE_URL=http://localhost:3000
```

日常開発はローカル Docker で完結させ、Azure は統合テスト／デプロイ時のみ使う（無料枠節約）。詳細は [docs/setup/](docs/setup/)。

## ドメインの重要ルール（実装時に必ず守る）

- **状態遷移はすべて「現在状態を WHERE に含めた条件付き UPDATE」**で行う。更新0件＝競合とみなす。タイマー確定とユーザー操作の競合や二重処理を防ぐ（予約・refresh トークンなど全所で同じ原則）。
- **時刻はすべて UTC で保存**し、表示時に JST 変換。
- **SQL はパラメータ化クエリ**（SQL インジェクション防止）。重複・近接予約の判定は serializable トランザクション内で競合チェックしてから INSERT（範囲排他制約は Azure SQL に無いため）。
- **DOWN 指示は冪等**。`CommandLog.request_id`（UNIQUE）で重複指示を吸収。1通信操作ごとに新規 request_id を採番、試行ごとに1行。
- **ノーショー判定は occupancy ではなく UsageRecord（入庫記録）の有無**で行う。在車判定も同様に open な UsageRecord（exit_time 未記録）の有無で行い、occupancy は表示/availability/物理占有事前判定に用途を限定。
- **完了確定（onExitDetected / autoComplete）は条件付き UPDATE が1件成功したときだけ Fee を INSERT**。`UQ_Fee_resv` 違反を避ける。
- **入出庫の UP はデバイス側（§5.3 安全インターロック）、クラウドは記録のみ**で予約状態は変えない。
- **予約の変更・キャンセルは `reserved` のみ可**（条件付き UPDATE で 0 件なら 409）。
- 認証は**自前 JWT**方針（access 15分 / refresh 14日、refresh は SHA-256 ソルト無で保存、`family_id` で系統失効）。MVP は access の denylist を持たない。詳細は [docs/architecture/](docs/architecture/) の認証設計。

## コーディング規約（コメント）

- 実装コードには**初学者にも分かる詳しいコメント**を書く。
- 公開する関数・メソッド・クラス・型・モジュールに **TSDoc（日本語可）** を付け、`@param` / `@returns` / `@throws` を明記する。HTTP ハンドラ・サービス層は「どのエラー（HTTP status / code）を投げるか」を `@throws` に書く。
- **主要な処理ステップ**には「何を・なぜ」の行コメントを添える（設計意図：条件付き UPDATE・TOCTOU 回避・列挙対策・冪等 など）。ただし自明な行には書かずノイズにしない。
- 変数名・DB カラム名は英語、コメントは日本語で可。

## やってはいけないこと

- `.env` / `functions/local.settings.json` をコミットしない（`.gitignore` 済み・接続文字列やシークレットを含む）。
- パスワードを平文保存しない（bcrypt）。署名鍵はリポジトリに置かない（App Settings / Key Vault）。
- 状態遷移を「読んでから無条件 UPDATE」で書かない（必ず現在状態を WHERE に）。
- 設計を変更したら docs/ 側も更新する（実装先行で設計書が古くなるのを避ける）。

## 未確定事項（要件定義 §12）

料金体系・キャンセルポリシー・ノーショー課金・バッファ時間 B（仮15分）・入庫待ちタイムアウト（仮5分）・デバイス健全性閾値・認証方式の最終選定などが未確定。これらに依存する実装では仮値であることを明示し、確定が必要なら確認する。

## ドキュメント

- 目次: [docs/README.md](docs/README.md)
- ルート概要: [README.md](README.md)
