---
description: 5 つの専門サブエージェントを並列実行して PR を多角的にレビューする
argument-hint: "[baseline-ref]  # 省略=PR 全体レビュー / 指定=その時点からの増分のみ再レビュー"
---

# Pull Request 並列レビュー

このコマンドは現在の Pull Request に対して、5 つの専門観点でレビューを並列実行します。
各サブエージェントは独立したコンテキストで動作し、それぞれの専門領域に集中して指摘します。

## レビューモードの決定（最初に実施）

引数 `$ARGUMENTS` を **baseline ref**（前回レビュー時点の commit SHA / タグ等）として解釈する。
これにより「フルレビュー」と「増分再レビュー」を切り替え、レビューを**収束**させる。

- **引数が空** → **フルレビュー**（従来どおり PR 全体を対象）。
- **引数が非空** → **増分再レビュー（確認モード）**。前回レビュー以降に変わった行だけを対象にする。

> 🚨 **引数の扱い（コマンドインジェクション対策・最重要）**: `$ARGUMENTS` を **bash コマンドに一切渡す前に**、まず LLM 自身が**文字列として**合法パターンに完全一致するか検査する。これが第一の防御。
> 1. **第一防御（LLM による文字種チェック）**: `$ARGUMENTS` が正規表現 `^[0-9a-fA-F]{7,40}$`（= commit SHA。短縮 7〜完全 40 桁の 16 進数のみ）に**完全一致**するか、プロンプト内のテキストとして検査する。
>    - 一致しない場合（空・スペース・`$(`・バッククォート・`;`・`|`・クォート・スラッシュ等を 1 文字でも含む）→ **即フルレビューにフォールバック**し、その旨をサマリに明記する。bash には一切渡さない。
>    - タグ／ブランチ名で渡したい場合も、この場では受け付けない。**SHA に解決してから渡す**運用とする（合法文字を 16 進に限定することで injection 面を完全に閉じる）。
> 2. **第二防御（git による存在チェック）**: 第一防御を通過した SHA のみ、`git rev-parse --verify --quiet "<SHA>"` で実在する commit か確認する。存在しなければフルレビューにフォールバック。
>
> ⚠️ **重要（過去の誤記の訂正）**: bash のダブルクォート内でも `$(...)` ・バッククォートの**コマンド置換は展開される**（クォートが抑止するのは word splitting と glob のみ）。したがって `git rev-parse "$ARGUMENTS"` のように生の引数をクォートして渡しても injection は防げない。**防御は上記 1（16 進限定の事前フィルタ）が本体**であり、git の検証は二次的なものに過ぎない。

増分再レビュー時の対象差分は以下で取得する（`<BASELINE>` は上記 1・2 を通過した **16 進 SHA**。この時点で shell メタ文字を構造的に含み得ないため安全に展開できる）:
- 変更ファイル一覧: `git diff --stat "<BASELINE>...HEAD"`
- 差分本体: `git diff "<BASELINE>...HEAD"`

この差分が空（前回から変更なし）なら、レビューを実施せず「前回レビュー以降に変更なし」とだけ報告する。

## 実行手順

1. **初期コンテキストの収集**（1 メッセージで以下を並列実行）:
   - PR のベースブランチを **`gh pr view`** で動的に取得:
     ```bash
     # claude-code-action の issue_comment トリガーでは $GITHUB_BASE_REF が空のため
     # pull_request イベントの自動注入は利用できない。
     # PR_NUMBER 環境変数（claude-code-action が PR コンテキストで自動セット）を使い、
     # gh pr view 経由でベースブランチ名を取得する。
     # gh コマンドは Actions ランナーに同梱されており、GITHUB_TOKEN も自動注入される。
     if [ -n "${PR_NUMBER:-}" ]; then
       BASE=$(gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo 'develop')
     else
       # フォールバック: 現在の checkout ブランチに紐づく PR を auto-detect
       BASE=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || echo 'develop')
     fi
     echo "Detected base branch: $BASE"
     ```
   - `git diff "origin/${BASE}...HEAD"` で PR の全変更を取得
   - `git log "origin/${BASE}..HEAD" --oneline` で commit 履歴を取得
   - [CLAUDE.md](../../CLAUDE.md) を読み込み、プロジェクト全体のルールを把握
   - `docs/` 配下の主要設計書を必要に応じて参照

2. **5 つのサブエージェントを並列実行**:
   下記の subagent_type を、**1 つのメッセージ内で 5 つの Agent ツール呼び出しとして同時に発行**してください
   （逐次実行ではなく並列実行）。各エージェントには下記の情報を共通で渡します:
   - PR の番号と URL
   - 変更ファイル一覧（git diff の対象）
   - CLAUDE.md の要点（プロジェクト全体ルール）

   並列実行する 5 エージェント:
   1. `code-quality-reviewer`     — クリーンコード・SRP・PSR-12/PEP 8/TS 規約
   2. `performance-reviewer`      — ボトルネック・複雑度・Bedrock コスト・S3 Vectors 効率
   3. `test-coverage-reviewer`    — テスト不足・欠落シナリオ・モック設計の妥当性
   4. `documentation-accuracy-reviewer` — CLAUDE.md / 設計書 / コードコメント / 行番号参照の整合
   5. `security-code-reviewer`    — OWASP / IAM 最小権限 / .env 漏洩 / Mini Shai-Hulud 凍結ルール

   **増分再レビュー時（baseline 引数が第一防御・第二防御を通過した場合）は、各エージェントへのプロンプト冒頭で必ず `re-review` と宣言し、
   「レビューモードの決定」で計算した増分差分だけを対象として渡すこと**。各エージェントは渡された差分の範囲外を見ない。
   **フルレビュー時（引数が空、または検証失敗でフォールバックした場合）は `re-review` を宣言せず**、従来どおり PR 全体差分を渡す。
   フォールバック時に誤って `re-review` を付けると、各エージェントが新規 Nit を抑制してしまい初回レビューが甘くなるため、ラベルの有無を明確に分けること。

   各エージェントは自分の観点で気付いた問題を **`mcp__github_inline_comment__create_inline_comment`** で行単位の指摘として PR に投稿してください。各エージェントの `.md` 先頭にある **「出力の判定規約」**（重大度ゲート・APPROVE 許可・再レビュー時は新規 Nit / Minor を出さない）を厳守させること。問題が無ければインラインコメントを 1 件も出さず「問題なし」を返すのが正しい挙動です。

3. **全エージェント完了後のサマリ投稿**:
   - 5 エージェントの結果を集約し、**`mcp__github_comment__update_claude_comment`** で
     Claude が自動投稿した既存コメント（タスクリスト表示用のもの）をサマリ内容で更新する。
     新規 issue コメントを別途追加せず、既存 Claude コメントの末尾にサマリを追記する形が
     既存運用と整合する（過去 PR レビューもこの方式）。
   - フォーマット:
     ```
     ## 並列レビュー結果サマリ（モード: フルレビュー / 増分再レビュー[baseline=<SHA>]）

     | 観点 | 必須（Critical/High） | 畳み（Nit） | 良い点 |
     | --- | --- | --- | --- |
     | code-quality | N 件 | N 件 | … |
     | performance | … | … | … |
     | test-coverage | … | … | … |
     | documentation | … | … | … |
     | security | … | … | … |

     ※ security 観点は語彙が異なる: **Critical / Important が「必須」列**、**Minor が「畳み」列**に対応する。

     ### 判定
     - ✅ **GO（マージ可）**: 投稿された Critical / High（security は Critical / Important）が **0 件**
     - ❌ **NO-GO**: 1 件以上残る（内訳を列挙）
     - ℹ️ Nit / Minor は判定に影響させない（参考情報として <details> に畳む）

     ### 総評
     ＜判定の根拠を 2〜3 行で。GO なら「マージ可能」と明記＞
     ```
   - **判定基準（ハード）**: 投稿対象の Critical / High（security は Critical / Important）が 0 件なら GO。
     Nit / Minor は GO/NO-GO に影響させない。無理に指摘を増やして NO-GO にしないこと。

## 注意事項

- 各サブエージェントには CLAUDE.md の要点を渡すこと（各エージェント内で再読み込みすると非効率）
- 同じ指摘を複数エージェントが投稿しないよう、観点を厳密に分離する（重複した場合はサマリで整理）
- インラインコメントは **行に紐付くもの** に限定する。「PR 全体に関わる総評」はサマリコメントへ
- 不要に冗長な指摘や憶測ベースの指摘は避ける（根拠 = 「この行のこの挙動が問題」）
- レビュー対象は Step 1 で取得した `${BASE}` からの差分のみ（`gh pr view` で PR のベースブランチを動的取得済み）
- **収束運用**: 初回は `/review-pr`（フル）、修正を push した後の再レビューは `/review-pr <前回レビュー時の HEAD SHA>` のように baseline を渡す。これによりラウンド N は「N-1 以降に変わった行」だけを見るので、レビューは原理的に収束する。前回 SHA は前回サマリ／コミット履歴から人間が控える（手動トリガー運用のため台帳・スクリプトは不要）
