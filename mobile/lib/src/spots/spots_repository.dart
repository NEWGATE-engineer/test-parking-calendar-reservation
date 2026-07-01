import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/api_exception.dart';
import 'spot.dart';

/// 区画 API（GET /spots）のデータアクセス層。
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
