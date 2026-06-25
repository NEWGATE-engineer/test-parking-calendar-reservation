---
name: add-migration
description: DB スキーマの連番マイグレーションを追加するときに使う。新しい NNN_*.sql の採番・雛形作成から、docs/database（DDL・ER図）の同期、apply.sh での適用、test_schema.sh / db-test CI までの手順を、本プロジェクトの規約どおりに進める。テーブル追加・列追加・インデックス追加・制約変更など DB を変更する作業で起動する。
---

# add-migration — 連番マイグレーション追加

DB スキーマを変更するときの定型手順。正本は [migrations/README.md](../../../migrations/README.md)。
この Skill はそれを「迷わず実行する」ためのチェックリスト。

## 0. 事前確認（必ず）
- CLAUDE.md の DB 規約を守る: **時刻は UTC で保存**／**パラメータ化クエリ**／状態遷移は条件付き UPDATE。
- 既存ファイルは**絶対に編集しない**（適用済みの版は不変）。変更は必ず新しい連番で積む。

## 1. 次の連番を決める
```bash
ls -1 migrations/[0-9]*.sql | sort | tail -1   # 直近の版を確認
```
- **3桁ゼロ埋め** `NNN_<説明>.sql`（例 `003_add_xxx.sql`）。桁を揃えないと apply.sh の辞書順適用が狂う。
- `CREATE PROCEDURE/VIEW/FUNCTION/TRIGGER` を含むなら、それらは「バッチ先頭文」制約があるため **GO で分割せず単独ファイル**にする。

## 2. SQL ファイルを書く
- 先頭に「何を・なぜ」を説明するブロックコメント（既存 `002_availability_index.sql` の体裁に合わせる）。
- DDL は冪等に書けるなら冪等に（`IF NOT EXISTS` 等）。ただし原子適用は apply.sh が `XACT_ABORT ON`＋トランザクションで担保するので、版自体の二重適用は SchemaMigrations で防がれる。
- 設計リファレンス（`docs/database/SQLServerDDL.sql`）の該当箇所と**命名・型・制約を一致**させる。

## 3. 設計ドキュメントを同期（忘れやすい）
設計を変えたら必ず両方を更新する（実装先行で設計書が古くなるのを防ぐ・CLAUDE.md ルール）:
- [docs/database/SQLServerDDL.sql](../../../docs/database/SQLServerDDL.sql) — 該当テーブル/インデックス定義
- [docs/database/ER図.md](../../../docs/database/ER図.md) — 関連・カラムの図
- 該当すれば [docs/api](../../../docs/api) や設計書も。

## 4. ローカル適用・テスト
```bash
docker compose up -d           # parking-sql / azurite
./migrations/apply.sh          # 未適用のみ適用（冪等）。SA パスワードはスクリプトに持たない
./migrations/test_schema.sh    # 別DB(parking_test)で制約・冪等・不正入力を検証
```
- `apply.sh` が `dbo.SchemaMigrations` に版を記録。再実行で skip されれば冪等OK。
- 失敗時は SQL を直し、**新ファイルを編集**（まだ未コミットなら同ファイル修正で可）。適用済みコミット後に直す場合は次の連番で打ち消す。

## 5. コミット前
- `migrations/**` 変更は PR で [.github/workflows/db-test.yml](../../../.github/workflows/db-test.yml) が CI 実行する。ローカルで test_schema が green なのを確認してからコミット。
- backend のコードも触ったなら、commit 時に pre-commit-quality フックが backend の型/テストを自動実行する。

## 完了の定義
- [ ] 新 `NNN_*.sql` を追加（既存は不変）
- [ ] DDL・ER図（必要なら他 docs）を同期
- [ ] apply.sh 適用＋ test_schema.sh が green
- [ ] 冪等（再適用で skip）を確認
