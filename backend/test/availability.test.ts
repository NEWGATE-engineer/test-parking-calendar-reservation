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
  it('閾値ちょうど（境界値）は健全（>= 判定）', () => {
    expect(isDeviceHealthy(new Date(now.getTime() - 10 * 60_000), 10, now)).toBe(true);
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

  it('前方向: 既存が直前(09:55)に終わりバッファ未満なら buffer', () => {
    // 希望 10:00-11:00、既存 09:00-09:55（間隔5分 < 15分）。判定式は対称なので前方向も拾う
    const c = { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T09:55:00Z') };
    expect(availabilityForSpot({ ...base, conflicts: [c] })).toEqual({ available: false, reason: 'buffer' });
  });

  it('前方向: ちょうどバッファ分(15分)離れていれば ok（境界値）', () => {
    // 希望 10:00-11:00、既存 09:00-09:45（間隔15分ちょうど → ws < ce+bufMs が偽）
    const c = { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T09:45:00Z') };
    expect(availabilityForSpot({ ...base, conflicts: [c] })).toEqual({ available: true, reason: 'ok' });
  });

  it('buffer 近接と reserved が混在しても reserved が優先される（並び順に依存しない）', () => {
    const cBuffer = { start: new Date('2026-06-24T11:10:00Z'), end: new Date('2026-06-24T12:00:00Z') }; // 近接
    const cReserved = { start: new Date('2026-06-24T10:30:00Z'), end: new Date('2026-06-24T11:00:00Z') }; // 重複
    // buffer を先に並べても、重複(reserved)があれば reserved を返す
    expect(availabilityForSpot({ ...base, conflicts: [cBuffer, cReserved] })).toEqual({
      available: false,
      reason: 'reserved',
    });
  });
});
