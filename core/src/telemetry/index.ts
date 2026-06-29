/**
 * テレメトリ処理ドメインの公開バレル。
 *
 * functions（Event Hub トリガ）が消費する。entry/exit/up の受信→状態遷移→記録を担う（ADR 0005）。
 *
 * @module @parking/core/telemetry
 */

// バッチ取り込み（受信アダプタ共通ロジック・poison/再試行制御）
export * from './ingest.js';
// データアクセス（条件付き UPDATE 群）
export * from './repository.js';
// ユースケース（onEntry/onExit/onPlateUp）
export * from './service.js';
// テレメトリ型（TelemetryEvent / 各結果）
export * from './types.js';
// 入力バリデーション（unknown → TelemetryEvent）
export * from './validation.js';
