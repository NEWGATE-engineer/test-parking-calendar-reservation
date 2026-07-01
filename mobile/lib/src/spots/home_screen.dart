import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../core/api_exception.dart';
import 'spot.dart';
import 'spots_repository.dart';

/// ホーム / 満空表示（GET /spots）。認証必須。
///
/// 区画一覧と満空・デバイス健全性を表示する。MVP は表示時取得＋プルリフレッシュ
/// （画面設計「状態の更新方式」）。予約作成への導線は M2 で追加する。
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final spotsAsync = ref.watch(spotsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('区画の空き状況'),
        actions: [
          IconButton(
            tooltip: 'ログアウト',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/reserve'),
        icon: const Icon(Icons.add),
        label: const Text('予約する'),
      ),
      body: RefreshIndicator(
        // プルダウンで再取得（FutureProvider を無効化して再フェッチ）。
        onRefresh: () async => ref.invalidate(spotsProvider),
        child: spotsAsync.when(
          data: (spots) => _SpotList(spots: spots),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _ErrorView(
            message: e is ApiException ? e.message : '区画を取得できませんでした。',
            onRetry: () => ref.invalidate(spotsProvider),
          ),
        ),
      ),
    );
  }
}

class _SpotList extends StatelessWidget {
  const _SpotList({required this.spots});

  final List<Spot> spots;

  @override
  Widget build(BuildContext context) {
    if (spots.isEmpty) {
      // RefreshIndicator を効かせるためスクロール可能にしておく。
      return ListView(
        children: const [
          SizedBox(height: 120),
          Center(child: Text('区画がありません')),
        ],
      );
    }
    return ListView.separated(
      itemCount: spots.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) => _SpotTile(spot: spots[i]),
    );
  }
}

class _SpotTile extends StatelessWidget {
  const _SpotTile({required this.spot});

  final Spot spot;

  @override
  Widget build(BuildContext context) {
    final (label, color, icon) = _occupancyView(context, spot);
    return ListTile(
      leading: Icon(icon, color: color),
      title: Text(spot.name),
      subtitle: spot.deviceHealthy ? null : const Text('デバイス応答なし'),
      trailing: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
    );
  }

  /// 満空とデバイス健全性を、ラベル・色・アイコンに変換する。
  /// デバイス不健全時は満空が信頼できないため「不明」表示にする。
  (String, Color, IconData) _occupancyView(BuildContext context, Spot spot) {
    final scheme = Theme.of(context).colorScheme;
    if (!spot.deviceHealthy || spot.occupancy == Occupancy.unknown) {
      return ('不明', scheme.outline, Icons.help_outline);
    }
    return switch (spot.occupancy) {
      Occupancy.vacant => ('空き', Colors.green, Icons.check_circle_outline),
      Occupancy.occupied => ('満車', scheme.error, Icons.block),
      Occupancy.unknown => ('不明', scheme.outline, Icons.help_outline),
    };
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ListView(
      // RefreshIndicator を効かせるためスクロール可能に。
      children: [
        const SizedBox(height: 100),
        Icon(Icons.error_outline, size: 48, color: Theme.of(context).colorScheme.error),
        const SizedBox(height: 12),
        Center(child: Text(message, textAlign: TextAlign.center)),
        const SizedBox(height: 12),
        Center(
          child: FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
        ),
      ],
    );
  }
}
