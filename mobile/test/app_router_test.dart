import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/auth/auth_controller.dart';
import 'package:mobile/src/routing/app_router.dart';

/// authRedirect（認証状態×ロケーション→リダイレクト先）の分岐を網羅する。
void main() {
  group('authRedirect', () {
    test('unknown はどこにいてもリダイレクトしない（スプラッシュ）', () {
      expect(authRedirect(status: AuthStatus.unknown, location: '/'), isNull);
      expect(authRedirect(status: AuthStatus.unknown, location: '/login'), isNull);
    });

    group('unauthenticated', () {
      test('保護画面はログインへ', () {
        expect(authRedirect(status: AuthStatus.unauthenticated, location: '/'), '/login');
      });
      test('ログイン／登録はそのまま', () {
        expect(authRedirect(status: AuthStatus.unauthenticated, location: '/login'), isNull);
        expect(authRedirect(status: AuthStatus.unauthenticated, location: '/register'), isNull);
      });
    });

    group('authenticated', () {
      test('認証画面にいたらホームへ', () {
        expect(authRedirect(status: AuthStatus.authenticated, location: '/login'), '/');
        expect(authRedirect(status: AuthStatus.authenticated, location: '/register'), '/');
      });
      test('保護画面はそのまま', () {
        expect(authRedirect(status: AuthStatus.authenticated, location: '/'), isNull);
      });
    });
  });
}
