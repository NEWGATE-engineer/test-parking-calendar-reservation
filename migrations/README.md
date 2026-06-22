# migrations

DB スキーマの連番マイグレーション（MVP・ツール無し）。全サービス共通の DB 資産のためリポジトリ直下に置く。

## 構成

| ファイル | 役割 |
| --- | --- |
| `001_init.sql` | 初期スキーマ（テーブル・制約・インデックス）。**実行用の正本** |
| `apply.sh` | 連番 `.sql` を版番号順に、未適用のものだけ適用するスクリプト |
| （適用管理） | `dbo.SchemaMigrations(version, applied_at)` を apply.sh が自動作成し記録 |

設計意図・詳細メモは [docs/database/SQLServerDDL.sql](../docs/database/SQLServerDDL.sql)・[docs/database/ER図.md](../docs/database/ER図.md) を参照（こちらは設計リファレンス）。

## 適用（ローカル Docker）

```bash
docker compose up -d            # parking-sql / azurite を起動
./migrations/apply.sh           # 未適用のマイグレーションを適用（べき等）
```

- 既定でローカル Docker の `parking-sql` コンテナ内 `sqlcmd` に対して実行する。
- DB（`parking`）と `SchemaMigrations` 表が無ければ自動作成する。
- 適用済みの版は再実行時に skip される（べき等）。
- **SA パスワードはスクリプトに持たない**。`SA_PASSWORD` 未指定時はコンテナの `MSSQL_SA_PASSWORD`（`docker-compose.yml` が唯一の情報源）から取得する。
- 同一ホストでの多重実行は `flock` で直列化する。**複数ホストからの並列適用は対象外**（分散 CI で並列実行する場合は専用ツール／`sp_getapplock` を検討）。

環境変数で上書き可: `SQL_CONTAINER`（既定 `parking-sql`）／`SQL_DB`（既定 `parking`・英数字とアンダースコアのみ）／`SA_PASSWORD`。

## 新しいマイグレーションの追加

1. 既存ファイルは編集しない。`002_<説明>.sql`（ゼロ埋め連番）を追加する。
2. 設計を変えたら `docs/database/SQLServerDDL.sql` と `ER図.md` も更新する。
3. `./migrations/apply.sh` で適用。

## メモ

- `sqlcmd` の既定は `QUOTED_IDENTIFIER OFF` のため、PERSISTED 計算列（`Fee.total`）とフィルタ付きインデックスの作成には `-I` が必要（apply.sh で付与済み）。
- 本番（Azure SQL）への適用は、同じ `.sql` を Azure 接続の実行系（CI／ポータル／別ランナー）で流す。接続先の差し替えのみで連番管理の考え方は共通。
