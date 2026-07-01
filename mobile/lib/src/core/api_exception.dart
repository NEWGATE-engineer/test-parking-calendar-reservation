import 'package:dio/dio.dart';

/// API 由来のエラーを UI で扱いやすい形に正規化した例外。
///
/// バックエンドは失敗時に `{ code, message, retryable, retry_after }`（OpenAPI の Error スキーマ）を
/// 返す。画面はこの `code` / `retryable` で文言や再試行導線を出し分ける（画面設計「エラー UX」）。
/// ネットワーク断など HTTP 応答が無い場合も、ここで統一的に表現する。
class ApiException implements Exception {
  ApiException({
    required this.statusCode,
    required this.code,
    required this.message,
    this.retryable = false,
    this.retryAfter,
  });

  /// HTTP ステータス（応答が無い＝ネットワーク断などは null）。
  final int? statusCode;

  /// アプリ共通のエラーコード（例: `conflict_overlap` / `device_unhealthy`）。
  /// 応答が解釈できない場合は `unknown`、通信失敗は `network` を入れる。
  final String code;

  /// 利用者向けの説明。サーバの message をそのまま使い、無ければ既定文言。
  final String message;

  /// 再試行で解消し得るか（504 やネットワーク断は true、409 競合などは false）。
  final bool retryable;

  /// 再試行までの推奨待機秒数（サーバが返せば）。
  final int? retryAfter;

  /// dio の例外を {@link ApiException} に変換する。
  ///
  /// - サーバが Error スキーマの本文を返していればその `code`/`message`/`retryable` を採用。
  /// - 応答はあるが本文が想定外なら status から最小限の情報で組み立てる。
  /// - 応答が無い（接続失敗・タイムアウト）なら `network`（retryable=true）とする。
  factory ApiException.fromDio(DioException e) {
    final response = e.response;
    if (response == null) {
      // 応答なし＝接続失敗・タイムアウト等。再試行で回復し得る。
      return ApiException(
        statusCode: null,
        code: 'network',
        message: 'ネットワークに接続できませんでした。通信環境を確認してください。',
        retryable: true,
      );
    }

    final data = response.data;
    if (data is Map) {
      final code = data['code'];
      final message = data['message'];
      return ApiException(
        statusCode: response.statusCode,
        code: code is String ? code : 'unknown',
        message: message is String ? message : '予期しないエラーが発生しました。',
        retryable: data['retryable'] == true,
        retryAfter: data['retry_after'] is int ? data['retry_after'] as int : null,
      );
    }

    // 本文が Error スキーマでない（想定外）。status だけで最小限に表現する。
    return ApiException(
      statusCode: response.statusCode,
      code: 'unknown',
      message: '予期しないエラーが発生しました（${response.statusCode}）。',
    );
  }

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}
