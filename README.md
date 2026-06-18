# 駐車場予約システム（仮）

利用者がアプリから駐車区画を事前予約し、予約に基づいて AUTOSTAND（ロック板）を制御して入出庫するシステム。空満表示・料金計算・利用履歴管理を提供する。

- フロントエンド: Flutter / Dart（Web 中心で開発）
- バックエンド API: TypeScript（Node.js）/ Azure App Service
- 非同期・イベント処理: Azure Functions（IoT / タイマー / 通知）
- DB: Azure SQL Database（サーバーレス）
- デバイス連携: Azure IoT Hub ＋ 疑似 AUTOSTAND
- 監視: Application Insights / Log Analytics

現状は環境構築まで完了。アプリのロジック実装はこれから。未決事項は要件定義 §12 を参照。

## リポジトリ構成

| ディレクトリ | 内容 |
| --- | --- |
| [backend/](backend/) | TypeScript REST API（App Service へデプロイ） |
| [functions/](functions/) | Azure Functions（IoT メッセージ・タイマー走査・通知） |
| [device-sim/](device-sim/) | 疑似 AUTOSTAND（`azure-iot-device` / Node.js） |
| [mobile/](mobile/) | Flutter アプリ（Web 中心） |
| [docs/](docs/) | 要件定義・設計ドキュメント一式 |
| [docker-compose.yml](docker-compose.yml) | ローカル SQL Server / Azurite |

## ローカル起動（最短手順）

WSL2 + Docker 前提。詳細・前提ツールの導入は [docs/setup/](docs/setup/) を参照。

```bash
# 1. ローカル SQL / Storage エミュレータを起動
docker compose up -d
docker compose ps        # sql / azurite が running

# 2. バックエンド API（backend/ で）
#    .env の SQL_CONNECTION_STRING はローカル Docker SQL を指す

# 3. Functions（functions/ で）
func start

# 4. Flutter アプリ（mobile/ で）
flutter run -d web-server --web-port 5000 --dart-define=API_BASE_URL=http://localhost:3000
```

> 接続文字列・シークレットは `.env` / `local.settings.json` に置き、コミットしない（`.gitignore` 済み）。

## 設計ドキュメント

詳細は [docs/](docs/) に集約。目次は [docs/README.md](docs/README.md)。

| カテゴリ | 場所 |
| --- | --- |
| 要件定義書 v5 | [docs/requirements/](docs/requirements/) |
| システム構成・認証・処理一覧・フロー図 | [docs/architecture/](docs/architecture/) |
| シーケンス図 | [docs/architecture/sequences/](docs/architecture/sequences/) |
| API 仕様（OpenAPI 3.0.3） | [docs/api/](docs/api/) |
| ER 図・DDL | [docs/database/](docs/database/) |
| 画面設計・画面遷移 | [docs/ui/](docs/ui/) |
| 環境構築手順書 | [docs/setup/](docs/setup/) |
| 設計判断記録（ADR） | [docs/decisions/](docs/decisions/) |

## ステータス

- [x] 環境構築（WSL2 + Docker、Azure リソース一式）
- [ ] DB スキーマ適用（連番マイグレーション）
- [ ] バックエンド API 実装（OpenAPI 準拠）
- [ ] Functions 実装（ライフサイクル走査・IoT 連携）
- [ ] Flutter アプリ実装
- [ ] Azure へのデプロイ

未決事項（料金体系・キャンセルポリシー・ノーショー課金・認証方式の最終選定など）は要件定義書 §12 を参照。
