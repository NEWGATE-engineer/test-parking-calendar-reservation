import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/api_exception.dart';
import '../core/date_format.dart';
import 'reservation.dart';
import 'reservation_status.dart';
import 'reservations_repository.dart';

/// 予約一覧（GET /reservations）。タップで詳細へ。
///
/// 単体取得 API が無いため、この一覧が詳細画面のデータ源も兼ねる（詳細は id で本一覧から引く）。
class ReservationsListScreen extends ConsumerWidget {
  const ReservationsListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(reservationsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('予約一覧')),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(reservationsProvider),
        child: async.when(
          data: (items) => items.isEmpty
              ? ListView(
                  children: const [SizedBox(height: 120), Center(child: Text('予約がありません'))],
                )
              : ListView.separated(
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, i) => _ReservationTile(reservation: items[i]),
                ),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(
            children: [
              const SizedBox(height: 100),
              Center(child: Text(e is ApiException ? e.message : '予約を取得できませんでした。')),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReservationTile extends StatelessWidget {
  const _ReservationTile({required this.reservation});

  final Reservation reservation;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(
        '${formatLocalDateTime(reservation.startTime)} 〜 ${formatLocalDateTime(reservation.endTime)}',
      ),
      subtitle: Text('区画: ${reservation.spotId}'),
      trailing: Chip(label: Text(reservationStatusLabel(reservation.status))),
      onTap: () => context.push('/reservation/${reservation.id}'),
    );
  }
}
