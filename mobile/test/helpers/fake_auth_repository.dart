import 'package:dio/dio.dart';
import 'package:mobile/src/auth/auth_repository.dart';
import 'package:mobile/src/auth/auth_tokens.dart';
import 'package:mobile/src/core/api_exception.dart';

/// 認証 API のフェイク（Dio を叩かず、呼び出しを記録する）。
class FakeAuthRepository extends AuthRepository {
  FakeAuthRepository({this.failAuth = false}) : super(Dio());

  /// true なら login/register が ApiException を投げる。
  final bool failAuth;

  bool loginCalled = false;
  bool registerCalled = false;
  bool logoutCalled = false;

  @override
  Future<AuthTokens> login({required String email, required String password}) async {
    loginCalled = true;
    if (failAuth) {
      throw ApiException(statusCode: 401, code: 'unauthorized', message: '認証失敗');
    }
    return const AuthTokens(accessToken: 'a', refreshToken: 'r', expiresIn: 900);
  }

  @override
  Future<AuthTokens> register({
    required String email,
    required String password,
    String? name,
  }) async {
    registerCalled = true;
    if (failAuth) {
      throw ApiException(statusCode: 409, code: 'email_taken', message: '重複');
    }
    return const AuthTokens(accessToken: 'a2', refreshToken: 'r2', expiresIn: 900);
  }

  @override
  Future<void> logout(String refreshToken) async {
    logoutCalled = true;
  }
}
