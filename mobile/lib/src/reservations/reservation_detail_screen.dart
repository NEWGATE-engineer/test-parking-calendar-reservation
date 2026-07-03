import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../core/api_exception.dart';
import '../core/date_format.dart';
import 'reservation.dart';
import 'reservation_status.dart';
import 'reservations_repository.dart';

/// 入庫待ちポーリングの間隔と打ち切り（仮値・画面設計「数秒に1回・最大数分」）。
const _pollInterval = Duration(seconds: 3);
const _pollTimeout = Duration(minutes: 2);

/// 打ち切りまでの最大 tick 数（= 2分 ÷ 3秒 = 40）。壁時計（DateTime.now）ではなく tick を数えることで、
/// テストで仮想時間（tester.pump(interval)）を進めて打ち切りパスを検証できるようにする。
final _maxPollTicks = _pollTimeout.inMilliseconds ~/ _pollInterval.inMilliseconds;

/// 予約詳細（一覧から id で引く）。状態に応じて DOWN（入庫）・利用終了・キャンセルと料金表示を出し分ける。
///
/// DOWN 成功後は在車検知（テレメトリ→active 遷移）を短間隔ポーリングで待つ（入庫待ち）。
/// active になるか上限時間で打ち切る（SQL サーバーレスを無闇に起こさないよう上限を切る）。
class ReservationDetailScreen extends ConsumerStatefulWidget {
  const ReservationDetailScreen({super.key, required this.id});

  final String id;

  @override
  ConsumerState<ReservationDetailScreen> createState() => _ReservationDetailScreenState();
}

class _ReservationDetailScreenState extends ConsumerState<ReservationDetailScreen> {
  Timer? _pollTimer;
  int _pollTicks = 0;
  bool _waitingEntry = false;
  bool _busy = false;

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Reservation? _find(List<Reservation>? list) {
    if (list == null) return null;
    for (final r in list) {
      if (r.id == widget.id) return r;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(reservationsProvider);

    // 入庫待ち中に一覧が更新されたら、対象予約が active になったかを判定して打ち切る。
    ref.listen(reservationsProvider, (_, next) {
      if (!_waitingEntry) return;
      final r = _find(next.asData?.value);
      if (r != null && r.status == 'active') {
        _stopPolling();
        _snack('入庫を確認しました。');
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('予約詳細')),
      body: async.when(
        data: (items) {
          final r = _find(items);
          if (r == null) {
            return const Center(child: Text('予約が見つかりませんでした。'));
          }
          return _DetailBody(
            reservation: r,
            waitingEntry: _waitingEntry,
            busy: _busy,
            onCancel: () => _cancel(r),
            onGateDown: () => _gateDown(r),
            onFinish: () => _finish(r),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(e is ApiException ? e.message : '取得に失敗しました。')),
      ),
    );
  }

  Future<void> _cancel(Reservation r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('予約をキャンセル'),
        content: const Text('この予約をキャンセルしますか？'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('やめる')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('キャンセルする')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(reservationsRepositoryProvider).cancel(r.id);
      ref.invalidate(reservationsProvider);
      _snack('予約をキャンセルしました。');
    } on ApiException catch (e) {
      _snack(e.code == 'not_cancelable' ? 'この予約はキャンセルできません。' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _gateDown(Reservation r) async {
    // request_id は送信操作ごとに新規採番（ADR 0003・トランスポート再送のみ同一キー）。
    final requestId = const Uuid().v4();
    setState(() => _busy = true);
    try {
      await ref.read(reservationsRepositoryProvider).gateDown(id: r.id, requestId: requestId);
      if (!mounted) return;
      // DOWN 成功 → 入庫待ちポーリング開始。
      _startPolling();
    } on ApiException catch (e) {
      _snack(_gateDownError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _finish(Reservation r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('利用を終了'),
        content: const Text('この予約の利用を終了しますか？（料金が確定します）'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('やめる')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('利用終了')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final updated = await ref.read(reservationsRepositoryProvider).finish(r.id);
      ref.invalidate(reservationsProvider);
      if (updated.status == 'completed') {
        // 完了＝料金確定。料金表示を最新化してメッセージ。
        ref.invalidate(feeProvider(r.id));
        _snack('利用を終了しました。料金が確定しました。');
      } else {
        // 在車中に呼ばれた場合（通常はボタンを出さないが保険）＝出庫検知で完了。
        _snack('利用終了を受け付けました。出庫後に完了します。');
      }
    } on ApiException catch (e) {
      _snack(e.code == 'not_finishable' ? 'この予約は利用終了できません。' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _startPolling() {
    // 二重開始の防御（UI 上はボタン無効化済みだが念のため先にキャンセル）。
    _pollTimer?.cancel();
    setState(() {
      _waitingEntry = true;
      _pollTicks = 0;
    });
    _pollTimer = Timer.periodic(_pollInterval, (_) {
      _pollTicks++;
      if (_pollTicks > _maxPollTicks) {
        _stopPolling();
        _snack('入庫が確認できませんでした。予約はそのままです。');
        return;
      }
      // 一覧を再取得して状態変化（active）を拾う。判定は build 内の ref.listen。
      ref.invalidate(reservationsProvider);
    });
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
    if (mounted) setState(() => _waitingEntry = false);
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// gate-down のエラーを code に応じた文言にする（画面設計「エラー UX」）。
  String _gateDownError(ApiException e) {
    switch (e.code) {
      case 'invalid_state':
        return 'この予約は現在 DOWN 指示できません（予約時間内かご確認ください）。';
      case 'physical_occupancy':
        return '区画が使用中です。しばらくしてからお試しください。';
      case 'device_unhealthy':
        return 'デバイスが応答していません。時間をおいてお試しください。';
      case 'timeout':
        return 'デバイスが応答しませんでした。もう一度お試しください。';
      case 'command_in_progress':
        return '前の操作を処理中です。少しお待ちください。';
      case 'command_failed':
        return '操作に失敗しました。もう一度お試しください。';
      default:
        return e.message;
    }
  }
}

/// 詳細の本文。予約情報・料金・状態に応じたアクション（DOWN・利用終了・キャンセル）を表示する。
/// 料金は自前で Provider を購読する {@link _MoneySection} に委ねるため、ここは ref 不要の StatelessWidget。
class _DetailBody extends StatelessWidget {
  const _DetailBody({
    required this.reservation,
    required this.waitingEntry,
    required this.busy,
    required this.onCancel,
    required this.onGateDown,
    required this.onFinish,
  });

  final Reservation reservation;
  final bool waitingEntry;
  final bool busy;
  final VoidCallback onCancel;
  final VoidCallback onGateDown;
  final VoidCallback onFinish;

  @override
  Widget build(BuildContext context) {
    final r = reservation;
    final now = DateTime.now();
    final gateDownEnabled = canGateDown(
      status: r.status,
      now: now,
      start: r.startTime,
      end: r.endTime,
    );
    final cancelEnabled = canCancel(r.status);
    final finishEnabled = canFinish(status: r.status, inCar: r.inCar);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('状態'),
          trailing: Chip(label: Text(reservationStatusLabel(r.status))),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('区画'),
          subtitle: Text(r.spotId),
        ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('時間'),
          subtitle: Text('${formatLocalDateTime(r.startTime)} 〜 ${formatLocalDateTime(r.endTime)}'),
        ),
        _MoneySection(reservation: r),
        const Divider(height: 32),
        if (waitingEntry) ...[
          const Row(
            children: [
              SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              SizedBox(width: 12),
              Expanded(child: Text('入庫を確認しています…（車両を進入させてください）')),
            ],
          ),
          const SizedBox(height: 16),
        ],
        if (r.status == 'reserved' && !gateDownEnabled)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('DOWN（入庫）は予約時間内に操作できます。', style: TextStyle(color: Colors.grey)),
          ),
        FilledButton.icon(
          onPressed: (busy || waitingEntry || !gateDownEnabled) ? null : onGateDown,
          icon: const Icon(Icons.vertical_align_bottom),
          label: const Text('入庫する（DOWN）'),
        ),
        if (finishEnabled) ...[
          const SizedBox(height: 8),
          FilledButton.tonalIcon(
            onPressed: busy ? null : onFinish,
            icon: const Icon(Icons.flag_outlined),
            label: const Text('利用を終了する'),
          ),
        ],
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: (busy || waitingEntry || !cancelEnabled) ? null : onCancel,
          icon: const Icon(Icons.cancel_outlined),
          label: const Text('予約をキャンセル'),
        ),
      ],
    );
  }
}

/// 料金セクション。完了後は確定額（fee GET）、完了前は見込み額（予約の estimated_slot_fee）を表示。
/// cancelled / no_show は料金を表示しない。
class _MoneySection extends ConsumerWidget {
  const _MoneySection({required this.reservation});

  final Reservation reservation;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = reservation;

    // 完了：確定額を fee GET から。
    if (showsConfirmedFee(r.status)) {
      return ref.watch(feeProvider(r.id)).when(
        data: (fee) => ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('料金（確定）'),
          subtitle: Text('枠 ¥${_yen(fee.slotFee)} ＋ 超過 ¥${_yen(fee.overstayFee)}'),
          trailing: Text('¥${_yen(fee.total)}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
        loading: () => const ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('料金（確定）'),
          trailing: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
        ),
        error: (_, _) => const ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('料金（確定）'),
          subtitle: Text('取得できませんでした'),
        ),
      );
    }

    // 取消・ノーショーは料金なし。
    if (r.status == 'cancelled' || r.status == 'no_show') {
      return const SizedBox.shrink();
    }

    // 完了前：予約枠の見込み額（超過は完了時に確定）。
    final est = reservation.estimatedSlotFee;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: const Text('料金（見込み）'),
      subtitle: const Text('予約枠のみ。超過は完了時に確定します。'),
      trailing: Text(est == null ? '—' : '¥${_yen(est)}'),
    );
  }
}

/// 金額を円の整数表記にする（端数は四捨五入）。
String _yen(num v) => v.round().toString();

