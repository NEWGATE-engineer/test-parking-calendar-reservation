#!/usr/bin/env bash
# ============================================================
# 連番マイグレーション適用スクリプト（MVP・ツール無し）
#   migrations/NNN_*.sql を版番号順に、未適用のものだけ適用する。
#   適用済み版は dbo.SchemaMigrations(version, applied_at) で管理。
#
# 既定はローカル Docker（parking-sql コンテナ内 sqlcmd）に対して実行。
# 環境変数で上書き可:
#   SQL_CONTAINER (既定 parking-sql)
#   SQL_DB        (既定 parking)
#   SA_PASSWORD   (未指定ならコンテナの MSSQL_SA_PASSWORD から取得)
#
# 例:
#   ./migrations/apply.sh
#
# 並行性: 同一ホストの多重実行は flock で直列化する。複数ホストからの
#   並列適用（分散 CI 等）は本スクリプトの対象外（その場合は専用の
#   マイグレーションツール／sp_getapplock を検討）。
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${SQL_CONTAINER:-parking-sql}"
DB="${SQL_DB:-parking}"

# SQL 識別子・docker 引数に展開する値は事前にバリデート（SQLi/誤注入 防止・CLAUDE.md 原則）
if ! [[ "$DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "不正な SQL_DB 名: '$DB'（英数字とアンダースコアのみ可）" >&2; exit 1
fi
if ! [[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "不正な SQL_CONTAINER 名: '$CONTAINER'" >&2; exit 1
fi

# パスワードはリポジトリにハードコードしない。未指定ならコンテナの
# 環境変数（docker-compose.yml が唯一の情報源）から取得する。
SA_PASSWORD="${SA_PASSWORD:-}"
if [ -z "$SA_PASSWORD" ]; then
  SA_PASSWORD="$(docker exec "$CONTAINER" printenv MSSQL_SA_PASSWORD 2>/dev/null || true)"
fi
: "${SA_PASSWORD:?SA_PASSWORD を設定するか、$CONTAINER を起動して MSSQL_SA_PASSWORD を取得できる状態にしてください}"

# パスワードはコマンドライン引数(-P)に置かず、SQLCMDPASSWORD 環境変数で渡す。
# docker exec には -e SQLCMDPASSWORD（名前のみ）を渡し、値はクライアント環境から
# 継承させることで、ホストの ps（argv）に値が露出しないようにする。
export SQLCMDPASSWORD="$SA_PASSWORD"

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"

# 同一ホストでの多重実行を直列化（冪等チェックと DDL 適用の競合防止）
exec 9>"${TMPDIR:-/tmp}/parking-migrate.lock"
flock 9

# -C: 自己署名証明書を信頼（mssql-tools18）/ -b: SQL エラーで非0終了
# -I: QUOTED_IDENTIFIER ON（sqlcmd 既定は OFF。PERSISTED 計算列・フィルタ付き索引の作成に必須）
# -e SQLCMDPASSWORD: パスワードを名前渡し（値は argv に出ない）。sqlcmd は同変数を自動使用
sqlcmd_db()     { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b -d "$DB" "$@"; }
sqlcmd_master() { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b "$@"; }
query_scalar()  { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b -d "$DB" -h -1 -W -Q "SET NOCOUNT ON; $1" | tr -d '[:space:]'; }

echo "== ターゲット: container=$CONTAINER db=$DB =="

# 0. DB と適用管理表のブートストラップ（$DB はバリデート済み）
sqlcmd_master -Q "IF DB_ID('$DB') IS NULL CREATE DATABASE [$DB];"
sqlcmd_db <<'SQL'
IF OBJECT_ID('dbo.SchemaMigrations','U') IS NULL
CREATE TABLE dbo.SchemaMigrations (
    version    NVARCHAR(100) NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
    applied_at DATETIME2(3)  NOT NULL CONSTRAINT DF_SchemaMig_at DEFAULT SYSUTCDATETIME()
);
SQL

# 1. 連番ファイルを順に適用（未適用のみ）
shopt -s nullglob
applied_any=0
for f in "$DIR"/[0-9]*.sql; do
  ver="$(basename "$f" .sql)"
  # ファイル名は SQL 文字列に展開するため事前バリデート（SQLi 防止）
  if ! [[ "$ver" =~ ^[0-9A-Za-z_-]+$ ]]; then
    echo "不正なマイグレーションファイル名: '$ver'" >&2; exit 1
  fi
  # $() を if 条件に直接書くと set -e が伝播しないため、変数に代入してから比較
  applied_count="$(query_scalar "SELECT COUNT(*) FROM dbo.SchemaMigrations WHERE version=N'$ver';")"
  if [ "$applied_count" = "0" ]; then
    echo "==> applying: $ver"
    # DDL 適用と版記録を「単一トランザクション」で原子適用する。
    # XACT_ABORT ON によりエラー時は全ロールバックされ、部分適用や
    # 「適用済みだが版未記録」（途中中断時）の不整合が起こらない。
    # トランザクションは GO バッチを跨げないため、GO を除去して単一バッチ化する
    # （マイグレーションは単一バッチ前提。CREATE PROCEDURE 等のバッチ分割必須文は使わない）。
    # $ver は ^[0-9A-Za-z_-]+$ でバリデート済みのため SQL 文字列へ安全に展開できる。
    {
      echo "SET XACT_ABORT ON;"
      echo "BEGIN TRANSACTION;"
      grep -viE '^[[:space:]]*GO[[:space:]]*$' "$f"
      echo "INSERT INTO dbo.SchemaMigrations(version) SELECT N'$ver' WHERE NOT EXISTS (SELECT 1 FROM dbo.SchemaMigrations WHERE version=N'$ver');"
      echo "COMMIT TRANSACTION;"
    } | sqlcmd_db
    echo "    done: $ver"
    applied_any=1
  else
    echo "==> skip (applied): $ver"
  fi
done

[ "$applied_any" = "0" ] && echo "新規適用なし（最新）。"
echo "== 適用済みバージョン =="
sqlcmd_db -Q "SET NOCOUNT ON; SELECT version, applied_at FROM dbo.SchemaMigrations ORDER BY version;"
