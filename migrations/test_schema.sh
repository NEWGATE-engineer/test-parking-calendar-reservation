#!/usr/bin/env bash
# ============================================================
# スキーマ検証テスト（フレームワーク不要）
#   使い捨て DB（既定 parking_test）に migrations を適用し、
#   - 全テーブルが作成されること
#   - 重要制約が違反を拒否すること（CK_Resv_time / CK_Resv_status /
#     UQ_Fee_resv / UQ_Cmd_request）
#   - apply.sh がべき等であること
#   - apply.sh が不正な SQL_DB 名を拒否すること
#   を検証する。終了コード 0=全 PASS / 非0=失敗あり。
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${SQL_CONTAINER:-parking-sql}"
TESTDB="${TEST_DB:-parking_test}"
SQLCMD="/opt/mssql-tools18/bin/sqlcmd"

# テスト用 DB 名も SQL 文字列に展開するためバリデート（apply.sh と一貫）
if ! [[ "$TESTDB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "不正な TEST_DB 名: '$TESTDB'（英数字とアンダースコアのみ可）" >&2; exit 1
fi

SA_PASSWORD="${SA_PASSWORD:-}"
[ -z "$SA_PASSWORD" ] && SA_PASSWORD="$(docker exec "$CONTAINER" printenv MSSQL_SA_PASSWORD 2>/dev/null || true)"
: "${SA_PASSWORD:?SA_PASSWORD を取得できません（$CONTAINER 起動済みか確認）}"
export SQLCMDPASSWORD="$SA_PASSWORD"

db()     { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b -d "$TESTDB" "$@"; }
master() { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b "$@"; }
scal()   { docker exec -i -e SQLCMDPASSWORD "$CONTAINER" "$SQLCMD" -S localhost -U sa -C -I -b -d "$TESTDB" -h -1 -W -Q "SET NOCOUNT ON; $1" | tr -d '[:space:]'; }

pass=0; fail=0
ok() { echo "  PASS: $1"; pass=$((pass+1)); }
ng() { echo "  FAIL: $1" >&2; fail=$((fail+1)); }
expect_ok()   { if db -Q "$1" >/dev/null 2>&1; then ok "$2"; else ng "$2（成功すべきが失敗）"; fi; }
expect_fail() { if db -Q "$1" >/dev/null 2>&1; then ng "$2（違反が拒否されなかった）"; else ok "$2"; fi; }

echo "== セットアップ: $TESTDB を作り直して migrations 適用 =="
master -Q "IF DB_ID('$TESTDB') IS NOT NULL BEGIN ALTER DATABASE [$TESTDB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$TESTDB]; END"
SQL_DB="$TESTDB" SA_PASSWORD="$SA_PASSWORD" SQL_CONTAINER="$CONTAINER" "$DIR/apply.sh" >/dev/null
echo "適用完了"

echo "== T1: テーブル数（11想定） =="
[ "$(scal "SELECT COUNT(*) FROM sys.tables WHERE name<>'SchemaMigrations';")" = "11" ] && ok "11 テーブル生成" || ng "テーブル数が 11 でない"

echo "== T2: べき等性（再適用は全 skip） =="
# 出力を変数に取ってから判定する（apply.sh | grep -q だと grep が先に閉じて
# apply.sh が SIGPIPE 終了し、pipefail で誤って失敗扱いになるため）
reapply_out="$(SQL_DB="$TESTDB" SA_PASSWORD="$SA_PASSWORD" SQL_CONTAINER="$CONTAINER" "$DIR/apply.sh")"
if [[ "$reapply_out" == *"新規適用なし"* ]]; then
  ok "再適用がべき等"
else
  ng "再適用がべき等でない"
fi

echo "== T3: 重要制約が違反を拒否 =="
# UID は bash の読み取り専用変数のため使わない
OWNER='11111111-1111-1111-1111-111111111111'
SPOT='22222222-2222-2222-2222-222222222222'
RESV='33333333-3333-3333-3333-333333333333'
expect_ok   "INSERT INTO [User](id,email,password_hash) VALUES('$OWNER','t@example.com','h');" "親: User 作成"
expect_ok   "INSERT INTO ParkingSpot(id,name) VALUES('$SPOT','A-1');"                          "親: ParkingSpot 作成"
expect_fail "INSERT INTO Reservation(id,user_id,spot_id,start_time,end_time) VALUES(NEWID(),'$OWNER','$SPOT','2026-01-01T10:00:00','2026-01-01T10:00:00');" "CK_Resv_time が end<=start を拒否"
expect_fail "INSERT INTO Reservation(id,user_id,spot_id,start_time,end_time,status) VALUES(NEWID(),'$OWNER','$SPOT','2026-01-01T10:00:00','2026-01-01T11:00:00','unknown');" "CK_Resv_status が不正値を拒否"
expect_ok   "INSERT INTO Reservation(id,user_id,spot_id,start_time,end_time) VALUES('$RESV','$OWNER','$SPOT','2026-01-01T10:00:00','2026-01-01T11:00:00');" "有効な Reservation 作成"
expect_ok   "INSERT INTO Fee(id,reservation_id) VALUES(NEWID(),'$RESV');"                       "Fee 1 件目"
expect_fail "INSERT INTO Fee(id,reservation_id) VALUES(NEWID(),'$RESV');"                       "UQ_Fee_resv が 2 件目を拒否"
expect_ok   "INSERT INTO CommandLog(id,reservation_id,user_id,request_id,command_type) VALUES(NEWID(),'$RESV','$OWNER','req-1','DOWN');" "CommandLog 1 件目"
expect_fail "INSERT INTO CommandLog(id,reservation_id,user_id,request_id,command_type) VALUES(NEWID(),'$RESV','$OWNER','req-1','DOWN');" "UQ_Cmd_request が同一 request_id を拒否"

echo "== T4: apply.sh が不正な SQL_DB 名を拒否 =="
if SQL_DB='bad;name' SA_PASSWORD="$SA_PASSWORD" SQL_CONTAINER="$CONTAINER" "$DIR/apply.sh" >/dev/null 2>&1; then
  ng "不正な SQL_DB 名が通った"
else
  ok "不正な SQL_DB 名を拒否"
fi

echo "== クリーンアップ =="
master -Q "ALTER DATABASE [$TESTDB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$TESTDB];" >/dev/null 2>&1 || true

echo "== 結果: PASS=$pass / FAIL=$fail =="
[ "$fail" = "0" ]
