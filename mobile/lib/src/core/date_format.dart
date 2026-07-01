/// 時刻表示の共通フォーマット。
///
/// UTC 保存の `DateTime` をローカルに変換し 'M/d HH:mm' で表示する（intl 非依存）。
/// 一覧・詳細・予約作成で共有し、表示フォーマットの実装を1箇所に集約する。
library;

/// ローカル時刻を 'M/d HH:mm' で表示する。
String formatLocalDateTime(DateTime dt) {
  final l = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.month}/${l.day} ${two(l.hour)}:${two(l.minute)}';
}
