import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/api_exception.dart';
import '../spots/spot_availability.dart';
import '../spots/spots_repository.dart';
import 'reservations_repository.dart';

/// 予約作成画面（GET /spots/availability → POST /reservations）。
///
/// 開始日時＋所要時間を選ぶと、その範囲の予約可否を表示する。空いている区画をタップ→確認→作成。
/// 見込み料金は作成 API のレスポンス（estimated_slot_fee）で表示する（クライアント試算はしない）。
class ReserveScreen extends ConsumerStatefulWidget {
  const ReserveScreen({super.key});

  @override
  ConsumerState<ReserveScreen> createState() => _ReserveScreenState();
}

class _ReserveScreenState extends ConsumerState<ReserveScreen> {
  /// 選べる所要時間（分）。仮の候補。
  static const _durations = [30, 60, 90, 120];

  late DateTime _start = _roundUpTo15(DateTime.now());
  int _durationMin = 60;

  DateTime get _end => _start.add(Duration(minutes: _durationMin));
  DateRange get _range => (start: _start, end: _end);

  /// 次の 15 分区切りに切り上げた開始時刻（既定値を「いま以降のきりのいい時刻」にする）。
  static DateTime _roundUpTo15(DateTime now) {
    final base = DateTime(now.year, now.month, now.day, now.hour, now.minute);
    final add = (15 - base.minute % 15) % 15;
    return base.add(Duration(minutes: add == 0 ? 15 : add));
  }

  Future<void> _pickStart() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: _start,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 30)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_start),
    );
    if (time == null || !mounted) return;
    setState(() {
      _start = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
  }

  @override
  Widget build(BuildContext context) {
    final availabilityAsync = ref.watch(availabilityProvider(_range));

    return Scaffold(
      appBar: AppBar(title: const Text('予約する')),
      body: Column(
        children: [
          _RangeSelector(
            startLabel: _fmtDateTime(_start),
            endLabel: _fmtDateTime(_end),
            durationMin: _durationMin,
            durations: _durations,
            onPickStart: _pickStart,
            onDurationChanged: (v) => setState(() => _durationMin = v),
          ),
          const Divider(height: 1),
          Expanded(
            child: availabilityAsync.when(
              data: (items) => _AvailabilityList(
                items: items,
                onReserve: (spot) => _confirmAndReserve(spot),
              ),
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(
                child: Text(e is ApiException ? e.message : '可否を取得できませんでした。'),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 確認ダイアログ→作成。成功で見込み料金を表示しホームへ戻る。失敗は code に応じた文言を出す。
  Future<void> _confirmAndReserve(SpotAvailability spot) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('予約の確認'),
        content: Text('${spot.name}\n${_fmtDateTime(_start)} 〜 ${_fmtDateTime(_end)}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('やめる'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('予約する'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    try {
      final resv = await ref.read(reservationsRepositoryProvider).create(
            spotId: spot.spotId,
            start: _start,
            end: _end,
          );
      if (!mounted) return;
      final fee = resv.estimatedSlotFee;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('予約しました'),
          content: Text(fee == null ? '見込み料金は確定時に計算されます。' : '見込み料金 ¥$fee'),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('OK')),
          ],
        ),
      );
      if (!mounted) return;
      // 可否キャッシュを破棄して最新化し、ホームへ戻る。
      ref.invalidate(availabilityProvider);
      if (context.mounted) context.go('/');
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_reserveError(e))));
    }
  }

  /// 予約作成エラーを、code に応じた前向きな文言にする（画面設計「エラー UX」）。
  String _reserveError(ApiException e) {
    switch (e.code) {
      case 'conflict_overlap':
        return '直前に他の方が予約した可能性があります。別の時間帯をお試しください。';
      case 'conflict_buffer':
        return '前後の予約と間隔が近すぎます。時間をずらしてください。';
      case 'device_unhealthy':
        return 'この区画のデバイスが応答していません。別の区画をお試しください。';
      case 'not_found':
        return '区画が見つかりませんでした。';
      default:
        return e.message;
    }
  }
}

/// 開始日時＋所要時間の選択カード。
class _RangeSelector extends StatelessWidget {
  const _RangeSelector({
    required this.startLabel,
    required this.endLabel,
    required this.durationMin,
    required this.durations,
    required this.onPickStart,
    required this.onDurationChanged,
  });

  final String startLabel;
  final String endLabel;
  final int durationMin;
  final List<int> durations;
  final VoidCallback onPickStart;
  final ValueChanged<int> onDurationChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('開始日時'),
            subtitle: Text(startLabel),
            trailing: OutlinedButton.icon(
              onPressed: onPickStart,
              icon: const Icon(Icons.edit_calendar),
              label: const Text('変更'),
            ),
          ),
          Row(
            children: [
              const Text('所要時間'),
              const SizedBox(width: 16),
              DropdownButton<int>(
                value: durationMin,
                items: [
                  for (final m in durations)
                    DropdownMenuItem(value: m, child: Text('$m 分')),
                ],
                onChanged: (v) => v == null ? null : onDurationChanged(v),
              ),
              const Spacer(),
              Text('〜 $endLabel'),
            ],
          ),
        ],
      ),
    );
  }
}

/// 可否リスト。空きはタップで予約、その他は理由つきで非活性。
class _AvailabilityList extends StatelessWidget {
  const _AvailabilityList({required this.items, required this.onReserve});

  final List<SpotAvailability> items;
  final void Function(SpotAvailability spot) onReserve;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return const Center(child: Text('対象時間帯に区画がありません'));
    }
    return ListView.separated(
      itemCount: items.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final s = items[i];
        return ListTile(
          title: Text(s.name),
          subtitle: s.available ? null : Text(_reasonLabel(s.reason)),
          trailing: s.available
              ? const Chip(
                  label: Text('空き'),
                  backgroundColor: Color(0xFFE4F2EA),
                )
              : const Icon(Icons.block, color: Colors.grey),
          enabled: s.available,
          onTap: s.available ? () => onReserve(s) : null,
        );
      },
    );
  }

  String _reasonLabel(AvailabilityReason reason) {
    return switch (reason) {
      AvailabilityReason.reserved => '予約済み',
      AvailabilityReason.buffer => '前後の予約と間隔が近い',
      AvailabilityReason.deviceUnhealthy => 'デバイス応答なし',
      AvailabilityReason.ok => '空き',
      AvailabilityReason.unknown => '不可',
    };
  }
}

/// ローカル時刻を 'M/d HH:mm' で表示する（intl 非依存の簡易フォーマット）。
String _fmtDateTime(DateTime dt) {
  final l = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}
