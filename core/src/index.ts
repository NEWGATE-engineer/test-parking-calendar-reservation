/**
 * `@parking/core` の公開エントリ。
 *
 * Azure / Express / IoT に依存しないドメイン層をまとめて公開する。
 * backend（Express）も functions（IoT/Timer トリガ）も、ここから同じ
 * 設定・DB アクセス・トランザクション・ドメイン例外を import する。
 * 「現在状態を WHERE に含めた条件付き UPDATE」など本 PJ の状態遷移規約を
 * 1 箇所に集約し、実行環境ごとの再実装によるドリフトを防ぐ（ADR 0004）。
 *
 * @module @parking/core
 */

// アプリ設定（環境変数 → 型付き定数）
export * from './config.js';
// SQL 接続プール・SERIALIZABLE トランザクション・Tx/TxRunner 型
export * from './db.js';
// ドメイン例外 AppError と Error スキーマ・生成ショートカット
export * from './errors.js';
// 予約ドメイン（repository / service / fee / validation / gate-down）
export * from './reservations/index.js';
// 区画ドメイン（repository / service / availability / validation）
export * from './spots/index.js';
