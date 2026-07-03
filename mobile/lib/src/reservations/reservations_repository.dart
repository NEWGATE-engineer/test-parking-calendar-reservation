import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/api_exception.dart';
import 'fee.dart';
import 'reservation.dart';

/// gate-down（DOWN 指示）成功結果（OpenAPI GateDownResponse）。
class GateDownResult {
  const GateDownResult({required this.commandId});

  final String commandId;

  factory GateDownResult.fromJson(Map<String, dynamic> json) =>
      GateDownResult(commandId: json['command_id'] as String? ?? '');
}

/// 予約 API（POST /reservations ほか）のデータアクセス層。
class ReservationsRepository {
  ReservationsRepository(this._dio);

  final Dio _dio;

  /// 自分の予約・利用履歴一覧を取得する（新しい開始順はサーバ側）。
  ///
  /// @throws ApiException 401 / network
  Future<List<Reservation>> fetchReservations() async {
    try {
      final res = await _dio.get<dynamic>('/reservations');
      final list = res.data as List<dynamic>;
      return list
          .map((e) => Reservation.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(growable: false);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// 予約をキャンセルする（reserved のみ・204）。
  ///
  /// @throws ApiException 404 / 409 not_cancelable / 401 / network
  Future<void> cancel(String id) async {
    try {
      await _dio.delete<dynamic>('/reservations/$id');
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// DOWN 指示（入庫）。request_id で冪等性を担保する（呼び出し側が送信操作ごとに採番）。
  ///
  /// @throws ApiException 404 / 409 invalid_state|physical_occupancy|command_* /
  ///   503 device_unhealthy / 504 timeout(retryable) / 401 / network
  Future<GateDownResult> gateDown({required String id, required String requestId}) async {
    try {
      final res = await _dio.post<dynamic>(
        '/reservations/$id/gate-down',
        data: {'request_id': requestId},
      );
      return GateDownResult.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// 利用終了を申告する（200）。空車なら即完了＋料金確定、在車中は end_time 前倒しのみ。
  ///
  /// @throws ApiException 404 / 409 not_finishable / 401 / network
  Future<Reservation> finish(String id) async {
    try {
      final res = await _dio.post<dynamic>('/reservations/$id/finish');
      return Reservation.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// 料金を取得する（200）。未確定なら status=pending が返る。
  ///
  /// @throws ApiException 404 / 401 / network
  Future<Fee> fetchFee(String id) async {
    try {
      final res = await _dio.get<dynamic>('/reservations/$id/fee');
      return Fee.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

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

/// 自分の予約一覧の非同期状態。一覧・詳細画面が購読し、操作後は invalidate で最新化する。
///
/// 単体取得 API（GET /reservations/{id}）が無いため、詳細画面もこの一覧から id で対象を引く。
final reservationsProvider = FutureProvider<List<Reservation>>(
  (ref) => ref.read(reservationsRepositoryProvider).fetchReservations(),
);

/// 予約の確定料金。完了した予約の詳細画面で watch する（family キーは予約 ID）。
///
/// 完了前は fee GET が pending を返すため、詳細画面では completed のときだけ購読する
/// （完了前の見込みは予約の estimated_slot_fee を使う）。
final feeProvider = FutureProvider.family<Fee, String>(
  (ref, id) => ref.read(reservationsRepositoryProvider).fetchFee(id),
);
