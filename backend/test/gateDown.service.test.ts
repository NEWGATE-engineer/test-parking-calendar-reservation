import { describe, it, expect } from 'vitest';
import { GateDownService } from '../src/reservations/gateDown.service.js';
import {
  makeMockCommandLogRepo,
  mockDevicePortOk,
  mockDevicePortTimeout,
} from './helpers/mockGateDown.js';
import type { GateDownContext } from '../src/reservations/commandLog.repository.js';

const RID = 'req-1';

function ctx(overrides: Partial<GateDownContext> = {}): GateDownContext {
  return {
    status: 'reserved',
    start_time: new Date(Date.now() - 60 * 60_000),
    end_time: new Date(Date.now() + 60 * 60_000),
    spot_id: 'spot-1',
    occupancy: 'vacant',
    device_id: 'device-1',
    device_last_seen_at: new Date(),
    ...overrides,
  };
}

describe('GateDownService.execute', () => {
  it('正常系: 200・device 送信・CommandLog success', async () => {
    const repo = makeMockCommandLogRepo({ context: ctx() });
    const port = mockDevicePortOk();
    const res = await new GateDownService(repo, port).execute('user-1', 'resv-1', RID);

    expect(res).toEqual({ result: 'down', command_id: 'cmd-1' });
    expect(port.sendDown).toHaveBeenCalledWith('device-1', RID);
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'success');
  });

  it('予約が存在しない/他人は 404・INSERT しない', async () => {
    const repo = makeMockCommandLogRepo({ context: null });
    await expect(
      new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-x', RID),
    ).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
    expect(repo.insertPendingCommand).not.toHaveBeenCalled();
  });

  it('reserved 以外は 409 invalid_state・failure 更新・device 未送信', async () => {
    const repo = makeMockCommandLogRepo({ context: ctx({ status: 'active' }) });
    const port = mockDevicePortOk();
    await expect(
      new GateDownService(repo, port).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'invalid_state' });
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
    expect(port.sendDown).not.toHaveBeenCalled();
  });

  it('予約期間外（end 過去）は 409 invalid_state', async () => {
    const repo = makeMockCommandLogRepo({
      context: ctx({
        start_time: new Date(Date.now() - 120 * 60_000),
        end_time: new Date(Date.now() - 60 * 60_000), // 既に終了
      }),
    });
    await expect(
      new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'invalid_state' });
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  it('予約開始前（start 未来）は 409 invalid_state・device 未送信', async () => {
    const repo = makeMockCommandLogRepo({
      context: ctx({
        start_time: new Date(Date.now() + 60 * 60_000), // まだ開始前
        end_time: new Date(Date.now() + 120 * 60_000),
      }),
    });
    const port = mockDevicePortOk();
    await expect(
      new GateDownService(repo, port).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'invalid_state' });
    expect(port.sendDown).not.toHaveBeenCalled();
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  it('物理占有中は 409 physical_occupancy・device 未送信', async () => {
    const repo = makeMockCommandLogRepo({ context: ctx({ occupancy: 'occupied' }) });
    const port = mockDevicePortOk();
    await expect(
      new GateDownService(repo, port).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'physical_occupancy' });
    expect(port.sendDown).not.toHaveBeenCalled();
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  it('デバイス不健全（last_seen_at 古い）は 503・device 未送信', async () => {
    const repo = makeMockCommandLogRepo({
      context: ctx({ device_last_seen_at: new Date(Date.now() - 60 * 60_000) }),
    });
    const port = mockDevicePortOk();
    await expect(
      new GateDownService(repo, port).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 503, code: 'device_unhealthy' });
    expect(port.sendDown).not.toHaveBeenCalled();
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  it('デバイス未割当（device_id=null）も 503', async () => {
    const repo = makeMockCommandLogRepo({
      context: ctx({ device_id: null, device_last_seen_at: null }),
    });
    await expect(
      new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 503, code: 'device_unhealthy' });
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  it('デバイス無応答は 504 timeout（retryable）・failure 更新', async () => {
    const repo = makeMockCommandLogRepo({ context: ctx() });
    const port = mockDevicePortTimeout();
    await expect(
      new GateDownService(repo, port).execute('user-1', 'resv-1', RID),
    ).rejects.toMatchObject({ httpStatus: 504, code: 'timeout', retryable: true });
    expect(repo.updateCommandResult).toHaveBeenCalledWith('cmd-1', 'failure');
  });

  describe('冪等再送（同一 request_id）', () => {
    it('success 再送は同じ command_id で 200・device 再発火しない', async () => {
      const repo = makeMockCommandLogRepo({ existing: { id: 'cmd-orig', result: 'success' } });
      const port = mockDevicePortOk();
      const res = await new GateDownService(repo, port).execute('user-1', 'resv-1', RID);

      expect(res).toEqual({ result: 'down', command_id: 'cmd-orig' });
      // 既存ありなので INSERT も device 送信もしない
      expect(repo.insertPendingCommand).not.toHaveBeenCalled();
      expect(port.sendDown).not.toHaveBeenCalled();
    });

    it('pending 再送は 409 command_in_progress', async () => {
      const repo = makeMockCommandLogRepo({ existing: { id: 'cmd-orig', result: 'pending' } });
      await expect(
        new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-1', RID),
      ).rejects.toMatchObject({ httpStatus: 409, code: 'command_in_progress' });
    });

    it('failure 再送は 409 command_failed', async () => {
      const repo = makeMockCommandLogRepo({ existing: { id: 'cmd-orig', result: 'failure' } });
      await expect(
        new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-1', RID),
      ).rejects.toMatchObject({ httpStatus: 409, code: 'command_failed' });
    });

    it('並行 INSERT 衝突（inserted:false）も既存結果へ合流', async () => {
      // 0回目の findCommandByRequestId は null（既存なし）→ INSERT 衝突 → 再取得で success
      const repo = makeMockCommandLogRepo({
        context: ctx(),
        insert: { inserted: false },
        existing: null,
      });
      // findCommandByRequestId を「初回 null・2回目 success」に上書き
      let call = 0;
      repo.findCommandByRequestId = async () =>
        call++ === 0 ? null : { id: 'cmd-orig', result: 'success' };

      const res = await new GateDownService(repo, mockDevicePortOk()).execute('user-1', 'resv-1', RID);
      expect(res).toEqual({ result: 'down', command_id: 'cmd-orig' });
    });
  });
});
