#!/usr/bin/env bash
# PostToolUse フック: Claude が Write/Edit でファイルを書いた直後に Biome を走らせる。
#
# ねらい（Qiita/Morpho 知見の「PostToolUse 自動 lint」層）:
#   commit 前 Hook や CI より "前倒し" で、ファイルを書いたその場で整形・lint を効かせ、
#   Claude が即座に自己修正できるようにする。整形や安全な修正は黙って適用し、
#   手で直すべき lint 違反だけを exit 2 で stderr に返してモデルに気づかせる。
#
# 射程の注意: これは Claude Code が Write/Edit したときだけ発火する "Claude 専用ガードレール"。
#   人間/IDE の編集は捕まえない。誰の変更でも確実に効く土台は ci.yml の `npm run lint` が担う。
set -uo pipefail

# Claude Code はツール入力を JSON で stdin に渡す。file_path を取り出す。
# （jq が無い環境が多いので node で抽出するのが移植性◎。pre-commit-quality.sh と同方針）
payload="$(cat)"
file_path="$(printf '%s' "$payload" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch{process.stdout.write("")}})')"

# 壊れた入力なら何もしない（fail-open: フックでツール実行自体は壊さない）。
[ -n "$file_path" ] || exit 0

# 対象は Biome の includes（ルート biome.json）と一致する .ts のみ:
# core/src・functions/src・backend/src・backend/test 配下（サブディレクトリ含む）。
# それ以外（docs・mobile・各パッケージ直下の設定ファイルなど）は対象外なのでスキップ。
# bash の case グロブ `*` は `/` をまたがないため core/src/reservations/service.ts の
# ようなサブディレクトリにマッチしない。biome.json の includes は再帰グロブ
# `core/src/**/*.ts` なので、こちらも grep -E の再帰パターンで揃える。
echo "$file_path" | grep -qE '/(core|functions)/src/.*\.ts$|/backend/(src|test)/.*\.ts$' || exit 0

root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# Biome バイナリを直接解決する。npm workspaces 化後は `npx biome` が cwd の
# ローカル bin を見失い、レジストリの別パッケージ（"biome" 0.3.3）を取りに行って
# 失敗することがあるため、hoist 済みの node_modules/.bin を直接参照する。
# 見つからなければ fail-open（フックでツール実行自体は壊さない）。
biome_bin="$root/node_modules/.bin/biome"
[ -x "$biome_bin" ] || exit 0
# biome.json はリポジトリルートにあるため、ルートで実行して includes 設定を効かせる。
cd "$root" || exit 0

# 単一ファイルだけを対象に Biome を実行（速い）。--write で整形・安全な修正・import 整列を
# その場で適用する。--error-on-warnings で warning（未使用変数など）も非0扱いにし、
# 修正で解消できない違反が残ると Biome は非0で終了する → exit 2 でモデルに返す。
if ! output="$("$biome_bin" check --write --error-on-warnings "$file_path" 2>&1)"; then
  # 残った違反をモデルに返す。exit 2 = PostToolUse のブロッキングフィードバック（stderr がモデルへ）。
  printf '%s\n' "$output" >&2
  echo "Biome の lint 違反が残っています。上記を修正してください（整形・安全な修正は自動適用済み）。" >&2
  exit 2
fi
exit 0
