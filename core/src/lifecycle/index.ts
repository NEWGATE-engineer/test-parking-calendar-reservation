/**
 * 予約ライフサイクル定期走査（タイマー）の公開バレル。
 *
 * functions（タイマートリガ）からは `@parking/core` 経由でこのモジュールを使う。
 *
 * @module lifecycle
 */
// FeeInput は telemetry バレルと同名・同形のため公開しない（衝突回避。repo 実装/モックは
// LifecycleRepository の構造的型付けで足りる）。
export {
  type CompletableReservation,
  type LifecycleRepository,
  SqlLifecycleRepository,
} from './repository.js';
export { LifecycleService, type SweepResult } from './service.js';
