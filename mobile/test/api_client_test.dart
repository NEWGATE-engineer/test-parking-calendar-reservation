import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_client.dart';

import 'helpers/fake_adapter.dart';
import 'helpers/fake_token_storage.dart';

/// AuthInterceptor の 401→refresh→retry・失効・多重refresh防止を検証する。
///
/// 実ネットワークは使わず、メイン dio と refreshClient で **同じ FakeAdapter** を共有し、
/// リクエストの path/extra/回数で挙動を組み立てる。
void main() {
  /// メイン dio（AuthInterceptor 付き）と refreshClient に同一 adapter を挿す。
  ({Dio dio, FakeAdapter adapter, FakeTokenStorage storage, List<int> expired}) setup(
    ResponseBody Function(RequestOptions) handler,
  ) {
    final adapter = FakeAdapter(handler);
    final storage = FakeTokenStorage()
      ..access = 'AT0'
      ..refresh = 'RT0';
    final expired = <int>[];

    final dio = Dio(BaseOptions(baseUrl: 'http://test'))..httpClientAdapter = adapter;
    final refreshClient = Dio(BaseOptions(baseUrl: 'http://test'))..httpClientAdapter = adapter;
    dio.interceptors.add(
      AuthInterceptor(
        storage: storage,
        refreshClient: refreshClient,
        onSessionExpired: () => expired.add(1),
      ),
    );
    return (dio: dio, adapter: adapter, storage: storage, expired: expired);
  }

  test('401 → refresh 成功 → 新トークンで1回だけ再試行して成功', () async {
    final s = setup((options) {
      if (options.path == '/auth/refresh') {
        return jsonResponse(
          {'access_token': 'AT1', 'refresh_token': 'RT1', 'expires_in': 900},
          200,
        );
      }
      // /spots: リトライ（__retried__）なら 200、初回は 401
      if (options.extra['__retried__'] == true) {
        return jsonResponse([
          {'id': 's1', 'name': 'A', 'occupancy': 'vacant', 'device_healthy': true},
        ], 200);
      }
      return jsonResponse({'code': 'unauthorized', 'message': '認証が必要です'}, 401);
    });

    final res = await s.dio.get<dynamic>('/spots');

    expect(res.statusCode, 200);
    expect(s.storage.access, 'AT1'); // ローテーション後の新トークンを保管
    expect(countPath(s.adapter, '/auth/refresh'), 1);
    expect(countPath(s.adapter, '/spots'), 2); // 初回401 + リトライ
    expect(s.expired, isEmpty);
  });

  test('401 → refresh 失敗（refresh も 401）→ トークン破棄＋失効通知', () async {
    final s = setup((options) {
      if (options.path == '/auth/refresh') {
        return jsonResponse({'code': 'unauthorized', 'message': '失効'}, 401);
      }
      return jsonResponse({'code': 'unauthorized', 'message': '認証が必要です'}, 401);
    });

    await expectLater(s.dio.get<dynamic>('/spots'), throwsA(isA<DioException>()));

    expect(s.storage.access, isNull); // 破棄された
    expect(s.storage.refresh, isNull);
    expect(s.expired, [1]); // onSessionExpired 発火
    expect(countPath(s.adapter, '/auth/refresh'), 1); // refresh の 401 で再帰しない
  });

  test('同時多発の 401 でも refresh は 1 回だけ（in-flight 共有）', () async {
    final s = setup((options) {
      if (options.path == '/auth/refresh') {
        return jsonResponse(
          {'access_token': 'AT1', 'refresh_token': 'RT1', 'expires_in': 900},
          200,
        );
      }
      if (options.extra['__retried__'] == true) {
        return jsonResponse(<dynamic>[], 200);
      }
      return jsonResponse({'code': 'unauthorized', 'message': '認証が必要です'}, 401);
    });

    // 2 本を同時に投げる
    final results = await Future.wait([
      s.dio.get<dynamic>('/spots'),
      s.dio.get<dynamic>('/reservations'),
    ]);

    expect(results.every((r) => r.statusCode == 200), true);
    expect(countPath(s.adapter, '/auth/refresh'), 1); // 多重発火していない
  });
}
