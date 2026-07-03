import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/reservations/reservation_status.dart';

/// 状態ラベルとアクション活性（状態×アクション表）の純粋関数を検証する。
void main() {
  test('reservationStatusLabel: 主要状態を日本語化・未知はそのまま', () {
    expect(reservationStatusLabel('reserved'), '予約済み');
    expect(reservationStatusLabel('active'), '利用中');
    expect(reservationStatusLabel('overstay'), '超過');
    expect(reservationStatusLabel('weird'), 'weird');
  });

  test('canCancel: reserved のみ true', () {
    expect(canCancel('reserved'), true);
    expect(canCancel('active'), false);
    expect(canCancel('completed'), false);
  });

  group('canGateDown', () {
    final start = DateTime.utc(2026, 7, 2, 10);
    final end = DateTime.utc(2026, 7, 2, 11);

    test('reserved かつ期間内 → true', () {
      final now = DateTime.utc(2026, 7, 2, 10, 30);
      expect(canGateDown(status: 'reserved', now: now, start: start, end: end), true);
    });

    test('期間前 → false', () {
      final now = DateTime.utc(2026, 7, 2, 9, 59);
      expect(canGateDown(status: 'reserved', now: now, start: start, end: end), false);
    });

    test('期間後 → false', () {
      final now = DateTime.utc(2026, 7, 2, 11, 1);
      expect(canGateDown(status: 'reserved', now: now, start: start, end: end), false);
    });

    test('reserved 以外は期間内でも false', () {
      final now = DateTime.utc(2026, 7, 2, 10, 30);
      expect(canGateDown(status: 'active', now: now, start: start, end: end), false);
    });

    test('境界: now == start / now == end は閉区間で true', () {
      expect(canGateDown(status: 'reserved', now: start, start: start, end: end), true);
      expect(canGateDown(status: 'reserved', now: end, start: start, end: end), true);
    });
  });

  group('canFinish', () {
    test('active/overstay かつ 出庫済み（!inCar）→ true', () {
      expect(canFinish(status: 'active', inCar: false), true);
      expect(canFinish(status: 'overstay', inCar: false), true);
    });
    test('在車中（inCar）は false（出庫してから押す運用）', () {
      expect(canFinish(status: 'active', inCar: true), false);
      expect(canFinish(status: 'overstay', inCar: true), false);
    });
    test('reserved/completed/cancelled は false', () {
      expect(canFinish(status: 'reserved', inCar: false), false);
      expect(canFinish(status: 'completed', inCar: false), false);
      expect(canFinish(status: 'cancelled', inCar: false), false);
    });
  });

  test('showsConfirmedFee: completed のみ true', () {
    expect(showsConfirmedFee('completed'), true);
    expect(showsConfirmedFee('active'), false);
    expect(showsConfirmedFee('reserved'), false);
  });
}
