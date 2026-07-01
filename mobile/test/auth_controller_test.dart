import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/auth/auth_controller.dart';
import 'package:mobile/src/auth/auth_repository.dart';
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

/// 認証 API のフェイク（Dio を叩かない）。
class FakeAuthRepository extends AuthRepository {
  FakeAuthRepository() : super(Dio());

  bool logoutCalled = false;

  @override
  Future<AuthTokens> login({required String email, required String password}) async {
    return const AuthTokens(accessToken: 'a', refreshToken: 'r', expiresIn: 900);
  }

  @override
  Future<AuthTokens> register({
    required String email,
    required String password,
    String? name,
  }) async {
    return const AuthTokens(accessToken: 'a2', refreshToken: 'r2', expiresIn: 900);
  }

  @override
  Future<void> logout(String refreshToken) async {
    logoutCalled = true;
  }
}

/// state が unknown → 解決するまで待つ小ヘルパー。
Future<AuthStatus> settled(ProviderContainer c) async {
  for (var i = 0; i < 20; i++) {
    final s = c.read(authControllerProvider);
    if (s != AuthStatus.unknown) return s;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  return c.read(authControllerProvider);
}

void main() {
  ProviderContainer make(FakeTokenStorage storage, FakeAuthRepository repo) {
    return ProviderContainer(
      overrides: [
        tokenStorageProvider.overrideWithValue(storage),
        authRepositoryProvider.overrideWithValue(repo),
      ],
    );
  }

  test('起動時: リフレッシュトークンが無ければ unauthenticated', () async {
    final c = make(FakeTokenStorage(), FakeAuthRepository());
    addTearDown(c.dispose);
    expect(await settled(c), AuthStatus.unauthenticated);
  });

  test('起動時: リフレッシュトークンがあれば authenticated', () async {
    final storage = FakeTokenStorage()..refresh = 'existing';
    final c = make(storage, FakeAuthRepository());
    addTearDown(c.dispose);
    expect(await settled(c), AuthStatus.authenticated);
  });

  test('login: トークンを保管し authenticated へ', () async {
    final storage = FakeTokenStorage();
    final c = make(storage, FakeAuthRepository());
    addTearDown(c.dispose);
    await settled(c);

    await c.read(authControllerProvider.notifier).login(email: 'e@x.com', password: 'pw');

    expect(c.read(authControllerProvider), AuthStatus.authenticated);
    expect(storage.refresh, 'r');
  });

  test('logout: サーバ失効を呼びトークン破棄・unauthenticated へ', () async {
    final storage = FakeTokenStorage()
      ..access = 'a'
      ..refresh = 'r';
    final repo = FakeAuthRepository();
    final c = make(storage, repo);
    addTearDown(c.dispose);
    await settled(c);

    await c.read(authControllerProvider.notifier).logout();

    expect(repo.logoutCalled, true);
    expect(storage.refresh, isNull);
    expect(c.read(authControllerProvider), AuthStatus.unauthenticated);
  });

  test('markSessionExpired: unauthenticated へ倒す', () async {
    final storage = FakeTokenStorage()..refresh = 'r';
    final c = make(storage, FakeAuthRepository());
    addTearDown(c.dispose);
    await settled(c);

    c.read(authControllerProvider.notifier).markSessionExpired();

    expect(c.read(authControllerProvider), AuthStatus.unauthenticated);
  });
}
