/// 予約状態（文字列）に対する表示ラベルと、詳細画面のアクション活性を判定する純粋関数群。
///
/// 対象は M3a で実装するアクション（キャンセル・DOWN）に限定する。
///
/// 画面設計「予約状態 × アクションの活性」表との差分（意図的・スライス範囲）:
/// - 利用終了・料金はバックエンド未実装のため対象外。
/// - **DOWN の再入庫（active/overstay 時の ○）は本スライス対象外**。`canGateDown` は `reserved`
///   のみ true にする（バックエンド `gateDown.service.ts` も現状 reserved のみ許可で、実装と整合）。
///   一時外出→再入庫は将来対応。
library;

/// 予約状態の表示ラベル（日本語）。未知値はそのまま返す。
String reservationStatusLabel(String status) {
  switch (status) {
    case 'reserved':
      return '予約済み';
    case 'active':
      return '利用中';
    case 'completed':
      return '完了';
    case 'cancelled':
      return 'キャンセル';
    case 'no_show':
      return 'ノーショー';
    case 'overstay':
      return '超過';
    default:
      return status;
  }
}

/// キャンセル可能か（reserved のみ・OpenAPI/処理一覧と一致）。
bool canCancel(String status) => status == 'reserved';

/// DOWN（入庫）指示が可能か。reserved かつ現在時刻が予約期間 [start, end] 内。
///
/// 「予約期間に入ってから活性」（画面設計 △）を前向きに制御し、409 invalid_state を極力出さない。
bool canGateDown({
  required String status,
  required DateTime now,
  required DateTime start,
  required DateTime end,
}) {
  if (status != 'reserved') return false;
  final n = now.toUtc();
  return !n.isBefore(start.toUtc()) && !n.isAfter(end.toUtc());
}
