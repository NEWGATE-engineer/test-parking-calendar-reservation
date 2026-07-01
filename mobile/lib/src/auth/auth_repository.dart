import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../core/api_client.dart';
import '../core/api_exception.dart';
import 'auth_tokens.dart';

/// 認証 API（register / login / logout）を叩くデータアクセス層。
///
/// 失敗はすべて {@link ApiException} に正規化して投げ、UI 側で code/message により分岐できるようにする。
class AuthRepository {
  AuthRepository(this._dio);

  final Dio _dio;

  /// 会員登録。成功でトークン一式を返す（201）。
  ///
  /// @throws ApiException 409 メール重複 / 422 入力不正 / network など
  Future<AuthTokens> register({
    required String email,
    required String password,
    String? name,
  }) async {
    try {
      final res = await _dio.post<dynamic>('/auth/register', data: {
        'email': email,
        'password': password,
        if (name != null && name.isNotEmpty) 'name': name,
        'terms_version': AppConfig.termsVersion,
      });
      return AuthTokens.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// ログイン。成功でトークン一式を返す（200）。
  ///
  /// @throws ApiException 401 認証失敗 / 403 無効 / 429 ロック / network など
  Future<AuthTokens> login({required String email, required String password}) async {
    try {
      final res = await _dio.post<dynamic>('/auth/login', data: {
        'email': email,
        'password': password,
      });
      return AuthTokens.fromJson(Map<String, dynamic>.from(res.data as Map));
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// ログアウト。リフレッシュトークンを失効する（204）。
  ///
  /// ベストエフォート: 通信失敗しても端末側の破棄は呼び出し側（AuthController）が行うため、
  /// ここでの失敗は無視してよい（サーバ側トークンは期限切れで自然失効する）。
  Future<void> logout(String refreshToken) async {
    try {
      await _dio.post<dynamic>('/auth/logout', data: {'refresh_token': refreshToken});
    } on DioException {
      // ベストエフォート。端末側のトークン破棄は AuthController が確実に行う。
    }
  }
}

/// アプリ共通の {@link AuthRepository}。
final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(ref.read(dioProvider)),
);
