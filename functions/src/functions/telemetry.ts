import { app, type InvocationContext } from '@azure/functions';
import { processTelemetryBatch, SqlTelemetryRepository, TelemetryService } from '@parking/core';

/**
 * IoT Hub テレメトリ受信（onEntryDetected / onExitDetected / onPlateUp）。
 *
 * IoT Hub の組み込みイベントエンドポイント（Event Hub 互換）を Event Hub トリガで受け、
 * device-sim/README.md の契約（entry/exit/up）に従ってドメイン処理を呼ぶ。検証・冪等化・
 * 状態遷移・poison/再試行制御はすべて `@parking/core`（{@link TelemetryService} /
 * {@link processTelemetryBatch}）が持ち（ADR 0005）、この関数は Event Hub トリガの配線に徹する。
 * CommandLog には触らない（論点D）。
 *
 * @module functions/telemetry
 */

// サービスはモジュールスコープで 1 度だけ生成し、ウォーム間で再利用する
// （DB プールは core 側でシングルトン管理。コールドスタートのコストを抑える）。
const service = new TelemetryService(new SqlTelemetryRepository());

/**
 * Event Hub トリガ本体。`cardinality: 'many'` でメッセージ配列を受け取り core へ委譲する。
 * poison は読み飛ばし・一時障害は throw（再試行）—判断ロジックは processTelemetryBatch 側。
 *
 * @param messages Event Hub から受け取ったメッセージ群（JSON パース済みオブジェクト）
 * @param context Functions 実行コンテキスト（log/warn/error が TelemetryLogger に適合）
 */
export async function onTelemetry(messages: unknown[], context: InvocationContext): Promise<void> {
  await processTelemetryBatch(messages, service, context);
}

app.eventHub('onTelemetry', {
  // App Settings: IoT Hub の「組み込みエンドポイント（Event Hub 互換）」接続文字列の設定名。
  connection: 'IOT_HUB_EVENTS',
  // 同エンドポイントの Event Hub 名（messages/events）。バインディング式で App Settings から解決。
  eventHubName: '%IOT_HUB_EVENT_HUB_NAME%',
  cardinality: 'many',
  handler: onTelemetry,
});
