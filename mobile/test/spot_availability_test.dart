import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/src/spots/spot_availability.dart';

/// SpotAvailability.fromJson の変換（reason マッピング・未知値の丸め）を検証する。
void main() {
  test('available=true / reason=ok', () {
    final s = SpotAvailability.fromJson(
      {'spot_id': 's1', 'name': 'A', 'available': true, 'reason': 'ok'},
    );
    expect(s.spotId, 's1');
    expect(s.available, true);
    expect(s.reason, AvailabilityReason.ok);
  });

  test('reason の各値をマッピングする', () {
    AvailabilityReason r(String reason) =>
        SpotAvailability.fromJson({'spot_id': 'x', 'available': false, 'reason': reason}).reason;
    expect(r('reserved'), AvailabilityReason.reserved);
    expect(r('buffer'), AvailabilityReason.buffer);
    expect(r('device_unhealthy'), AvailabilityReason.deviceUnhealthy);
  });

  test('未知 reason は unknown に丸める（前方互換）', () {
    final s = SpotAvailability.fromJson(
      {'spot_id': 'x', 'available': false, 'reason': 'brand_new'},
    );
    expect(s.reason, AvailabilityReason.unknown);
  });
}
