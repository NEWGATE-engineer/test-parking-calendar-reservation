#!/usr/bin/env bash
# ============================================================
# PreToolUse(Bash) フック: git commit 直前に backend の品質を強制する
# ------------------------------------------------------------
# 目的:
#   手で `tsc --noEmit` / `vitest` を叩く運用を自動化・強制し、
#   型エラーやテスト失敗を含んだままのコミットを構造的に防ぐ
#   （ハーネスのフィードバックループ⑤の自動化）。
#
# 仕組み:
#   Claude Code はツール実行直前に、ツール入力を JSON で stdin に渡す。
#   そこから実行コマンド文字列を取り出し、`git commit` のときだけ発火。
#   さらにステージ済み変更に backend/ が含まれる場合に限定して
#   typecheck → test を実行し、失敗したら exit 2 でコミットをブロックする。
#   （exit 2 = PreToolUse で「拒否」。stderr の内容がモデルに戻される）
#
# 注意:
#   この環境には jq が無いため、JSON 解析は node で行う（node は常設）。
# ============================================================
set -euo pipefail

# --- 1) stdin の JSON からツールのコマンド文字列を取り出す -------------------
#     jq の代わりに node で .tool_input.command を抽出（無ければ空文字）。
#     node 不在でも `|| true` で落とさず fail-open する（commit 自体は壊さない）。
payload="$(cat)"
command_str="$(
  printf '%s' "$payload" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.command)||"")}catch{process.stdout.write("")}})' 2>/dev/null
)" || true

# 解析失敗（node 不在・ペイロード形式変更など）に気づけるよう警告を残す。
# fail-open（通過）は維持しつつ、フックが無言で無効化される事故を防ぐ（stderr はモデルに届く）。
if [ -z "$command_str" ] && [ -n "$payload" ]; then
  echo "[pre-commit-quality] ペイロード解析に失敗したため検査をスキップしました（node 不在/形式変更の可能性）" >&2
fi

# --- 2) git commit 以外は対象外（即通過）-----------------------------------
#     `git commit` という並びを含むときだけ後続チェックへ進む。
case "$command_str" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# --- 3) backend/ にステージ済み変更が無ければスキップ ------------------------
#     docs だけのコミット等で重いテストを回さないための絞り込み。
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
staged="$(git -C "$repo_root" diff --cached --name-only 2>/dev/null || true)"
if ! printf '%s\n' "$staged" | grep -q '^backend/'; then
  exit 0
fi

# --- 4) backend の型チェック → テストを実行。失敗ならコミットをブロック ------
cd "$repo_root/backend"

# --silent は付けない: 失敗時に tsc/vitest の診断や npm の「スクリプト未定義」
# エラーを stderr に残し、モデルが原因をトリアージできるようにする。
if ! npm run typecheck; then
  echo "コミット中止: backend の型チェック(tsc --noEmit)に失敗しました。型エラーを解消してください。" >&2
  exit 2
fi

if ! npm run test; then
  echo "コミット中止: backend テスト(vitest)に失敗しました。失敗テストを修正してください。" >&2
  exit 2
fi

# すべて green → コミットを許可
exit 0
