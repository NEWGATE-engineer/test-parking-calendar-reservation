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
}
