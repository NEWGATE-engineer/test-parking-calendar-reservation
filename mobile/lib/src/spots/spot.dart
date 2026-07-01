/// 区画の満空状況（OpenAPI の Occupancy）。`unknown` は最終通信が古い（健全性 NG）場合。
enum Occupancy { occupied, vacant, unknown }

/// 駐車区画と現在の満空（OpenAPI の Spot）。
class Spot {
  const Spot({
    required this.id,
    required this.name,
    required this.occupancy,
    required this.deviceHealthy,
  });

  final String id;
  final String name;
  final Occupancy occupancy;

  /// デバイスが健全か（最終通信が閾値以内）。false は予約可否にも影響する。
  final bool deviceHealthy;

  factory Spot.fromJson(Map<String, dynamic> json) {
    return Spot(
      id: json['id'] as String,
      name: json['name'] as String? ?? '',
      occupancy: _parseOccupancy(json['occupancy'] as String?),
      deviceHealthy: json['device_healthy'] as bool? ?? false,
    );
  }

  /// 未知の文字列は `unknown` に丸める（サーバの enum 追加に対する前方互換）。
  static Occupancy _parseOccupancy(String? raw) {
    switch (raw) {
      case 'occupied':
        return Occupancy.occupied;
      case 'vacant':
        return Occupancy.vacant;
      default:
        return Occupancy.unknown;
    }
  }
}
