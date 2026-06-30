import type { TelemetryEvent, TelemetryResult } from './types.js';
import { parseTelemetryEvent } from './validation.js';

/**
 * テレメトリのバッチ取り込み（受信アダプタ共通ロジック）。
 *
 * functions（Event Hub トリガ）の薄いハンドラから切り出した純粋オーケストレーション。
 * Azure に依存しないので core に置き、DB なし・Functions ランタイムなしで単体テストできる
 * （functions/telemetry.ts はこれを呼ぶだけのトリガ配線になる）。
 *
 * @module telemetry/ingest
 */

/** 取り込み時のログ出力先（functions の InvocationContext が構造的に適合する）。 */
export interface TelemetryLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** {@link processTelemetryBatch} が呼ぶサービスの最小形（テストで偽サービスに差し替え可能）。 */
export interface TelemetryHandler {
  handle(ev: TelemetryEvent): Promise<TelemetryResult>;
}

/**
 * メッセージ配列を 1 件ずつ検証・処理する。
 *
 * - **poison メッセージ**（形不正で {@link parseTelemetryEvent} が throw）: warn ログを出して
 *   読み飛ばす（throw しない＝Functions の再試行を起こさない。再試行しても直らないため）。
 * - **一時障害**（service.handle が throw＝DB 接続失敗・デッドロック等）: error ログの後 **throw** し、
 *   Functions の再試行に委ねる。IoT Hub は at-least-once でサービスは冪等なので再処理は安全。
 *
 * @param messages Event Hub から受け取った生メッセージ群（JSON パース済みオブジェクト想定）
 * @param service テレメトリ処理サービス（{@link TelemetryHandler}）
 * @param logger ログ出力先
 * @throws service.handle が投げた一時障害（DB 等）。バッチを中断し Functions に再試行させる
 */
export async function processTelemetryBatch(
  messages: unknown[],
  service: TelemetryHandler,
  logger: TelemetryLogger,
): Promise<void> {
  for (const raw of messages) {
    let ev: TelemetryEvent;
    try {
      ev = parseTelemetryEvent(raw);
    } catch (err) {
      // poison メッセージ: 破棄（再試行しても無駄）。
      logger.warn(`不正なテレメトリを破棄: ${(err as Error).message}`);
      continue;
    }

    try {
      const result = await service.handle(ev);
      logger.log(`telemetry handled: ${JSON.stringify({ eventId: ev.eventId, ...result })}`);
    } catch (err) {
      // 一時障害は再試行に委ねる（冪等なので再処理は安全）。
      logger.error(
        `telemetry 処理失敗（再試行されます） eventId=${ev.eventId} type=${ev.type}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
