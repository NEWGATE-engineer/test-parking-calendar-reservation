import { describe, expect, it, vi } from 'vitest';
import {
  type DirectMethodInvoker,
  IotDeviceCommandPort,
} from '../src/reservations/iotDeviceCommandPort.js';

/**
 * IotDeviceCommandPort の写像ロジックを Azure なしで検証する。
 *
 * SDK 呼び出しは DirectMethodInvoker 越しに偽装し、成功 / timeout / 想定外 の各分岐が
 * DeviceCommandResult に正しく写像されることを確認する。
 */

const TIMEOUT = 15;

/** 指定の挙動をする偽 invoker を作る。 */
function makeInvoker(impl: DirectMethodInvoker['invoke']): DirectMethodInvoker {
  return { invoke: vi.fn(impl) };
}

/** 名前付きエラー（azure-iothub のエラー名を模す）を作る。 */
function namedError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('IotDeviceCommandPort.sendDown', () => {
  it('成功応答 status 200 → { ok: true }、契約どおりの引数で invoke する', async () => {
    const invoker = makeInvoker(async () => ({
      status: 200,
      payload: { ok: true, requestId: 'req-1', plate: 'down', replayed: false },
    }));
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    const result = await port.sendDown('device-1', 'req-1');

    expect(result).toEqual({ ok: true });
    // メソッド名 down・本文 { requestId }・タイムアウト秒数を渡している（device-sim 契約）
    expect(invoker.invoke).toHaveBeenCalledWith(
      'device-1',
      'down',
      { requestId: 'req-1' },
      TIMEOUT,
    );
  });

  it('応答待ちタイムアウト（GatewayTimeoutError）→ { ok: false, reason: timeout }', async () => {
    const invoker = makeInvoker(async () => {
      throw namedError('GatewayTimeoutError');
    });
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    await expect(port.sendDown('device-1', 'req-1')).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('デバイス未接続（DeviceNotFoundError）→ timeout に寄せる', async () => {
    const invoker = makeInvoker(async () => {
      throw namedError('DeviceNotFoundError');
    });
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    await expect(port.sendDown('device-1', 'req-1')).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('名前に Timeout を含むエラーも timeout 扱い', async () => {
    const invoker = makeInvoker(async () => {
      throw namedError('OperationTimeoutError');
    });
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    await expect(port.sendDown('device-1', 'req-1')).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('timeout 以外の SDK エラー（認証等）は握らず伝播する（→ 500）', async () => {
    const invoker = makeInvoker(async () => {
      throw namedError('UnauthorizedError', 'bad sas token');
    });
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    await expect(port.sendDown('device-1', 'req-1')).rejects.toThrow('bad sas token');
  });

  it('想定外の応答 status（200 以外）は契約違反として throw する', async () => {
    const invoker = makeInvoker(async () => ({
      status: 400,
      payload: { ok: false, reason: 'invalid_requestId' },
    }));
    const port = new IotDeviceCommandPort(invoker, TIMEOUT);

    await expect(port.sendDown('device-1', 'req-1')).rejects.toThrow(
      /想定外の status を返しました: 400/,
    );
  });
});
