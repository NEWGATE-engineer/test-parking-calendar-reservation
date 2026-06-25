---
name: new-endpoint
description: backend に新しい HTTP エンドポイント（または機能モジュール）を追加するときに使う。本プロジェクトのレイヤ構成（validation → router → service → repository、必要なら純粋ロジック）に沿って雛形を作り、認証・エラーマッピング・TSDoc・テスト（mock 単体＋supertest HTTP）・OpenAPI 同期まで漏れなく進める。POST/PUT/DELETE/GET の追加や新規リソース実装で起動する。
---

# new-endpoint — backend エンドポイント追加

新しい API を本プロジェクトの規約どおりに積むためのチェックリスト。
**参照する正本（コピペ元）は [backend/src/spots/](../../../backend/src/spots/) モジュール**（レイヤ構成の手本）。

## レイヤ構成（spots を手本に）
| ファイル | 役割 | 手本 |
| --- | --- | --- |
| `<feature>/validation.ts` | 入力（query/body/param）を検証し型付き値へ。失敗は `AppError(422, 'validation_error')` | `spots/validation.ts` |
| `<feature>/repository.ts` | DB アクセス抽象。`interface XxxRepository` ＋ `class SqlXxxRepository`。**パラメータ化クエリ必須** | `spots/repository.ts` |
| `<feature>/service.ts` | 業務ロジック。状態遷移は**条件付き UPDATE（現在状態を WHERE に）／0件=競合**。ドメイン違反は `AppError(409, ...)` 等 | `spots/service.ts` |
| `<feature>/router.ts` | `createXxxRouter(repo)`。`requireAuth` ＋ `asyncHandler` でラップ | `spots/router.ts` |
| `<feature>/<pure>.ts`（任意） | 純粋ロジック（時間計算・料金等）を副作用なしで分離（テストしやすさ） | `spots/availability.ts` |

共通基盤: [backend/src/http/](../../../backend/src/http/) の `AppError` / `errorHandler` / `requireAuth`（＋`getUserId`）/ `asyncHandler`。

## 手順
1. **設計確認**: docs/api の OpenAPI と docs/architecture を読み、パス・リクエスト/レスポンス・エラー（status/code）・認可（他人の資源は 404 か 403 か等）を把握。CLAUDE.md のドメイン規約を確認。
2. **validation.ts**: 入力をパースする純関数。境界（欠落・型不正・範囲）を 422 に。`spots/validation.ts` の `parseAvailabilityQuery` を手本に。
3. **repository.ts**: `interface` を先に定義（テストで mock するため）。SQL は必ずパラメータ化。状態遷移系は「現在状態を WHERE に含めた条件付き UPDATE」を返し、`rowsAffected` で競合判定。
4. **service.ts**: ビジネスルール。投げるエラーは `@throws` に HTTP status/code を明記。競合・近接・重複は serializable トランザクション内でチェックしてから INSERT（範囲排他制約は Azure SQL に無い）。
5. **router.ts**: `requireAuth` → `asyncHandler(async (req,res)=>{ ... })`。`getUserId(req)` で本人特定。バリデーション→サービス呼び出し→ステータス＆ボディ返却。
6. **index.ts に配線**: `app.use('/<path>', createXxxRouter(repo))`。
7. **コメント/TSDoc**: 公開関数・クラス・型に日本語 TSDoc（`@param`/`@returns`/`@throws`）。HTTP/サービス層は投げるエラーを `@throws` に。主要ステップに「何を・なぜ」の行コメント（条件付き UPDATE・TOCTOU 回避・冪等など）。自明な行には書かない。
8. **テスト**（手本: `backend/test/spots.*.test.ts`、`backend/test/helpers/mockSpotsRepo.ts`）:
   - 純粋ロジックがあれば `<pure>.test.ts`（境界値中心）。
   - `<feature>.service.test.ts`: mock repository で分岐（成功・各エラー・競合0件）。
   - `<feature>.http.test.ts`: supertest で 200/401/404/409/422 等。`signAccessToken` で Bearer を用意。
9. **OpenAPI 同期**: [docs/api](../../../docs/api) の YAML に新パス・スキーマ・responses（エラー code 含む）を追記。設計を変えたら docs も更新（CLAUDE.md ルール）。

## コミット前
- `npm --prefix backend run typecheck` と `npm --prefix backend test` が green。
- commit 時に pre-commit-quality フックが backend の型/テストを自動実行し、失敗ならコミットを止める。

## 完了の定義
- [ ] validation / repository / service / router（必要なら純粋ロジック）を spots パターンで実装
- [ ] index.ts に配線
- [ ] 公開APIに TSDoc、主要ステップに行コメント
- [ ] mock 単体 ＋ supertest HTTP テスト（成功・認証・各エラー・競合）
- [ ] OpenAPI / 関連 docs を同期
- [ ] typecheck・test green
