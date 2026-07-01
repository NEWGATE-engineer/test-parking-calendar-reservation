import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/spots/spot.dart';
import 'package:mobile/src/spots/spots_repository.dart';

import 'helpers/fake_adapter.dart';

/// SpotsRepository.fetchSpots の JSON→Spot 変換とエラー正規化を検証する。
void main() {
  Dio dioWith(ResponseBody Function(RequestOptions) handler) {
    return Dio(BaseOptions(baseUrl: 'http://test'))..httpClientAdapter = FakeAdapter(handler);
  }

  test('200: JSON 配列を Spot に変換する（未知 occupancy は unknown に丸める）', () async {
    final repo = SpotsRepository(dioWith((_) => jsonResponse([
          {'id': 's1', 'name': 'A', 'occupancy': 'vacant', 'device_healthy': true},
          {'id': 's2', 'name': 'B', 'occupancy': 'occupied', 'device_healthy': false},
          {'id': 's3', 'name': 'C', 'occupancy': 'weird', 'device_healthy': true},
        ], 200)));

    final spots = await repo.fetchSpots();

    expect(spots, hasLength(3));
    expect(spots[0].occupancy, Occupancy.vacant);
    expect(spots[1].occupancy, Occupancy.occupied);
    expect(spots[1].deviceHealthy, false);
    expect(spots[2].occupancy, Occupancy.unknown); // 未知値は unknown
  });

  test('401: DioException を ApiException に正規化して投げる', () async {
    final repo = SpotsRepository(dioWith(
      (_) => jsonResponse({'code': 'unauthorized', 'message': '認証が必要です'}, 401),
    ));

    await expectLater(
      repo.fetchSpots(),
      throwsA(isA<ApiException>()
          .having((e) => e.statusCode, 'statusCode', 401)
          .having((e) => e.code, 'code', 'unauthorized')),
    );
  });

  group('fetchAvailability', () {
    test('200: UTC クエリで送り、SpotAvailability に変換する', () async {
      late RequestOptions captured;
      final repo = SpotsRepository(dioWith((options) {
        captured = options;
        return jsonResponse([
          {'spot_id': 's1', 'name': 'A', 'available': true, 'reason': 'ok'},
          {'spot_id': 's2', 'name': 'B', 'available': false, 'reason': 'buffer'},
        ], 200);
      }));

      // ローカル時刻で渡しても UTC に正規化されて送られる
      final start = DateTime.utc(2026, 7, 2, 1);
      final end = DateTime.utc(2026, 7, 2, 2);
      final items = await repo.fetchAvailability(start, end);

      expect(items, hasLength(2));
      expect(items[0].available, true);
      expect(items[1].available, false);
      expect(captured.queryParameters['start'], '2026-07-02T01:00:00.000Z');
      expect(captured.queryParameters['end'], '2026-07-02T02:00:00.000Z');
    });

    test('422: ApiException に正規化して投げる', () async {
      final repo = SpotsRepository(dioWith(
        (_) => jsonResponse({'code': 'validation_error', 'message': 'start>=end'}, 422),
      ));

      await expectLater(
        repo.fetchAvailability(DateTime.utc(2026), DateTime.utc(2026)),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'statusCode', 422)),
      );
    });
  });
}
