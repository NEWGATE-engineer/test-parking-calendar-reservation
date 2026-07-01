import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../auth/login_screen.dart';
import '../auth/register_screen.dart';
import '../spots/home_screen.dart';

/// 認証状態に応じてルーティングする go_router。
///
/// - `unknown`（起動時トークン確認中）: スプラッシュを出し、リダイレクトしない。
/// - `unauthenticated`: ログイン／登録以外はログインへ。
/// - `authenticated`: ログイン／登録にいたらホームへ。
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
    redirect: (context, state) {
      final status = ref.read(authControllerProvider);
      final loc = state.matchedLocation;
      final onAuthPages = loc == '/login' || loc == '/register';

      // 起動時の確認中はどこへも飛ばさない（スプラッシュを表示）。
      if (status == AuthStatus.unknown) return null;

      if (status == AuthStatus.unauthenticated) {
        // 未認証は認証画面のみ許可。それ以外はログインへ。
        return onAuthPages ? null : '/login';
      }

      // 認証済みで認証画面にいるならホームへ。
      return onAuthPages ? '/' : null;
    },
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
