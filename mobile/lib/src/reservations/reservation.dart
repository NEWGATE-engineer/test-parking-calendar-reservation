/// 予約（OpenAPI ReservationResponse）。
///
/// 時刻は UTC で受け取り、`DateTime`（UTC）として保持する。表示側で JST/ローカルへ変換する。
class Reservation {
  const Reservation({
    required this.id,
    required this.spotId,
    required this.startTime,
    required this.endTime,
    required this.status,
    required this.createdAt,
    this.estimatedSlotFee,
  });

  final String id;
  final String spotId;

  /// 予約開始（UTC）。
  final DateTime startTime;

  /// 予約終了（UTC）。
  final DateTime endTime;

  /// 予約状態（reserved/active/completed/cancelled/no_show/overstay）。M2 では文字列で保持。
  final String status;

  final DateTime createdAt;

  /// 予約枠の見込み額（作成・変更時に返る。確定額は Fee）。null あり。
  final num? estimatedSlotFee;

  factory Reservation.fromJson(Map<String, dynamic> json) {
    return Reservation(
      id: json['id'] as String,
      spotId: json['spot_id'] as String,
      startTime: DateTime.parse(json['start_time'] as String),
      endTime: DateTime.parse(json['end_time'] as String),
      status: json['status'] as String? ?? 'reserved',
      createdAt: DateTime.parse(json['created_at'] as String),
      estimatedSlotFee: json['estimated_slot_fee'] as num?,
    );
  }
}
