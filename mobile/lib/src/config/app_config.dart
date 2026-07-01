/// アプリ全体の設定値。
///
/// API のベース URL は起動時の `--dart-define=API_BASE_URL=...` で渡す
/// （CLAUDE.md の開発コマンド参照）。渡されなければローカル既定にフォールバックする。
library;

/// 環境依存の設定をまとめた定数群。
class AppConfig {
  /// バックエンド API のベース URL。
  ///
  /// `flutter run --dart-define=API_BASE_URL=http://localhost:3000` のように注入する。
  /// `String.fromEnvironment` はコンパイル時に解決されるため const で持てる。
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:3000',
  );

  /// 会員登録時に同意する規約バージョン（MVP は固定・要件 §9 / 画面設計）。
  /// 本来は規約取得 API から得る想定だが、未実装のため仮の固定値を送る。
  static const String termsVersion = '2026-01';
}
