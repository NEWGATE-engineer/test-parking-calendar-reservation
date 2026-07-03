import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/reservations/fee.dart';
import 'package:mobile/src/reservations/reservation.dart';
import 'package:mobile/src/reservations/reservation_detail_screen.dart';
import 'package:mobile/src/reservations/reservations_repository.dart';

/// 予約一覧を返し、cancel/gateDown/finish/fee を記録・差し替えるフェイク。
/// finish 後は一覧の該当予約を更新後の値に差し替え、実際の状態遷移（再描画）を模倣する。
class FakeReservationsRepository extends ReservationsRepository {
  FakeReservationsRepository(
    this._list, {
    this.gateDownError,
    this.fee,
    this.feeError,
    this.feeCompleter,
    this.finishError,
    this.finishResult,
  }) : super(Dio());

  final List<Reservation> _list;
  final ApiException? gateDownError;

  /// fetchFee が返す料金（completed の詳細で使う）。
  final Fee? fee;

  /// fetchFee が投げるエラー（error 分岐の検証）。
  final ApiException? feeError;

  /// 未完了の Completer を渡すと fetchFee がそれを待つ（loading 分岐の検証）。
  final Completer<Fee>? feeCompleter;

  /// finish が投げるエラー（失敗系の検証）。
  final ApiException? finishError;

  /// finish が返す更新後予約（既定は completed）。
  final Reservation? finishResult;

  bool cancelCalled = false;
  String? gateDownRequestId;
  bool finishCalled = false;

  @override
  Future<List<Reservation>> fetchReservations() async => _list;

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

  @override
  Future<Reservation> finish(String id) async {
    finishCalled = true;
    if (finishError != null) throw finishError!;
    final updated = finishResult ??
        Reservation(
          id: id,
          spotId: 's1',
          startTime: DateTime.utc(2026, 7, 2, 1),
          endTime: DateTime.utc(2026, 7, 2, 1, 30),
          status: 'completed',
          createdAt: DateTime.utc(2026, 7, 1),
          estimatedSlotFee: 100,
        );
    // 実際の状態遷移を模倣: 次の fetchReservations は更新後（completed）を返す。
    final i = _list.indexWhere((r) => r.id == id);
    if (i >= 0) _list[i] = updated;
    return updated;
  }

  @override
  Future<Fee> fetchFee(String id) async {
    if (feeError != null) throw feeError!;
    if (feeCompleter != null) return feeCompleter!.future;
    return fee ??
        const Fee(
          reservationId: 'r1',
          slotFee: 200,
          overstayFee: 100,
          total: 300,
          status: 'confirmed',
        );
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

  // --- 利用終了（finish）---

  Reservation active({required bool inCar}) => Reservation(
        id: 'r1',
        spotId: 's1',
        startTime: DateTime.now().subtract(const Duration(minutes: 30)),
        endTime: DateTime.now().add(const Duration(minutes: 30)),
        status: 'active',
        createdAt: DateTime.now(),
        inCar: inCar,
      );

  testWidgets('出庫済み active（!in_car）→ 利用終了ボタンを表示', (tester) async {
    await pump(tester, FakeReservationsRepository([active(inCar: false)]));
    expect(find.widgetWithText(FilledButton, '利用を終了する'), findsOneWidget);
  });

  testWidgets('在車中 active（in_car）→ 利用終了ボタンは出さない', (tester) async {
    await pump(tester, FakeReservationsRepository([active(inCar: true)]));
    expect(find.widgetWithText(FilledButton, '利用を終了する'), findsNothing);
  });

  testWidgets('利用終了: 確認→finish→完了メッセージ＋画面が完了状態へ再描画', (tester) async {
    final repo = await pump(tester, FakeReservationsRepository([active(inCar: false)]));

    await tester.tap(find.widgetWithText(FilledButton, '利用を終了する'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '利用終了'));
    await tester.pumpAndSettle();

    expect(repo.finishCalled, true);
    expect(find.textContaining('料金が確定しました'), findsOneWidget);
    // invalidate 後の再取得で completed に遷移 → ボタンが消え、確定料金が出る
    expect(find.widgetWithText(FilledButton, '利用を終了する'), findsNothing);
    expect(find.text('料金（確定）'), findsOneWidget);
  });

  testWidgets('利用終了が not_finishable: エラー SnackBar・ボタンは残る（再試行可）', (tester) async {
    final repo = await pump(
      tester,
      FakeReservationsRepository(
        [active(inCar: false)],
        finishError: ApiException(statusCode: 409, code: 'not_finishable', message: 'x'),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '利用を終了する'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '利用終了'));
    await tester.pumpAndSettle();

    expect(repo.finishCalled, true);
    expect(find.textContaining('利用終了できません'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '利用を終了する'), findsOneWidget); // busy 解除で残る
  });

  testWidgets('利用終了がネットワーク等の一般エラー: message を表示', (tester) async {
    await pump(
      tester,
      FakeReservationsRepository(
        [active(inCar: false)],
        finishError: ApiException(statusCode: null, code: 'network', message: '通信に失敗しました'),
      ),
    );

    await tester.tap(find.widgetWithText(FilledButton, '利用を終了する'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '利用終了'));
    await tester.pumpAndSettle();

    expect(find.textContaining('通信に失敗しました'), findsOneWidget);
  });

  // --- 料金表示 ---

  Reservation completed() => Reservation(
        id: 'r1',
        spotId: 's1',
        startTime: DateTime.utc(2026, 7, 2, 1),
        endTime: DateTime.utc(2026, 7, 2, 2),
        status: 'completed',
        createdAt: DateTime.utc(2026, 7, 1),
      );

  testWidgets('完了予約: 確定料金（枠＋超過＝total）を表示', (tester) async {
    await pump(tester, FakeReservationsRepository([completed()]));
    await tester.pumpAndSettle(); // feeProvider の解決

    expect(find.text('料金（確定）'), findsOneWidget);
    expect(find.text('¥300'), findsOneWidget);
  });

  testWidgets('完了予約: fee 取得失敗 → 取得できませんでした', (tester) async {
    await pump(
      tester,
      FakeReservationsRepository(
        [completed()],
        feeError: ApiException(statusCode: 404, code: 'not_found', message: 'x'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('取得できませんでした'), findsOneWidget);
  });

  testWidgets('完了予約: fee 取得中はスピナー', (tester) async {
    // スピナーは無限アニメで pumpAndSettle が止まらないため、ここでは pump ヘルパーを使わず手動 pump。
    final gate = Completer<Fee>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          reservationsRepositoryProvider.overrideWithValue(
            FakeReservationsRepository([completed()], feeCompleter: gate),
          ),
        ],
        child: const MaterialApp(home: ReservationDetailScreen(id: 'r1')),
      ),
    );
    await tester.pump(); // reservationsProvider 解決
    await tester.pump(); // feeProvider は loading（gate 未完了）

    expect(find.byType(CircularProgressIndicator), findsWidgets);

    // 後片付け: 完了させて settle（保留 Future を残さない）。
    gate.complete(
      const Fee(reservationId: 'r1', slotFee: 200, overstayFee: 0, total: 200, status: 'confirmed'),
    );
    await tester.pumpAndSettle();
  });

  testWidgets('完了前: 見込み額（予約枠）を表示', (tester) async {
    final reserved = Reservation(
      id: 'r1',
      spotId: 's1',
      startTime: DateTime.now().add(const Duration(hours: 1)),
      endTime: DateTime.now().add(const Duration(hours: 2)),
      status: 'reserved',
      createdAt: DateTime.now(),
      estimatedSlotFee: 200,
    );
    await pump(tester, FakeReservationsRepository([reserved]));

    expect(find.text('料金（見込み）'), findsOneWidget);
    expect(find.text('¥200'), findsOneWidget);
  });
}
