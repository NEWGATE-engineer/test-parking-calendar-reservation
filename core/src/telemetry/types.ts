/**
 * テレメトリ処理のドメイン型。
 *
 * device-sim（AUTOSTAND 疑似デバイス）が送る entry / exit / up テレメトリを、functions
 * （Event Hub トリガ）が受けて core のサービスに渡す。メッセージ契約の正本は
 * device-sim/README.md。ここはその受信側の型定義。
 *
 * @module telemetry/types
 */

/** テレメトリ種別（device-sim の契約と一致）。 */
export const TELEMETRY_TYPES = ['entry', 'exit', 'up'] as const;

/** テレメトリ種別。entry=在車検知 / exit=空車検知 / up=UP 実行。 */
export type TelemetryType = (typeof TELEMETRY_TYPES)[number];

/**
 * パース済みのテレメトリイベント（device-sim/README.md の契約に対応）。
 *
 * `occurredAt` は ISO 文字列を Date に変換済み。`eventId` は at-least-once 配信の
 * 識別子（MVP では冪等化はドメイン条件で行うため未使用だが、観測・将来強化のため保持）。
 */
export interface TelemetryEvent {
  type: TelemetryType;
  deviceId: string;
  eventId: string;
  /** イベント発生時刻（UTC）。 */
  occurredAt: Date;
}

/** onEntry の処理結果（ログ・テスト用）。 */
export interface EntryResult {
  /** deviceId に対応する Device 行が見つかったか（false=不明デバイスで無視）。 */
  deviceFound: boolean;
  /** 対応づいた予約 ID（予約なし入庫なら null）。 */
  reservationId: string | null;
  /** UsageRecord(entry) を新規 INSERT したか（再配信・再入庫では false）。 */
  usageInserted: boolean;
  /** reserved→active 遷移が起きたか（初回入庫のみ true）。 */
  activated: boolean;
  /** DeviceEvent(entry) を記録したか。 */
  eventRecorded: boolean;
}

/** onExit の処理結果（ログ・テスト用）。 */
export interface ExitResult {
  deviceFound: boolean;
  reservationId: string | null;
  /** open だった UsageRecord に exit_time を入れて閉じたか（再配信では false）。 */
  usageClosed: boolean;
  /** 予約を completed に確定したか。 */
  completed: boolean;
  /** Fee を INSERT したか（completed と同時のみ）。 */
  feeInserted: boolean;
  eventRecorded: boolean;
}

/** onPlateUp の処理結果（ログ・テスト用）。 */
export interface PlateUpResult {
  deviceFound: boolean;
  /** plate_position を down→up に遷移させたか（既に up なら false）。 */
  raised: boolean;
  eventRecorded: boolean;
}

/** ディスパッチ {@link "telemetry/service".TelemetryService.handle} の結果（種別タグ付き）。 */
export type TelemetryResult =
  | ({ kind: 'entry' } & EntryResult)
  | ({ kind: 'exit' } & ExitResult)
  | ({ kind: 'up' } & PlateUpResult);
