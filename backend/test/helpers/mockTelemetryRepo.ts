import type {
  CurrentReservation,
  DeviceEventInput,
  DeviceRow,
  FeeInput,
  OpenUsageForSpot,
  TelemetryRepository,
  Tx,
} from '@parking/core';
import { vi } from 'vitest';

/**
 * {@link makeMockTelemetryRepo} の挙動を指定するオプション。
 * 省略時は「健全な正常系（デバイスあり・初回入庫・完了確定）」になるよう既定値を持つ。
 */
export interface MockTelemetryRepoOptions {
  /** findDeviceById が返す Device（null で「未登録デバイス」を表す）。 */
  device?: DeviceRow | null;
  /** findActiveReservationForSpotAt が返す現予約（null で「予約なし入庫」）。 */
  currentReservation?: CurrentReservation | null;
  /** hasOpenUsageRecord が返す値（既定 false＝open なし＝新規入庫）。 */
  hasOpenUsage?: boolean;
  /** findOpenUsageForSpot が返す open 利用記録（null で「対象なし」）。 */
  openUsage?: OpenUsageForSpot | null;
  /** countOpenUsageForReservation が返す残 open 件数（既定 0＝空車）。 */
  remainingOpen?: number;
  /** activateReservation の更新行数（既定 1＝reserved→active 成功）。 */
  activateRows?: number;
  /** closeUsageRecord の更新行数（既定 1＝閉じた）。 */
  closeRows?: number;
  /** completeReservation の更新行数（既定 1＝completed 確定）。 */
  completeRows?: number;
  /** raisePlate の更新行数（既定 1＝down→up）。 */
  raiseRows?: number;
}

/** vi.fn でラップした {@link TelemetryRepository}（呼び出し検証のため各 mock を露出）。 */
export type MockTelemetryRepo = {
  [K in keyof TelemetryRepository]: ReturnType<typeof vi.fn>;
} & TelemetryRepository;

/**
 * テスト用のインメモリ {@link TelemetryRepository}。
 *
 * @param options 各メソッドの振る舞い
 * @returns vi.fn でラップしたモック repo（`repo.insertFee.mock.calls` 等で検証できる）
 */
export function makeMockTelemetryRepo(options: MockTelemetryRepoOptions = {}): MockTelemetryRepo {
  const device = options.device === undefined ? defaultDevice() : options.device;
  const currentReservation =
    options.currentReservation === undefined ? defaultReservation() : options.currentReservation;
  const hasOpenUsage = options.hasOpenUsage ?? false;
  const openUsage = options.openUsage === undefined ? defaultOpenUsage() : options.openUsage;
  const remainingOpen = options.remainingOpen ?? 0;
  const activateRows = options.activateRows ?? 1;
  const closeRows = options.closeRows ?? 1;
  const completeRows = options.completeRows ?? 1;
  const raiseRows = options.raiseRows ?? 1;

  return {
    findDeviceById: vi.fn(
      (_tx: Tx, _deviceId: string): Promise<DeviceRow | null> => Promise.resolve(device),
    ),
    touchDevice: vi.fn((): Promise<void> => Promise.resolve()),
    setSpotOccupancy: vi.fn((): Promise<void> => Promise.resolve()),
    findActiveReservationForSpotAt: vi.fn(
      (_tx: Tx, _spotId: string, _at: Date): Promise<CurrentReservation | null> =>
        Promise.resolve(currentReservation),
    ),
    hasOpenUsageRecord: vi.fn((): Promise<boolean> => Promise.resolve(hasOpenUsage)),
    insertUsageEntry: vi.fn((): Promise<void> => Promise.resolve()),
    activateReservation: vi.fn((): Promise<number> => Promise.resolve(activateRows)),
    insertDeviceEvent: vi.fn(
      (_tx: Tx, _input: DeviceEventInput): Promise<void> => Promise.resolve(),
    ),
    findOpenUsageForSpot: vi.fn(
      (_tx: Tx, _spotId: string): Promise<OpenUsageForSpot | null> => Promise.resolve(openUsage),
    ),
    closeUsageRecord: vi.fn((): Promise<number> => Promise.resolve(closeRows)),
    countOpenUsageForReservation: vi.fn((): Promise<number> => Promise.resolve(remainingOpen)),
    completeReservation: vi.fn((): Promise<number> => Promise.resolve(completeRows)),
    insertFee: vi.fn((_tx: Tx, _input: FeeInput): Promise<void> => Promise.resolve()),
    raisePlate: vi.fn((): Promise<number> => Promise.resolve(raiseRows)),
  };
}

/** 既定の Device（板 down・健全）。 */
function defaultDevice(): DeviceRow {
  return {
    device_id: 'dev-1',
    spot_id: 'spot-1',
    plate_position: 'down',
    last_seen_at: new Date('2026-06-25T10:00:00Z'),
  };
}

/** 既定の現予約（active・10:00-11:00）。 */
function defaultReservation(): CurrentReservation {
  return {
    id: 'resv-1',
    status: 'active',
    start_time: new Date('2026-06-25T10:00:00Z'),
    end_time: new Date('2026-06-25T11:00:00Z'),
  };
}

/** 既定の open 利用記録（resv-1・10:00-11:00 枠）。 */
function defaultOpenUsage(): OpenUsageForSpot {
  return {
    usage_id: 'usage-1',
    reservation_id: 'resv-1',
    reservation_start: new Date('2026-06-25T10:00:00Z'),
    reservation_end: new Date('2026-06-25T11:00:00Z'),
    reservation_status: 'active',
  };
}
