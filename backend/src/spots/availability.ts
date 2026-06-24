/**
 * 満空表示・予約可否の純粋ロジック（DB に依存しない・要件 §8）。
 *
 * 予約作成（3b）の競合判定とも共有するため、副作用のない関数として切り出す。
 *
 * @module spots/availability
 */

/** availability の理由コード（OpenAPI SpotAvailability.reason と一致）。 */
export type AvailabilityReason = 'ok' | 'reserved' | 'buffer' | 'device_unhealthy';

/** 予約可否の判定結果。 */
export interface Availability {
  available: boolean;
  reason: AvailabilityReason;
}

/** 競合判定に使う予約の時間帯（status は呼び出し側で「有効な予約」に絞る）。 */
export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * デバイスが健全か（最終通信が閾値以内か）を判定する（§8）。
 *
 * @param lastSeenAt 最終通信日時。テレメトリ未受信なら `null`
 * @param thresholdMinutes 健全とみなす許容分数
 * @param now 現在時刻（テスト容易性のため引数で受ける）
 * @returns 健全なら `true`。`null` や閾値超過は `false`
 */
export function isDeviceHealthy(lastSeenAt: Date | null, thresholdMinutes: number, now: Date): boolean {
  if (lastSeenAt === null) return false;
  return lastSeenAt.getTime() >= now.getTime() - thresholdMinutes * 60_000;
}

/**
 * ある区画の、指定時間帯に対する予約可否を判定する。
 *
 * 優先順位: デバイス不健全 → 時間帯の重複（reserved）→ バッファ未満の近接（buffer）→ 可（ok）。
 * 「重複」はバッファ無しの素の重なり、「buffer」は重複しないがバッファ B 未満に隣接する状態。
 *
 * @param params.deviceHealthy デバイス健全性
 * @param params.window 希望時間帯
 * @param params.conflicts 同一区画の有効な予約（呼び出し側で cancelled/no_show を除外済み）
 * @param params.bufferMinutes バッファ時間 B（分）
 * @returns 予約可否と理由
 */
export function availabilityForSpot(params: {
  deviceHealthy: boolean;
  window: TimeWindow;
  conflicts: readonly TimeWindow[];
  bufferMinutes: number;
}): Availability {
  if (!params.deviceHealthy) return { available: false, reason: 'device_unhealthy' };

  const bufMs = params.bufferMinutes * 60_000;
  const ws = params.window.start.getTime();
  const we = params.window.end.getTime();
  let nearBuffer = false;

  for (const c of params.conflicts) {
    const cs = c.start.getTime();
    const ce = c.end.getTime();
    // 素の重なり（バッファ無し）: 既存の予約と時間が被っている → reserved
    if (cs < we && ws < ce) return { available: false, reason: 'reserved' };
    // バッファ近接: 既存予約を前後に B 分ずつ広げた区間 [cs-B, ce+B] が希望窓 [ws, we] と
    // 重なるか、で判定する（重なり自体は上で除外済みなので「近接」だけが残る）。
    //   前方向: 既存が希望 start の B 分以内に終わる（ws < ce + B）
    //   後方向: 既存が希望 end の B 分以内から始まる（cs - B < we）
    if (cs - bufMs < we && ws < ce + bufMs) nearBuffer = true;
  }

  if (nearBuffer) return { available: false, reason: 'buffer' };
  return { available: true, reason: 'ok' };
}
