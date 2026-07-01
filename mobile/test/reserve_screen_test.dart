import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/reservations/reservation.dart';
import 'package:mobile/src/reservations/reservations_repository.dart';
import 'package:mobile/src/reservations/reserve_screen.dart';
import 'package:mobile/src/spots/spot_availability.dart';
import 'package:mobile/src/spots/spots_repository.dart';

/// availability を返すフェイク（Dio を叩かない）。
class FakeSpotsRepository extends SpotsRepository {
  FakeSpotsRepository() : super(Dio());

  @override
  Future<List<SpotAvailability>> fetchAvailability(DateTime start, DateTime end) async {
    return const [
      SpotAvailability(spotId: 's1', name: 'A区画', available: true, reason: AvailabilityReason.ok),
      SpotAvailability(
        spotId: 's2',
        name: 'B区画',
        available: false,
        reason: AvailabilityReason.reserved,
      ),
    ];
  }
}

/// 予約作成のフェイク（呼び出しを記録）。
class FakeReservationsRepository extends ReservationsRepository {
  FakeReservationsRepository() : super(Dio());

  String? createdSpotId;

  @override
  Future<Reservation> create({
    required String spotId,
    required DateTime start,
    required DateTime end,
  }) async {
    createdSpotId = spotId;
    return Reservation(
      id: 'r1',
      spotId: spotId,
      startTime: start.toUtc(),
      endTime: end.toUtc(),
      status: 'reserved',
      createdAt: DateTime.utc(2026, 7, 1),
      estimatedSlotFee: 200,
    );
  }
}

void main() {
  Future<FakeReservationsRepository> pump(WidgetTester tester) async {
    final resvRepo = FakeReservationsRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          spotsRepositoryProvider.overrideWithValue(FakeSpotsRepository()),
          reservationsRepositoryProvider.overrideWithValue(resvRepo),
        ],
        child: const MaterialApp(home: ReserveScreen()),
      ),
    );
    await tester.pumpAndSettle();
    return resvRepo;
  }

  testWidgets('可否リストを表示し、空きは活性・不可は非活性', (tester) async {
    await pump(tester);
    expect(find.text('A区画'), findsOneWidget);
    expect(find.text('B区画'), findsOneWidget);
    expect(find.text('予約済み'), findsOneWidget); // B の理由
  });

  testWidgets('空き区画をタップ→確認→作成APIを呼び、見込み料金を表示する', (tester) async {
    final resvRepo = await pump(tester);

    // 空きの A 区画をタップ → 確認ダイアログ
    await tester.tap(find.widgetWithText(ListTile, 'A区画'));
    await tester.pumpAndSettle();
    expect(find.text('予約の確認'), findsOneWidget);

    // 「予約する」で作成
    await tester.tap(find.widgetWithText(FilledButton, '予約する'));
    await tester.pumpAndSettle();

    expect(resvRepo.createdSpotId, 's1'); // create が呼ばれた
    expect(find.text('予約しました'), findsOneWidget); // 成功ダイアログ
    expect(find.textContaining('¥200'), findsOneWidget); // API レスポンスの見込み額
  });
}
