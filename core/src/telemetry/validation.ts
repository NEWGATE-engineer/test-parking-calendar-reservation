/**
 * テレメトリメッセージのバリデーション（unknown → 型付き TelemetryEvent）。
 *
 * functions（Event Hub トリガ）が受け取る生メッセージは信頼できない unknown。
 * ここで形を検証し、不正なら {@link validationError}（422）を投げる。HTTP には依存しない
 * 純粋関数なので core に置く（reservations/validation と同方針）。
 *
 * @module telemetry/validation
 */

import { validationError } from '../errors.js';
import { TELEMETRY_TYPES, type TelemetryEvent, type TelemetryType } from './types.js';

/**
 * 生のテレメトリメッセージを検証して {@link TelemetryEvent} に変換する。
 *
 * @param raw Event Hub から受け取った JSON（パース済みオブジェクト想定）
 * @returns 検証済みのテレメトリイベント
 * @throws {AppError} 422 `validation_error` — 形・型・値が不正（type 不明・deviceId 空・
 *   occurredAt が日時として解釈不能・eventId 欠落 など）
 */
export function parseTelemetryEvent(raw: unknown): TelemetryEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw validationError('テレメトリは JSON オブジェクトである必要があります');
  }
  const o = raw as Record<string, unknown>;

  const type = o['type'];
  if (typeof type !== 'string' || !TELEMETRY_TYPES.includes(type as TelemetryType)) {
    throw validationError('type は entry / exit / up のいずれかである必要があります');
  }

  const deviceId = o['deviceId'];
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw validationError('deviceId は非空文字列である必要があります');
  }

  const eventId = o['eventId'];
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw validationError('eventId は非空文字列である必要があります');
  }

  const occurredAtRaw = o['occurredAt'];
  if (typeof occurredAtRaw !== 'string') {
    throw validationError('occurredAt は ISO 8601 文字列である必要があります');
  }
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    throw validationError('occurredAt を日時として解釈できません');
  }

  return { type: type as TelemetryType, deviceId, eventId, occurredAt };
}
