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

  ReservationsRepository repoWith(ResponseBody Function(RequestOptions) handler) {
    return ReservationsRepository(
      Dio(BaseOptions(baseUrl: 'http://test'))..httpClientAdapter = FakeAdapter(handler),
    );
  }

  test('fetchReservations 200: 配列を Reservation に変換', () async {
    final repo = repoWith((_) => jsonResponse([
          {
            'id': 'r1',
            'spot_id': 's1',
            'start_time': '2026-07-02T01:00:00.000Z',
            'end_time': '2026-07-02T02:00:00.000Z',
            'status': 'reserved',
            'created_at': '2026-07-01T00:00:00.000Z',
          },
        ], 200));

    final list = await repo.fetchReservations();
    expect(list, hasLength(1));
    expect(list[0].status, 'reserved');
  });

  test('cancel 204: 例外を投げない / 409 は not_cancelable を正規化', () async {
    await repoWith((_) => jsonResponse(null, 204)).cancel('r1');

    await expectLater(
      repoWith((_) => jsonResponse({'code': 'not_cancelable', 'message': 'x'}, 409)).cancel('r1'),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'not_cancelable')),
    );
  });

  test('gateDown 200: request_id を送り command_id を返す', () async {
    late RequestOptions captured;
    final repo = repoWith((options) {
      captured = options;
      return jsonResponse({'result': 'down', 'command_id': 'cmd-1'}, 200);
    });

    final res = await repo.gateDown(id: 'r1', requestId: 'req-1');
    expect(res.commandId, 'cmd-1');
    expect((captured.data as Map)['request_id'], 'req-1');
    expect(captured.path, '/reservations/r1/gate-down');
  });

  test('gateDown 504 timeout: retryable な ApiException', () async {
    await expectLater(
      repoWith((_) => jsonResponse({'code': 'timeout', 'message': '無応答', 'retryable': true}, 504))
          .gateDown(id: 'r1', requestId: 'req-1'),
      throwsA(isA<ApiException>()
          .having((e) => e.code, 'code', 'timeout')
          .having((e) => e.retryable, 'retryable', true)),
    );
  });

  test('finish 200: Reservation に変換（completed）', () async {
    late RequestOptions captured;
    final repo = repoWith((options) {
      captured = options;
      return jsonResponse({
        'id': 'r1',
        'spot_id': 's1',
        'start_time': '2026-07-02T01:00:00.000Z',
        'end_time': '2026-07-02T01:30:00.000Z',
        'status': 'completed',
        'created_at': '2026-07-01T00:00:00.000Z',
        'estimated_slot_fee': 100,
        'in_car': false,
      }, 200);
    });

    final res = await repo.finish('r1');
    expect(res.status, 'completed');
    expect(res.inCar, false);
    expect(captured.path, '/reservations/r1/finish');
  });

  test('finish 409 not_finishable: ApiException', () async {
    await expectLater(
      repoWith((_) => jsonResponse({'code': 'not_finishable', 'message': 'x'}, 409)).finish('r1'),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'not_finishable')),
    );
  });

  test('fetchFee 200: confirmed を Fee に変換', () async {
    final repo = repoWith(
      (_) => jsonResponse({
        'reservation_id': 'r1',
        'slot_fee': 200,
        'overstay_fee': 100,
        'total': 300,
        'status': 'confirmed',
        'calculated_at': '2026-07-02T02:00:00.000Z',
      }, 200),
    );
    final fee = await repo.fetchFee('r1');
    expect(fee.isConfirmed, true);
    expect(fee.total, 300);
  });

  test('fetchFee 200: pending（未確定）', () async {
    final repo = repoWith(
      (_) => jsonResponse({
        'reservation_id': 'r1',
        'slot_fee': 0,
        'overstay_fee': 0,
        'total': 0,
        'status': 'pending',
        'calculated_at': null,
      }, 200),
    );
    final fee = await repo.fetchFee('r1');
    expect(fee.isConfirmed, false);
    expect(fee.calculatedAt, isNull);
  });
}
