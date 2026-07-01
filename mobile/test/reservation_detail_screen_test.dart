import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/reservations/reservation.dart';
import 'package:mobile/src/reservations/reservation_detail_screen.dart';
import 'package:mobile/src/reservations/reservations_repository.dart';

/// 予約一覧を返し、cancel/gateDown を記録するフェイク。
class FakeReservationsRepository extends ReservationsRepository {
  FakeReservationsRepository(this.list, {this.gateDownError}) : super(Dio());

  final List<Reservation> list;
  final ApiException? gateDownError;
  bool cancelCalled = false;
  String? gateDownRequestId;

  @override
  Future<List<Reservation>> fetchReservations() async => list;

  @override
  Future<void> cancel(String id) async {
    cancelCalled = true;
  }

  @override
  Future<GateDownResult> gateDown({required String id, required String requestId}) async {
    gateDownRequestId = requestId;
    if (gateDownError != null) throw gateDownError!;
    return const GateDownResult(commandId: 'cmd-1');
  }
}

/// reserved かつ現在が期間内の予約（gate-down 活性）。
Reservation reservedInPeriod() {
  final now = DateTime.now();
  return Reservation(
    id: 'r1',
    spotId: 's1',
    startTime: now.subtract(const Duration(minutes: 10)),
    endTime: now.add(const Duration(minutes: 50)),
    status: 'reserved',
    createdAt: now,
  );
}

void main() {
  Future<FakeReservationsRepository> pump(
    WidgetTester tester,
    FakeReservationsRepository repo,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [reservationsRepositoryProvider.overrideWithValue(repo)],
        child: const MaterialApp(home: ReservationDetailScreen(id: 'r1')),
      ),
    );
    await tester.pumpAndSettle();
    return repo;
  }

  testWidgets('予約情報と状態を表示する', (tester) async {
    await pump(tester, FakeReservationsRepository([reservedInPeriod()]));
    expect(find.text('予約済み'), findsOneWidget);
    expect(find.text('s1'), findsOneWidget);
  });

  testWidgets('キャンセル: 確認→cancel API を呼ぶ', (tester) async {
    final repo = await pump(tester, FakeReservationsRepository([reservedInPeriod()]));

    await tester.tap(find.widgetWithText(OutlinedButton, '予約をキャンセル'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'キャンセルする'));
    await tester.pumpAndSettle();

    expect(repo.cancelCalled, true);
  });

  testWidgets('入庫（DOWN）: gate-down を request_id つきで呼び、入庫待ち表示になる', (tester) async {
    final repo = await pump(tester, FakeReservationsRepository([reservedInPeriod()]));

    await tester.tap(find.widgetWithText(FilledButton, '入庫する（DOWN）'));
    await tester.pump(); // 非同期開始
    await tester.pump(); // gateDown 完了＋setState

    expect(repo.gateDownRequestId, isNotNull); // UUID を採番して送信
    expect(find.textContaining('入庫を確認しています'), findsOneWidget);

    // ポーリングタイマーを破棄（dispose でキャンセル）してテストを終える。
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('入庫が device_unhealthy: エラー SnackBar を出しポーリングしない', (tester) async {
    final repo = await pump(
      tester,
      FakeReservationsRepository(
        [reservedInPeriod()],
        gateDownError: ApiException(statusCode: 503, code: 'device_unhealthy', message: 'x'),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '入庫する（DOWN）'));
    await tester.pump();
    await tester.pump();

    expect(repo.gateDownRequestId, isNotNull);
    expect(find.textContaining('デバイスが応答していません'), findsOneWidget);
    expect(find.textContaining('入庫を確認しています'), findsNothing);
  });

  testWidgets('入庫が invalid_state: 予約時間内かの案内 SnackBar', (tester) async {
    await pump(
      tester,
      FakeReservationsRepository(
        [reservedInPeriod()],
        gateDownError: ApiException(statusCode: 409, code: 'invalid_state', message: 'x'),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '入庫する（DOWN）'));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('DOWN 指示できません'), findsOneWidget);
  });

  testWidgets('入庫が command_in_progress: 処理中の SnackBar', (tester) async {
    await pump(
      tester,
      FakeReservationsRepository(
        [reservedInPeriod()],
        gateDownError: ApiException(statusCode: 409, code: 'command_in_progress', message: 'x'),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '入庫する（DOWN）'));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('処理中です'), findsOneWidget);
  });

  testWidgets('入庫待ちが上限で打ち切られ、確認できなかった旨を表示', (tester) async {
    await pump(tester, FakeReservationsRepository([reservedInPeriod()]));

    await tester.tap(find.widgetWithText(FilledButton, '入庫する（DOWN）'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('入庫を確認しています'), findsOneWidget);

    // 仮想時間を tick ごとに進める（2分/3秒=40 tick 超で打ち切り）。active には決してならない。
    for (var i = 0; i < 41; i++) {
      await tester.pump(const Duration(seconds: 3));
    }
    await tester.pump();

    expect(find.textContaining('入庫が確認できませんでした'), findsOneWidget);
  });

  testWidgets('キャンセルの確認で「やめる」→ API を呼ばない', (tester) async {
    final repo = await pump(tester, FakeReservationsRepository([reservedInPeriod()]));

    await tester.tap(find.widgetWithText(OutlinedButton, '予約をキャンセル'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'やめる'));
    await tester.pumpAndSettle();

    expect(repo.cancelCalled, false);
  });

  testWidgets('一覧に対象IDが無い（ディープリンク等）→ 見つからない表示', (tester) async {
    await pump(tester, FakeReservationsRepository([])); // r1 を含まない
    expect(find.textContaining('予約が見つかりませんでした'), findsOneWidget);
  });
}
