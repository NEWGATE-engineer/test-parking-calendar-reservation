import { type TelemetryEvent, TelemetryService } from '@parking/core';
import { describe, expect, it } from 'vitest';
import { fakeTxRunner } from './helpers/mockReservationsRepo.js';
import {
  type CurrentReservation,
  type DeviceRow,
  makeMockTelemetryRepo,
  type OpenUsageForSpot,
} from './helpers/mockTelemetryRepo.js';

/** entry/exit/up テレメトリの土台。occurredAt は個別に上書きする。 */
function ev(type: TelemetryEvent['type'], occurredAt: string): TelemetryEvent {
  return {
    type,
    deviceId: 'dev-1',
    eventId: `evt-${type}-${occurredAt}`,
    occurredAt: new Date(occurredAt),
  };
}

const downDevice: DeviceRow = {
  device_id: 'dev-1',
  spot_id: 'spot-1',
  plate_position: 'down',
  last_seen_at: new Date('2026-06-25T10:00:00Z'),
};

const reservedResv: CurrentReservation = {
  id: 'resv-1',
  status: 'reserved',
  start_time: new Date('2026-06-25T10:00:00Z'),
  end_time: new Date('2026-06-25T11:00:00Z'),
};

const openUsage: OpenUsageForSpot = {
  usage_id: 'usage-1',
  reservation_id: 'resv-1',
  reservation_start: new Date('2026-06-25T10:00:00Z'),
  reservation_end: new Date('2026-06-25T11:00:00Z'),
  reservation_status: 'active',
};

describe('TelemetryService.handleEntry', () => {
  it('未登録デバイスは無視し副作用を起こさない', async () => {
    const repo = makeMockTelemetryRepo({ device: null });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleEntry(ev('entry', '2026-06-25T10:05:00Z'));
    expect(r.deviceFound).toBe(false);
    expect(repo.touchDevice).not.toHaveBeenCalled();
    expect(repo.setSpotOccupancy).not.toHaveBeenCalled();
  });

  it('初回入庫: UsageRecord 挿入・reserved→active・DeviceEvent(entry) を記録', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      currentReservation: reservedResv,
      hasOpenUsage: false,
      activateRows: 1,
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleEntry(ev('entry', '2026-06-25T10:05:00Z'));

    expect(r).toMatchObject({
      deviceFound: true,
      reservationId: 'resv-1',
      usageInserted: true,
      activated: true,
      eventRecorded: true,
    });
    expect(repo.setSpotOccupancy).toHaveBeenCalledWith(expect.anything(), 'spot-1', 'occupied');
    expect(repo.insertUsageEntry).toHaveBeenCalledTimes(1);
    expect(repo.activateReservation).toHaveBeenCalledTimes(1);
    expect(repo.insertDeviceEvent).toHaveBeenCalledTimes(1);
    expect(repo.insertDeviceEvent.mock.calls[0]?.[1]).toMatchObject({
      type: 'entry',
      reservationId: 'resv-1',
    });
  });

  it('再配信（open UsageRecord あり）: 二重挿入せず DeviceEvent も出さない', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      currentReservation: reservedResv,
      hasOpenUsage: true,
      activateRows: 0, // 既に active
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleEntry(ev('entry', '2026-06-25T10:06:00Z'));

    expect(r).toMatchObject({
      usageInserted: false,
      activated: false,
      eventRecorded: false,
    });
    expect(repo.insertUsageEntry).not.toHaveBeenCalled();
    expect(repo.insertDeviceEvent).not.toHaveBeenCalled();
  });

  it('予約なし入庫: occupancy=occupied にし監査 DeviceEvent(entry, resv=null) を残す', async () => {
    const repo = makeMockTelemetryRepo({ device: downDevice, currentReservation: null });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleEntry(ev('entry', '2026-06-25T10:05:00Z'));

    expect(r).toMatchObject({
      reservationId: null,
      usageInserted: false,
      activated: false,
      eventRecorded: true,
    });
    expect(repo.setSpotOccupancy).toHaveBeenCalledWith(expect.anything(), 'spot-1', 'occupied');
    expect(repo.insertUsageEntry).not.toHaveBeenCalled();
    expect(repo.insertDeviceEvent.mock.calls[0]?.[1]).toMatchObject({
      type: 'entry',
      reservationId: null,
    });
  });
});

describe('TelemetryService.handleExit', () => {
  it('未登録デバイスは無視', async () => {
    const repo = makeMockTelemetryRepo({ device: null });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z'));
    expect(r.deviceFound).toBe(false);
  });

  it('終了前の出庫: UsageRecord を閉じるが完了しない', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      openUsage,
      closeRows: 1,
      remainingOpen: 0,
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T10:30:00Z')); // end 11:00 前

    expect(r).toMatchObject({
      usageClosed: true,
      completed: false,
      feeInserted: false,
      eventRecorded: true,
    });
    expect(repo.completeReservation).not.toHaveBeenCalled();
    expect(repo.insertFee).not.toHaveBeenCalled();
  });

  it('終了後の出庫: completed 確定し Fee（枠＋超過）を INSERT', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      openUsage,
      closeRows: 1,
      remainingOpen: 0,
      completeRows: 1,
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z')); // end 11:00 を 30分超過

    expect(r).toMatchObject({ completed: true, feeInserted: true });
    expect(repo.insertFee).toHaveBeenCalledTimes(1);
    // slot: 60分/30=2単位*100=200。overstay: 30分/30=1単位*100=100。
    expect(repo.insertFee.mock.calls[0]?.[1]).toMatchObject({
      reservationId: 'resv-1',
      slotFee: 200,
      overstayFee: 100,
    });
  });

  it('終了後でも completeReservation が 0 件（タイマー autoComplete に競合負け）: Fee を INSERT しない', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      openUsage,
      closeRows: 1,
      remainingOpen: 0,
      completeRows: 0, // 先に autoComplete 等が completed にした＝条件付き UPDATE で負け
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z'));

    // UQ_Fee_resv 二重防止の核心: 勝者でないので Fee を作らない。
    expect(r).toMatchObject({ usageClosed: true, completed: false, feeInserted: false });
    expect(repo.completeReservation).toHaveBeenCalledTimes(1);
    expect(repo.insertFee).not.toHaveBeenCalled();
  });

  it('再配信（既に閉じている）: 何も確定せず DeviceEvent も出さない', async () => {
    const repo = makeMockTelemetryRepo({ device: downDevice, openUsage, closeRows: 0 });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z'));

    expect(r).toMatchObject({ usageClosed: false, completed: false, eventRecorded: false });
    expect(repo.insertDeviceEvent).not.toHaveBeenCalled();
    expect(repo.completeReservation).not.toHaveBeenCalled();
  });

  it('終了後でも他に open が残れば完了しない（一時外出中）', async () => {
    const repo = makeMockTelemetryRepo({
      device: downDevice,
      openUsage,
      closeRows: 1,
      remainingOpen: 1,
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z'));

    expect(r.completed).toBe(false);
    expect(repo.completeReservation).not.toHaveBeenCalled();
  });

  it('open 利用記録が無ければ閉じる対象なし', async () => {
    const repo = makeMockTelemetryRepo({ device: downDevice, openUsage: null });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handleExit(ev('exit', '2026-06-25T11:30:00Z'));
    expect(r).toMatchObject({ usageClosed: false, completed: false, eventRecorded: false });
  });
});

describe('TelemetryService.handlePlateUp', () => {
  it('未登録デバイスは無視', async () => {
    const repo = makeMockTelemetryRepo({ device: null });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handlePlateUp(ev('up', '2026-06-25T12:00:00Z'));
    expect(r.deviceFound).toBe(false);
  });

  it('down→up: 板を上げ DeviceEvent(up) を記録（last_occupancy は据え置き）', async () => {
    const repo = makeMockTelemetryRepo({ device: downDevice, raiseRows: 1 });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handlePlateUp(ev('up', '2026-06-25T12:00:00Z'));

    expect(r).toMatchObject({ raised: true, eventRecorded: true });
    // up は occupancy を変えない → touchDevice の第3引数は null
    expect(repo.touchDevice.mock.calls[0]?.[3]).toBeNull();
    expect(repo.insertDeviceEvent.mock.calls[0]?.[1]).toMatchObject({
      type: 'up',
      reservationId: null,
    });
  });

  it('既に up: 遷移せず DeviceEvent も出さない', async () => {
    const repo = makeMockTelemetryRepo({
      device: { ...downDevice, plate_position: 'up' },
      raiseRows: 0,
    });
    const svc = new TelemetryService(repo, fakeTxRunner);
    const r = await svc.handlePlateUp(ev('up', '2026-06-25T12:00:00Z'));

    expect(r).toMatchObject({ raised: false, eventRecorded: false });
    expect(repo.insertDeviceEvent).not.toHaveBeenCalled();
  });
});
