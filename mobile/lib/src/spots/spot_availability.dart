/// 予約可否の理由（OpenAPI SpotAvailability.reason・Error.code と語彙をそろえる）。
enum AvailabilityReason {
  /// 予約可能。
  ok,

  /// 時間帯が既存予約と重複。
  reserved,

  /// 前後予約とのバッファ不足。
  buffer,

  /// デバイス不健全（最終通信が古い）。
  deviceUnhealthy,

  /// 未知（前方互換のフォールバック）。
  unknown,
}

/// 対象時間帯の区画ごとの予約可否（OpenAPI SpotAvailability・best-effort）。
class SpotAvailability {
  const SpotAvailability({
    required this.spotId,
    required this.name,
    required this.available,
    required this.reason,
  });

  final String spotId;
  final String name;
  final bool available;
  final AvailabilityReason reason;

  factory SpotAvailability.fromJson(Map<String, dynamic> json) {
    return SpotAvailability(
      spotId: json['spot_id'] as String,
      name: json['name'] as String? ?? '',
      available: json['available'] as bool? ?? false,
      reason: _parseReason(json['reason'] as String?),
    );
  }

  static AvailabilityReason _parseReason(String? raw) {
    switch (raw) {
      case 'ok':
        return AvailabilityReason.ok;
      case 'reserved':
        return AvailabilityReason.reserved;
      case 'buffer':
        return AvailabilityReason.buffer;
      case 'device_unhealthy':
        return AvailabilityReason.deviceUnhealthy;
      default:
        return AvailabilityReason.unknown;
    }
  }
}
