import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/api_exception.dart';
import 'spot.dart';
import 'spot_availability.dart';

/// 開始・終了（ローカル DateTime）の範囲。availabilityProvider の family キー。
/// Dart のレコードは値等価なので、同じ範囲なら FutureProvider のキャッシュが効く。
typedef DateRange = ({DateTime start, DateTime end});

/// 区画 API（GET /spots, GET /spots/availability）のデータアクセス層。
class SpotsRepository {
  SpotsRepository(this._dio);

  final Dio _dio;

  /// 区画一覧と現在の満空を取得する（要認証）。
  ///
  /// @throws ApiException 401（未認証）/ network など
  Future<List<Spot>> fetchSpots() async {
    try {
      final res = await _dio.get<dynamic>('/spots');
      final list = res.data as List<dynamic>;
      return list
          .map((e) => Spot.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(growable: false);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// 対象時間帯の区画ごとの予約可否を取得する（best-effort）。時刻は UTC ISO8601 で送る。
  ///
  /// @throws ApiException 401 / 422（start≥end 等）/ network など
  Future<List<SpotAvailability>> fetchAvailability(DateTime start, DateTime end) async {
    try {
      final res = await _dio.get<dynamic>('/spots/availability', queryParameters: {
        'start': start.toUtc().toIso8601String(),
        'end': end.toUtc().toIso8601String(),
      });
      final list = res.data as List<dynamic>;
      return list
          .map((e) => SpotAvailability.fromJson(Map<String, dynamic>.from(e as Map)))
          .toList(growable: false);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }
}

/// アプリ共通の {@link SpotsRepository}。
final spotsRepositoryProvider = Provider<SpotsRepository>(
  (ref) => SpotsRepository(ref.read(dioProvider)),
);

/// ホーム画面が購読する区画一覧の非同期状態。
///
/// `FutureProvider` により loading/error/data を型（AsyncValue）で扱える。
/// 画面のプルリフレッシュでは `ref.invalidate(spotsProvider)` で再取得する。
final spotsProvider = FutureProvider<List<Spot>>(
  (ref) => ref.read(spotsRepositoryProvider).fetchSpots(),
);

/// 指定時間帯の予約可否。範囲（レコード）を family キーにしてキャッシュする。
///
/// 予約画面で開始＋所要時間が定まるたびに、その範囲の可否を購読する。
final availabilityProvider = FutureProvider.family<List<SpotAvailability>, DateRange>(
  (ref, range) => ref.read(spotsRepositoryProvider).fetchAvailability(range.start, range.end),
);
