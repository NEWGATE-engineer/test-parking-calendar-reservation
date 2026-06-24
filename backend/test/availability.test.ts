import { describe, it, expect } from 'vitest';
import { isDeviceHealthy, availabilityForSpot } from '../src/spots/availability.js';

const now = new Date('2026-06-24T00:00:00Z');
const window = { start: new Date('2026-06-24T10:00:00Z'), end: new Date('2026-06-24T11:00:00Z') };

describe('isDeviceHealthy', () => {
  it('null（テレメトリ未受信）は不健全', () => {
    expect(isDeviceHealthy(null, 10, now)).toBe(false);
  });
  it('閾値以内は健全', () => {
    expect(isDeviceHealthy(new Date(now.getTime() - 5 * 60_000), 10, now)).toBe(true);
  });
  it('閾値超過は不健全', () => {
    expect(isDeviceHealthy(new Date(now.getTime() - 20 * 60_000), 10, now)).toBe(false);
  });
});

describe('availabilityForSpot', () => {
  const base = { deviceHealthy: true, window, bufferMinutes: 15 };

  it('デバイス不健全は device_unhealthy（予約より優先）', () => {
    expect(availabilityForSpot({ ...base, deviceHealthy: false, conflicts: [] })).toEqual({
      available: false,
      reason: 'device_unhealthy',
    });
  });

  it('競合なしは ok', () => {
    expect(availabilityForSpot({ ...base, conflicts: [] })).toEqual({ available: true, reason: 'ok' });
  });

  it('時間帯が重複すれば reserved', () => {
    const c = { start: new Date('2026-06-24T10:30:00Z'), end: new Date('2026-06-24T12:00:00Z') };
    expect(availabilityForSpot({ ...base, conflicts: [c] })).toEqual({ available: false, reason: 'reserved' });
  });

  it('重ならないがバッファ(15分)未満に近接すれば buffer', () => {
    // 希望 10:00-11:00、既存 11:10-12:00（間隔10分 < 15分）
    const c = { start: new Date('2026-06-24T11:10:00Z'), end: new Date('2026-06-24T12:00:00Z') };
    expect(availabilityForSpot({ ...base, conflicts: [c] })).toEqual({ available: false, reason: 'buffer' });
  });

  it('バッファ以上離れていれば ok', () => {
    // 希望 10:00-11:00、既存 11:20-12:00（間隔20分 > 15分）
    const c = { start: new Date('2026-06-24T11:20:00Z'), end: new Date('2026-06-24T12:00:00Z') };
    expect(availabilityForSpot({ ...base, conflicts: [c] })).toEqual({ available: true, reason: 'ok' });
  });
});
