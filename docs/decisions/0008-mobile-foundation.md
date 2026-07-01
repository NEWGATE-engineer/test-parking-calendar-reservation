# ADR 0008: モバイル（Flutter）基盤と状態管理

- ステータス: 承認
- 日付: 2026-07-01
- 関連: [画面設計・画面遷移図](../ui/駐車場予約システム%20画面設計・画面遷移図.md) / [API 設計書（OpenAPI）](../api/API%20設計書（OpenAPI%203.0.3）.yaml) / 認証設計（自前 JWT）/ [CLAUDE.md](../../CLAUDE.md)

## 背景

バックエンド（認証・区画・予約 CRUD・gate-down・IoT・タイマー）が揃い、Flutter アプリを実装する段階に入った。`mobile/` は `flutter create` 直後の雛形（依存は cupertino_icons のみ）。画面設計（Login/Register/Home/Reserve/Detail/MyPage の6画面）と OpenAPI 契約に沿って、まず**基盤と認証**を敷く。

## 決定

### 1. スライスは縦切りで積む（M1〜M4）

1 PR に全画面は載せない。動く縦スライスで段階的に積む:

- **M1 基盤＋認証**（本 PR）: API クライアント（401→refresh）・トークン保管・ルーティング/認証ゲート・Login/Register・GET /spots のホーム。
- **M2 予約作成**: ホーム満空＋availability → カレンダー予約作成。
- **M3 予約詳細**: gate-down＋入庫待ちポーリング・変更・キャンセル・利用終了・料金。
- **M4 マイページ＋仕上げ**: 履歴一覧・プルリフレッシュ・エラーUX 統一。

### 2. スタック: Riverpod / dio / go_router / flutter_secure_storage

- **状態管理 = Riverpod**（`flutter_riverpod` 3.x）。DI と非同期状態（`AsyncValue` の loading/error/data）を型で扱え、`ProviderContainer` で DB/API なしにユニットテストできる。
- **HTTP = dio**。401 を捕まえて refresh→リトライする**インターセプタ**が書きやすく、access 15分/refresh の自動更新（認証設計 §2/§3）に合う。
- **ルーティング = go_router**。認証状態に応じた宣言的リダイレクト（未認証→/login、認証済→/）に向く。Riverpod の状態変化を `refreshListenable` に橋渡しして redirect を再評価する。
- **トークン保管 = flutter_secure_storage**。モバイルは Keychain/Keystore、Web は WebCrypto+localStorage。開発は Web 中心（CLAUDE.md）なので Web 対応が必須。

### 3. 認証フロー（自己修復）

- 起動時は `AuthStatus.unknown` でスプラッシュ表示。保管リフレッシュトークンの有無で `authenticated`/`unauthenticated` に確定（有効性は検証しない）。
- 保護 API が 401 → インターセプタが refresh を試行 → 成功で元リクエストを1回だけ再試行、失敗（失効）でトークン破棄＋未認証へ → ルーターが /login へ誘導。起動時に古いトークンでも最初の 401 で自己修復する。
- ログインは失敗時に `ApiException`（OpenAPI Error の code/message/retryable を正規化）を投げ、画面が文言表示。状態（AuthStatus）は**ルーティング判断にのみ**使い、画面ごとの送信中状態は各画面が持つ（関心の分離）。

### 4. 検証は flutter analyze＋flutter test（mobile は npm/CI 外）

`mobile/` は npm workspaces（core/backend/functions）にも既存 CI（ci.yml）にも含まれない。当面はローカルの `flutter analyze`（lint）＋ `flutter test`（ユニット/ウィジェット）＋ `flutter build web`（コンパイル確認）で担保する。将来のモバイル CI 追加は別途（フォローアップ）。

## 影響

- 追加: `mobile/lib/src/{config,core,auth,spots,routing}/*`、`mobile/lib/main.dart` 差し替え、`mobile/test/*`（api_exception / auth_controller / login_screen）。
- 依存追加: `dio` / `flutter_riverpod` / `go_router` / `flutter_secure_storage`（`pubspec.yaml` / `pubspec.lock`）＋各 OS のプラグイン登録ファイル自動更新。
- ドキュメント: 本 ADR、`docs/README.md`（ADR 一覧）。
- バックエンド・DDL・OpenAPI 変更なし（既存契約に対する消費側の実装）。

## フォローアップ / 残課題

- モバイル CI（analyze/test）の追加。
- refresh の同時多発時の直列化は `QueuedInterceptorsWrapper` で吸収しているが、負荷時の挙動は実測していない。
- M2 以降で予約作成・詳細・履歴を実装（本 ADR のスライス計画に従う）。

## 代替案

- **Bloc / Provider**: Bloc はボイラープレートが多く、Provider は非同期の型安全・テスト性で Riverpod に劣る。学習性と将来の複雑化を見て Riverpod を採用。
- **http パッケージ**: 401→refresh の割り込みを手書きすることになり、dio のインターセプタに劣る。
- **認証ゲートを自前 Navigator で**: 画面が増える M2 以降で宣言的リダイレクトの方が破綻しにくいため go_router を先に採用。
