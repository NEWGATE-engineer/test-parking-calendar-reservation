import { app, type InvocationContext } from '@azure/functions';
import { parseTelemetryEvent, SqlTelemetryRepository, TelemetryService } from '@parking/core';

/**
 * IoT Hub テレメトリ受信（onEntryDetected / onExitDetected / onPlateUp）。
 *
 * IoT Hub の組み込みイベントエンドポイント（Event Hub 互換）を Event Hub トリガで受け、
 * device-sim/README.md の契約（entry/exit/up）に従ってドメイン処理を呼ぶ。ドメインロジックと
 * 冪等化・状態遷移はすべて `@parking/core` の {@link TelemetryService} が持ち（ADR 0005）、
 * この関数は「受信→検証→ディスパッチ→ログ」に徹する薄いアダプタ。CommandLog には触らない（論点D）。
 *
 * @module functions/telemetry
 */

// サービスはモジュールスコープで 1 度だけ生成し、ウォーム間で再利用する
// （DB プールは core 側でシングルトン管理。コールドスタートのコストを抑える）。
const service = new TelemetryService(new SqlTelemetryRepository());

/**
 * Event Hub トリガ本体。`cardinality: 'many'` でメッセージ配列を受け取り 1 件ずつ処理する。
 *
 * - 形が不正な poison メッセージ: 再試行しても直らないので**ログのみで読み飛ばす**（throw しない）。
 * - DB 等の一時障害: **throw** して Functions の再試行に委ねる。IoT Hub は at-least-once で、
 *   サービスはドメイン条件で冪等なので、バッチ全体が再処理されても安全。
 *
 * @param messages Event Hub から受け取ったメッセージ群（JSON パース済みオブジェクト）
 * @param context Functions 実行コンテキスト（ログ）
 */
export async function onTelemetry(messages: unknown[], context: InvocationContext): Promise<void> {
  for (const raw of messages) {
    let ev: ReturnType<typeof parseTelemetryEvent>;
    try {
      ev = parseTelemetryEvent(raw);
    } catch (err) {
      // poison メッセージ: 破棄（再試行しても無駄）。
      context.warn(`不正なテレメトリを破棄: ${(err as Error).message}`);
      continue;
    }

    try {
      const result = await service.handle(ev);
      context.log(`telemetry handled: ${JSON.stringify({ eventId: ev.eventId, ...result })}`);
    } catch (err) {
      // 一時障害は再試行に委ねる（冪等なので再処理は安全）。
      context.error(
        `telemetry 処理失敗（再試行されます） eventId=${ev.eventId} type=${ev.type}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}

app.eventHub('onTelemetry', {
  // App Settings: IoT Hub の「組み込みエンドポイント（Event Hub 互換）」接続文字列の設定名。
  connection: 'IOT_HUB_EVENTS',
  // 同エンドポイントの Event Hub 名（messages/events）。バインディング式で App Settings から解決。
  eventHubName: '%IOT_HUB_EVENT_HUB_NAME%',
  cardinality: 'many',
  handler: onTelemetry,
});
