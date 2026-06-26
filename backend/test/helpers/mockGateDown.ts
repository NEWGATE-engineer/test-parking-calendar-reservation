import { vi } from 'vitest';
import type {
  CommandLogRepository,
  CommandResult,
  GateDownContext,
  InsertPendingResult,
} from '../../src/reservations/commandLog.repository.js';
import type {
  DeviceCommandPort,
  DeviceCommandResult,
} from '../../src/reservations/deviceCommandPort.js';

/** {@link makeMockCommandLogRepo} の挙動を指定するオプション。 */
export interface MockCommandLogOptions {
  /** findGateDownContext が返すコンテキスト（null で不在/他人＝404。既定は健全・reserved・空車）。 */
  context?: GateDownContext | null;
  /** insertPendingCommand の戻り（既定 inserted:true・commandId='cmd-1'）。 */
  insert?: InsertPendingResult;
  /** findCommandByRequestId の戻り（冪等再送テスト用。既定 null＝既存なし）。 */
  existing?: { id: string; result: CommandResult } | null;
}

/** 既定のコンテキスト（reserved・期間内・空車・健全デバイス）。 */
function defaultContext(): GateDownContext {
  return {
    status: 'reserved',
    start_time: new Date(Date.now() - 60 * 60_000), // 1時間前開始
    end_time: new Date(Date.now() + 60 * 60_000), // 1時間後終了（期間内）
    spot_id: 'spot-1',
    occupancy: 'vacant',
    device_id: 'device-1',
    device_last_seen_at: new Date(), // 健全
  };
}

/**
 * テスト用のインメモリ {@link CommandLogRepository}。
 *
 * `findCommandByRequestId` は「最初の呼び出しは options.existing、以降は更新を反映」する
 * 単純なモック。冪等再送は existing を渡して検証する。
 */
export function makeMockCommandLogRepo(options: MockCommandLogOptions = {}): CommandLogRepository {
  const context = options.context === undefined ? defaultContext() : options.context;
  const insert: InsertPendingResult = options.insert ?? { inserted: true, commandId: 'cmd-1' };
  const existing = options.existing ?? null;

  return {
    findGateDownContext: vi.fn((): Promise<GateDownContext | null> => Promise.resolve(context)),
    insertPendingCommand: vi.fn((): Promise<InsertPendingResult> => Promise.resolve(insert)),
    findCommandByRequestId: vi.fn(
      (): Promise<{ id: string; result: CommandResult } | null> => Promise.resolve(existing),
    ),
    updateCommandResult: vi.fn((): Promise<number> => Promise.resolve(1)),
  };
}

/** DOWN 成功を返す DeviceCommandPort モック。 */
export function mockDevicePortOk(): DeviceCommandPort {
  return { sendDown: vi.fn((): Promise<DeviceCommandResult> => Promise.resolve({ ok: true })) };
}

/** DOWN タイムアウトを返す DeviceCommandPort モック。 */
export function mockDevicePortTimeout(): DeviceCommandPort {
  return {
    sendDown: vi.fn(
      (): Promise<DeviceCommandResult> => Promise.resolve({ ok: false, reason: 'timeout' }),
    ),
  };
}
