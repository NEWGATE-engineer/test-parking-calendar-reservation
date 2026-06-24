import { describe, it, expect } from 'vitest';
import { SpotsService } from '../src/spots/service.js';
import { makeMockSpotsRepo } from './helpers/mockSpotsRepo.js';
import type { SpotWithDevice } from '../src/spots/repository.js';

function spot(id: string, occupancy: string, lastSeenAt: Date | null): SpotWithDevice {
  return { id, name: `spot-${id}`, occupancy, last_seen_at: lastSeenAt };
}

describe('SpotsService.listSpots', () => {
  it('健全なデバイスは保存値の occupancy を返す', async () => {
    const repo = makeMockSpotsRepo([spot('1', 'occupied', new Date())]);
    const [view] = await new SpotsService(repo).listSpots();
    expect(view).toMatchObject({ id: '1', occupancy: 'occupied', device_healthy: true });
  });

  it('不健全なデバイスは occupancy=unknown・device_healthy=false', async () => {
    // last_seen_at が1時間前（閾値10分超）
    const repo = makeMockSpotsRepo([spot('2', 'vacant', new Date(Date.now() - 60 * 60_000))]);
    const [view] = await new SpotsService(repo).listSpots();
    expect(view).toMatchObject({ id: '2', occupancy: 'unknown', device_healthy: false });
  });

  it('デバイス未割当（last_seen_at=null）も unknown', async () => {
    const repo = makeMockSpotsRepo([spot('3', 'vacant', null)]);
    const [view] = await new SpotsService(repo).listSpots();
    expect(view?.occupancy).toBe('unknown');
  });
});

describe('SpotsService.getAvailability', () => {
  const start = new Date('2026-06-24T10:00:00Z');
  const end = new Date('2026-06-24T11:00:00Z');

  it('健全＋競合なしは ok', async () => {
    const repo = makeMockSpotsRepo([spot('1', 'vacant', new Date())]);
    const [a] = await new SpotsService(repo).getAvailability(start, end);
    expect(a).toMatchObject({ spot_id: '1', available: true, reason: 'ok' });
  });

  it('重複予約がある区画は reserved', async () => {
    const repo = makeMockSpotsRepo(
      [spot('1', 'vacant', new Date())],
      [{ spot_id: '1', start_time: new Date('2026-06-24T10:30:00Z'), end_time: new Date('2026-06-24T12:00:00Z') }],
    );
    const [a] = await new SpotsService(repo).getAvailability(start, end);
    expect(a).toMatchObject({ spot_id: '1', available: false, reason: 'reserved' });
  });

  it('不健全な区画は device_unhealthy（予約有無に関わらず）', async () => {
    const repo = makeMockSpotsRepo([spot('1', 'vacant', new Date(Date.now() - 60 * 60_000))]);
    const [a] = await new SpotsService(repo).getAvailability(start, end);
    expect(a?.reason).toBe('device_unhealthy');
  });

  it('他区画の conflict は同区画に影響しない（bySpot Map の分離）', async () => {
    const repo = makeMockSpotsRepo(
      [spot('A', 'vacant', new Date()), spot('B', 'vacant', new Date())],
      // spot A のみ重複予約あり、B には無し
      [{ spot_id: 'A', start_time: new Date('2026-06-24T10:30:00Z'), end_time: new Date('2026-06-24T12:00:00Z') }],
    );
    const results = await new SpotsService(repo).getAvailability(start, end);
    const a = results.find((r) => r.spot_id === 'A');
    const b = results.find((r) => r.spot_id === 'B');
    expect(a?.reason).toBe('reserved');
    expect(b?.reason).toBe('ok'); // B へ誤適用されていない
  });

  it('findActiveReservationsInWindow に start/end と config のバッファ分を渡す', async () => {
    const repo = makeMockSpotsRepo([spot('1', 'vacant', new Date())]);
    await new SpotsService(repo).getAvailability(start, end);
    // 第3引数は config.reservation.bufferMinutes（既定 仮15分）
    expect(repo.findActiveReservationsInWindow).toHaveBeenCalledWith(start, end, 15);
  });
});
