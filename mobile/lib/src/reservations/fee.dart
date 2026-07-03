/// 料金（OpenAPI Fee）。完了時に確定、未確定なら status=pending。
///
/// 時刻は UTC。表示側でローカルへ変換する。
class Fee {
  const Fee({
    required this.reservationId,
    required this.slotFee,
    required this.overstayFee,
    required this.total,
    required this.status,
    this.calculatedAt,
  });

  final String reservationId;
  final num slotFee;
  final num overstayFee;
  final num total;

  /// 'pending'（確定待ち）/ 'confirmed'（確定）。
  final String status;

  /// 確定時刻（UTC）。未確定なら null。
  final DateTime? calculatedAt;

  /// 確定済みか。
  bool get isConfirmed => status == 'confirmed';

  factory Fee.fromJson(Map<String, dynamic> json) {
    final calc = json['calculated_at'];
    return Fee(
      reservationId: json['reservation_id'] as String,
      slotFee: json['slot_fee'] as num? ?? 0,
      overstayFee: json['overstay_fee'] as num? ?? 0,
      total: json['total'] as num? ?? 0,
      status: json['status'] as String? ?? 'pending',
      calculatedAt: calc is String ? DateTime.parse(calc) : null,
    );
  }
}
