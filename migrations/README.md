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

## テスト

```bash
./migrations/test_schema.sh     # 別DB(parking_test)に適用し、制約・べき等・不正入力を検証
```

CI でも PR が `migrations/**` を変更すると [.github/workflows/db-test.yml](../.github/workflows/db-test.yml) が `docker compose up` → `apply.sh` → `test_schema.sh` を回す（リグレッション検知）。

## 新しいマイグレーションの追加

1. 既存ファイルは編集しない。**3桁ゼロ埋め連番** `NNN_<説明>.sql`（例 `002_add_xxx.sql`）を追加する。`apply.sh` のグロブ `[0-9]*.sql` は辞書順で適用するため、桁数を揃えないと適用順が狂う。
2. 設計を変えたら `docs/database/SQLServerDDL.sql` と `ER図.md` も更新する。
3. `./migrations/apply.sh` で適用。

## メモ

- `sqlcmd` の既定は `QUOTED_IDENTIFIER OFF` のため、PERSISTED 計算列（`Fee.total`）とフィルタ付きインデックスの作成には `-I` が必要（apply.sh で付与済み）。
- パスワードは `SQLCMDPASSWORD` 環境変数で渡し、コマンドライン（argv）には載せない（`ps` への露出防止）。
- 本番（Azure SQL）への適用は、同じ `.sql` を Azure 接続の実行系（CI／ポータル／別ランナー）で流す。接続先の差し替えのみで連番管理の考え方は共通。
- **既知の限界（MVP）**: 各マイグレーションの「DDL 適用」と「版記録」はトランザクションで一体化していない。適用途中に強制中断（SIGINT 等）すると部分適用が残り、再実行で `CREATE TABLE` 重複エラーになりうる。その場合は対象 DB を作り直す（dev）。完全な原子適用は将来の課題（専用ツール導入時に解消）。
