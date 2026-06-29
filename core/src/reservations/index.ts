/**
 * 予約ドメインの公開バレル。
 *
 * repository（データアクセス）・service（ユースケース）・fee（料金算出）・
 * validation（入力パース／ドメイン表明）・gate-down（ロック板 DOWN 指示）の
 * 各モジュールを 1 箇所から re-export する。backend（Express ルーター）も
 * functions（IoT/Timer トリガ）も、ここを経由して同じドメイン実装を使う（ADR 0004）。
 *
 * @module @parking/core/reservations
 */

// ロック板 DOWN 指示の冪等記録（CommandLog）
export * from './commandLog.repository.js';
// デバイス指示ポート interface（IoT 実装を抽象化）
export * from './deviceCommandPort.js';
// 料金算出（純粋関数）
export * from './fee.js';
// gate-down ユースケース
export * from './gateDown.service.js';
// gate-down 入力バリデーション
export * from './gateDown.validation.js';
// 予約の永続化（条件付き UPDATE・SERIALIZABLE 競合チェック）と型
export * from './repository.js';
// 予約ユースケース（作成・変更・キャンセル・一覧）
export * from './service.js';
// 入力バリデーション（HTTP 入力 unknown → 型付き）とドメイン表明
export * from './validation.js';
