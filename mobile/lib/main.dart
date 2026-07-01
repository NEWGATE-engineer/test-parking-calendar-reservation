import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'src/auth/auth_controller.dart';
import 'src/routing/app_router.dart';

void main() {
  // Riverpod のルートスコープ。全プロバイダはこの配下で共有される。
  runApp(const ProviderScope(child: ParkingApp()));
}

/// アプリのルート。
///
/// 起動直後（保管トークン確認中＝AuthStatus.unknown）はスプラッシュを出し、認証状態が定まってから
/// go_router を載せる。こうすることで確認中に保護画面（ホーム）が一瞬マウントされて 401 を投げるのを防ぐ。
class ParkingApp extends ConsumerWidget {
  const ParkingApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(authControllerProvider);
    final theme = ThemeData(colorSchemeSeed: const Color(0xFF1F4E79), useMaterial3: true);

    if (status == AuthStatus.unknown) {
      return MaterialApp(
        title: '駐車場予約',
        theme: theme,
        debugShowCheckedModeBanner: false,
        home: const SplashScreen(),
      );
    }

    return MaterialApp.router(
      title: '駐車場予約',
      theme: theme,
      debugShowCheckedModeBanner: false,
      routerConfig: ref.watch(routerProvider),
    );
  }
}
