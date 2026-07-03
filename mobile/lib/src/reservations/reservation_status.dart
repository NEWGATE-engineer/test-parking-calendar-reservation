/// 予約状態（文字列）に対する表示ラベルと、詳細画面のアクション活性を判定する純粋関数群。
///
/// 対象: キャンセル・DOWN（入庫）・利用終了・料金表示の活性判定。
///
/// 画面設計「予約状態 × アクションの活性」表との差分（意図的・実装範囲）:
/// - **利用終了**は active/overstay かつ **出庫済み（!in_car）** のときだけ活性（在車中は出さない・
///   grill で決めた「出庫後に押す」運用）。backend の finish は在車中でも受け付けるが UI は出さない。
/// - **DOWN の再入庫（active/overstay 時の ○）は未対応**。`canGateDown` は `reserved` のみ true
///   （backend `gateDown.service.ts` も現状 reserved のみ許可で整合）。一時外出→再入庫は将来対応。
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

/// 利用終了を申告できるか。active/overstay かつ **在車していない**（出庫済み）。
///
/// backend は在車中の finish も受け付けるが、モバイルは「出庫してから押す」運用にするため、
/// 在車中（in_car=true）はボタンを出さない（画面設計の活性表を in_car で精緻化）。
bool canFinish({required String status, required bool inCar}) {
  if (status != 'active' && status != 'overstay') return false;
  return !inCar;
}

/// 料金セクションを表示するか（完了時のみ確定額を出す）。完了前は予約の見込み額を別途表示する。
bool showsConfirmedFee(String status) => status == 'completed';

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
