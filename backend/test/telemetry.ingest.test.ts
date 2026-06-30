import {
  processTelemetryBatch,
  type TelemetryEvent,
  type TelemetryHandler,
  type TelemetryLogger,
  type TelemetryResult,
} from '@parking/core';
import { describe, expect, it, vi } from 'vitest';

/** 妥当な entry メッセージ。 */
function validRaw(eventId = 'evt-1'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'entry',
    deviceId: 'dev-1',
    eventId,
    occurredAt: '2026-06-25T10:00:00.000Z',
  };
}

/** 何が起きたか観測できる偽ロガー。 */
function makeLogger(): TelemetryLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as TelemetryLogger & {
    log: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** handle を差し替えられる偽サービス。 */
function makeService(impl?: (ev: TelemetryEvent) => Promise<TelemetryResult>): TelemetryHandler & {
  handle: ReturnType<typeof vi.fn>;
} {
  const handle = vi.fn(
    impl ??
      ((): Promise<TelemetryResult> =>
        Promise.resolve({
          kind: 'entry',
          deviceFound: true,
          reservationId: 'resv-1',
          usageInserted: true,
          activated: true,
          eventRecorded: true,
        })),
  );
  return { handle };
}

describe('processTelemetryBatch', () => {
  it('正常メッセージは service.handle を呼び log する', async () => {
    const service = makeService();
    const logger = makeLogger();
    await processTelemetryBatch([validRaw()], service, logger);

    expect(service.handle).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('poison メッセージは warn して読み飛ばす（throw せず service も呼ばない）', async () => {
    const service = makeService();
    const logger = makeLogger();
    // type 不正 → parseTelemetryEvent が throw
    await expect(
      processTelemetryBatch([{ type: 'bogus' }], service, logger),
    ).resolves.toBeUndefined();

    expect(service.handle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('poison と正常が混在しても後続の正常メッセージは処理される', async () => {
    const service = makeService();
    const logger = makeLogger();
    await processTelemetryBatch([{ bad: true }, validRaw('evt-2')], service, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1); // poison 1 件
    expect(service.handle).toHaveBeenCalledTimes(1); // 正常 1 件は処理
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('一時障害（service.handle が throw）は error ログの後 re-throw する', async () => {
    const boom = new Error('DB 接続失敗');
    const service = makeService(() => Promise.reject(boom));
    const logger = makeLogger();

    await expect(processTelemetryBatch([validRaw()], service, logger)).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
