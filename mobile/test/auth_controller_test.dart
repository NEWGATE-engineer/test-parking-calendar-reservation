import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/auth/auth_controller.dart';
import 'package:mobile/src/auth/auth_repository.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/core/token_storage.dart';

import 'helpers/fake_auth_repository.dart';
import 'helpers/fake_token_storage.dart';

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

  test('login 失敗: 例外を投げ、state は authenticated にならない・トークンも保管しない', () async {
    final storage = FakeTokenStorage();
    final c = make(storage, FakeAuthRepository(failAuth: true));
    addTearDown(c.dispose);
    await settled(c);

    await expectLater(
      c.read(authControllerProvider.notifier).login(email: 'e@x.com', password: 'bad'),
      throwsA(isA<ApiException>()),
    );
    expect(c.read(authControllerProvider), AuthStatus.unauthenticated);
    expect(storage.refresh, isNull);
  });

  test('register 失敗: 例外を投げ、state は authenticated にならない', () async {
    final storage = FakeTokenStorage();
    final c = make(storage, FakeAuthRepository(failAuth: true));
    addTearDown(c.dispose);
    await settled(c);

    await expectLater(
      c.read(authControllerProvider.notifier).register(email: 'e@x.com', password: 'password1'),
      throwsA(isA<ApiException>()),
    );
    expect(c.read(authControllerProvider), AuthStatus.unauthenticated);
    expect(storage.refresh, isNull);
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
