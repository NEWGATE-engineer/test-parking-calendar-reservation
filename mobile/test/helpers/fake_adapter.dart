import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// テスト用の HttpClientAdapter。実ネットワークを使わず、リクエストごとに
/// テストが与えた `handler` の応答を返す。呼ばれたリクエストは [requests] に記録する。
///
/// dio は既定の validateStatus により 400 以上を DioException にするため、401 等を返せば
/// AuthInterceptor.onError / リポジトリの catch を検証できる。
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  /// リクエスト（path・headers・extra など）から応答を組み立てる。
  final ResponseBody Function(RequestOptions options) handler;

  /// 受け取ったリクエストの記録（呼び出し回数・順序・ヘッダの検証用）。
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

/// JSON 本文の ResponseBody を作る。
ResponseBody jsonResponse(Object? data, int statusCode) {
  return ResponseBody.fromString(
    jsonEncode(data),
    statusCode,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}

/// 指定パスの呼び出し回数を数える。
int countPath(FakeAdapter adapter, String path) =>
    adapter.requests.where((r) => r.path == path).length;
