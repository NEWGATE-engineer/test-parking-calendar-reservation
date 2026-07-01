import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../auth/login_screen.dart';
import '../auth/register_screen.dart';
import '../spots/home_screen.dart';

/// 認証状態と現在ロケーションから、リダイレクト先（不要なら null）を決める純粋関数。
///
/// - `unknown`（起動時トークン確認中）: リダイレクトしない（スプラッシュ表示）。
/// - `unauthenticated`: ログイン／登録以外はログインへ。
/// - `authenticated`: ログイン／登録にいたらホームへ。
///
/// GoRouter から切り出して単体テスト可能にする（リダイレクトループ・未認証での保護画面到達を検知）。
String? authRedirect({required AuthStatus status, required String location}) {
  final onAuthPages = location == '/login' || location == '/register';
  if (status == AuthStatus.unknown) return null;
  if (status == AuthStatus.unauthenticated) {
    return onAuthPages ? null : '/login';
  }
  return onAuthPages ? '/' : null;
}

/// 認証状態に応じてルーティングする go_router。
///
/// 認証状態の変化は `refreshListenable` 経由で redirect を再評価させる（ref.listen で通知）。
final routerProvider = Provider<GoRouter>((ref) {
  // 認証状態が変わるたびに GoRouter に再評価を促すための Listenable。
  final refresh = ValueNotifier<int>(0);
  ref.onDispose(refresh.dispose);
  ref.listen(authControllerProvider, (_, _) => refresh.value++);

  return GoRouter(
    initialLocation: '/',
    refreshListenable: refresh,
    redirect: (context, state) => authRedirect(
      status: ref.read(authControllerProvider),
      location: state.matchedLocation,
    ),
    routes: [
      GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/register', builder: (_, _) => const RegisterScreen()),
    ],
  );
});

/// 起動時（AuthStatus.unknown）に表示するスプラッシュ。
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
