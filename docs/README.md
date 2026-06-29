# docs

設計関連ドキュメントを置くディレクトリです。

| ディレクトリ | 用途 | 主なファイル |
| --- | --- | --- |
| `requirements/` | 要件定義・機能仕様 | 要件定義書_v5.md |
| `architecture/` | システム構成・全体設計 | 認証設計（自前 JWT）, バックエンド処理一覧, Azure 構成・デプロイ設計, 残りのフロー図 |
| `architecture/sequences/` | シーケンス図 | コアフロー, DOWN 失敗フロー（F4-6）, 超過フロー |
| `api/` | API 仕様 | API 設計書（OpenAPI 3.0.3）.yaml |
| `database/` | DB スキーマ・データモデル | ER図.md, SQLServerDDL.sql |
| `ui/` | 画面設計・UI/UX | 画面設計・画面遷移図.md |
| `setup/` | 環境構築・セットアップ手順 | 環境構築手順書.md |
| `decisions/` | 設計判断の記録 (ADR) | 0001-reservation-create-concurrency.md, 0002-reservation-update-cancel-list.md, 0003-gate-down-idempotency.md, 0004-monorepo-core-extraction.md |

そのほか:

- [学習ガイド.md](学習ガイド.md) — TypeScript / Flutter / 最先端 AI 開発を本プロジェクトで学ぶためのガイド
