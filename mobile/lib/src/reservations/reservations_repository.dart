import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/api_exception.dart';
import 'reservation.dart';

/// 予約 API（POST /reservations ほか）のデータアクセス層。
class ReservationsRepository {
  ReservationsRepository(this._dio);

  final Dio _dio;

  /// 予約を作成する（201）。時刻は UTC ISO8601 で送る（CLAUDE.md: 時刻は UTC 保存）。
  ///
  /// @throws ApiException 404 区画なし / 409 conflict_overlap|conflict_buffer|device_unhealthy /
  ///   422 入力不正 / 401 / network
  Future<Reservation> create({
    required String spotId,
    required DateTime start,
    required DateTime end,
  }) async {
    try {
      final res = await _dio.post<dynamic>('/reservations', data: {
        'spot_id': spotId,
        'start_time': start.toUtc().toIso8601String(),
        'end_time': end.toUtc().toIso8601String(),
      });
      return Reservation.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }
}

/// アプリ共通の {@link ReservationsRepository}。
final reservationsRepositoryProvider = Provider<ReservationsRepository>(
  (ref) => ReservationsRepository(ref.read(dioProvider)),
);
