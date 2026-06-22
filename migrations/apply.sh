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
#   SA_PASSWORD   (既定 docker-compose.yml の値)
#
# 例:
#   ./migrations/apply.sh
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${SQL_CONTAINER:-parking-sql}"
DB="${SQL_DB:-parking}"
SA_PASSWORD="${SA_PASSWORD:-Newgate@2026}"
SQLCMD="/opt/mssql-tools18/bin/sqlcmd"

# -C: 自己署名証明書を信頼（mssql-tools18）/ -b: SQL エラーで非0終了
# -I: QUOTED_IDENTIFIER ON（sqlcmd 既定は OFF。PERSISTED 計算列・フィルタ付き索引の作成に必須）
sqlcmd_db()     { docker exec -i "$CONTAINER" "$SQLCMD" -S localhost -U sa -P "$SA_PASSWORD" -C -I -b -d "$DB" "$@"; }
sqlcmd_master() { docker exec -i "$CONTAINER" "$SQLCMD" -S localhost -U sa -P "$SA_PASSWORD" -C -I -b "$@"; }
scalar()        { docker exec -i "$CONTAINER" "$SQLCMD" -S localhost -U sa -P "$SA_PASSWORD" -C -I -d "$DB" -h -1 -W -Q "SET NOCOUNT ON; $1" | tr -d '[:space:]'; }

echo "== ターゲット: container=$CONTAINER db=$DB =="

# 0. DB と適用管理表のブートストラップ
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
  if [ "$(scalar "SELECT COUNT(*) FROM dbo.SchemaMigrations WHERE version=N'$ver';")" = "0" ]; then
    echo "==> applying: $ver"
    sqlcmd_db < "$f"
    sqlcmd_db -Q "INSERT INTO dbo.SchemaMigrations(version) VALUES (N'$ver');"
    echo "    done: $ver"
    applied_any=1
  else
    echo "==> skip (applied): $ver"
  fi
done

[ "$applied_any" = "0" ] && echo "新規適用なし（最新）。"
echo "== 適用済みバージョン =="
docker exec -i "$CONTAINER" "$SQLCMD" -S localhost -U sa -P "$SA_PASSWORD" -C -d "$DB" \
  -Q "SET NOCOUNT ON; SELECT version, applied_at FROM dbo.SchemaMigrations ORDER BY version;"
