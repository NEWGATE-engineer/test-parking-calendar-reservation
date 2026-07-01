import 'package:mobile/src/auth/auth_tokens.dart';
import 'package:mobile/src/core/token_storage.dart';

/// インメモリのトークン保管（platform 依存の secure storage を使わない）。
class FakeTokenStorage extends TokenStorage {
  String? access;
  String? refresh;

  @override
  Future<void> save(AuthTokens tokens) async {
    access = tokens.accessToken;
    refresh = tokens.refreshToken;
  }

  @override
  Future<String?> readAccessToken() async => access;

  @override
  Future<String?> readRefreshToken() async => refresh;

  @override
  Future<void> clear() async {
    access = null;
    refresh = null;
  }
}
