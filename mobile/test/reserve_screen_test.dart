import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/core/api_exception.dart';
import 'package:mobile/src/reservations/reservation.dart';
import 'package:mobile/src/reservations/reservations_repository.dart';
import 'package:mobile/src/reservations/reserve_screen.dart';
import 'package:mobile/src/spots/spot_availability.dart';
import 'package:mobile/src/spots/spots_repository.dart';

/// availability を返すフェイク（Dio を叩かない）。items か error のいずれかで挙動を決める。
class FakeSpotsRepository extends SpotsRepository {
  FakeSpotsRepository({this.items, this.error}) : super(Dio());

  final List<SpotAvailability>? items;
  final ApiException? error;

  @override
  Future<List<SpotAvailability>> fetchAvailability(DateTime start, DateTime end) async {
    if (error != null) throw error!;
    return items ??
        const [
          SpotAvailability(
            spotId: 's1',
            name: 'A区画',
            available: true,
            reason: AvailabilityReason.ok,
          ),
          SpotAvailability(
            spotId: 's2',
            name: 'B区画',
            available: false,
            reason: AvailabilityReason.reserved,
          ),
        ];
  }
}

/// 予約作成のフェイク（呼び出し記録、または指定 ApiException を投げる）。
class FakeReservationsRepository extends ReservationsRepository {
  FakeReservationsRepository({this.throwError}) : super(Dio());

  final ApiException? throwError;
  String? createdSpotId;

  @override
  Future<Reservation> create({
    required String spotId,
    required DateTime start,
    required DateTime end,
  }) async {
    if (throwError != null) throw throwError!;
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
  Future<void> pump(
    WidgetTester tester, {
    required FakeSpotsRepository spotsRepo,
    required FakeReservationsRepository resvRepo,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          spotsRepositoryProvider.overrideWithValue(spotsRepo),
          reservationsRepositoryProvider.overrideWithValue(resvRepo),
        ],
        child: const MaterialApp(home: ReserveScreen()),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// A区画（空き）をタップして確認ダイアログの「予約する」を押すところまで進める。
  Future<void> tapReserveA(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(ListTile, 'A区画'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '予約する'));
    await tester.pumpAndSettle();
  }

  testWidgets('可否リストを表示し、空きは活性・不可は理由つき', (tester) async {
    await pump(tester, spotsRepo: FakeSpotsRepository(), resvRepo: FakeReservationsRepository());
    expect(find.text('A区画'), findsOneWidget);
    expect(find.text('B区画'), findsOneWidget);
    expect(find.text('予約済み'), findsOneWidget);
  });

  testWidgets('空き区画をタップ→確認→作成→見込み料金を表示', (tester) async {
    final resvRepo = FakeReservationsRepository();
    await pump(tester, spotsRepo: FakeSpotsRepository(), resvRepo: resvRepo);

    await tapReserveA(tester);

    expect(resvRepo.createdSpotId, 's1');
    expect(find.text('予約しました'), findsOneWidget);
    expect(find.textContaining('¥200'), findsOneWidget);
  });

  testWidgets('作成が409 conflict_buffer: 前向きな SnackBar 文言を出す', (tester) async {
    await pump(
      tester,
      spotsRepo: FakeSpotsRepository(),
      resvRepo: FakeReservationsRepository(
        throwError: ApiException(statusCode: 409, code: 'conflict_buffer', message: 'x'),
      ),
    );

    await tapReserveA(tester);

    expect(find.textContaining('間隔が近すぎます'), findsOneWidget);
  });

  testWidgets('作成が409 device_unhealthy: 別区画を促す SnackBar', (tester) async {
    await pump(
      tester,
      spotsRepo: FakeSpotsRepository(),
      resvRepo: FakeReservationsRepository(
        throwError: ApiException(statusCode: 409, code: 'device_unhealthy', message: 'x'),
      ),
    );

    await tapReserveA(tester);

    expect(find.textContaining('デバイスが応答していません'), findsOneWidget);
  });

  testWidgets('作成が404 not_found: 区画なしの SnackBar', (tester) async {
    await pump(
      tester,
      spotsRepo: FakeSpotsRepository(),
      resvRepo: FakeReservationsRepository(
        throwError: ApiException(statusCode: 404, code: 'not_found', message: 'x'),
      ),
    );

    await tapReserveA(tester);

    expect(find.textContaining('区画が見つかりませんでした'), findsOneWidget);
  });

  testWidgets('availability が空: プレースホルダを表示', (tester) async {
    await pump(
      tester,
      spotsRepo: FakeSpotsRepository(items: const []),
      resvRepo: FakeReservationsRepository(),
    );

    expect(find.text('対象時間帯に区画がありません'), findsOneWidget);
  });

  testWidgets('availability 取得エラー: メッセージを表示', (tester) async {
    await pump(
      tester,
      spotsRepo: FakeSpotsRepository(
        error: ApiException(statusCode: 401, code: 'unauthorized', message: '認証が必要です'),
      ),
      resvRepo: FakeReservationsRepository(),
    );

    expect(find.text('認証が必要です'), findsOneWidget);
  });
}
