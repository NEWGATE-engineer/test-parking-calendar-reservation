/**
 * 区画ドメインの公開バレル。
 *
 * repository（データアクセス）・service（空満ビュー）・availability（空満判定の
 * 純粋ロジック）・validation（クエリパース）を 1 箇所から re-export する（ADR 0004）。
 *
 * @module @parking/core/spots
 */

// 空満判定・デバイス健全性の純粋ロジック
export * from './availability.js';
// 区画の永続化と型
export * from './repository.js';
// 区画ユースケース（一覧・空満ビュー）
export * from './service.js';
// 空満クエリのバリデーション
export * from './validation.js';
