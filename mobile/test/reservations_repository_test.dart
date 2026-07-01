import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/reservations/reservations_repository.dart';

import 'helpers/fake_adapter.dart';

/// ReservationsRepository.create の 201 変換・UTC 送信・409 正規化を検証する。
void main() {
  test('201: ReservationResponse を Reservation に変換（estimated_slot_fee 含む）', () async {
    late RequestOptions captured;
    final repo = ReservationsRepository(
      Dio(BaseOptions(baseUrl: 'http://test'))
        ..httpClientAdapter = FakeAdapter((options) {
          captured = options;
          return jsonResponse({
            'id': 'r1',
            'spot_id': 's1',
            'start_time': '2026-07-02T01:00:00.000Z',
            'end_time': '2026-07-02T02:00:00.000Z',
            'status': 'reserved',
            'created_at': '2026-07-01T00:00:00.000Z',
            'estimated_slot_fee': 200,
          }, 201);
        }),
    );

    final start = DateTime.utc(2026, 7, 2, 1);
    final end = DateTime.utc(2026, 7, 2, 2);
    final resv = await repo.create(spotId: 's1', start: start, end: end);

    expect(resv.id, 'r1');
    expect(resv.estimatedSlotFee, 200);
    expect(resv.status, 'reserved');
    // UTC ISO8601 で送っている（末尾 Z）
    final body = captured.data as Map;
    expect(body['start_time'], '2026-07-02T01:00:00.000Z');
    expect(body['spot_id'], 's1');
  });

  test('409 conflict_overlap: ApiException に正規化して投げる', () async {
    final repo = ReservationsRepository(
      Dio(BaseOptions(baseUrl: 'http://test'))
        ..httpClientAdapter = FakeAdapter(
          (_) => jsonResponse(
            {'code': 'conflict_overlap', 'message': '重複', 'retryable': false},
            409,
          ),
        ),
    );

    await expectLater(
      repo.create(spotId: 's1', start: DateTime.utc(2026), end: DateTime.utc(2026, 1, 1, 1)),
      throwsA(isA<ApiException>()
          .having((e) => e.statusCode, 'statusCode', 409)
          .having((e) => e.code, 'code', 'conflict_overlap')),
    );
  });
}
