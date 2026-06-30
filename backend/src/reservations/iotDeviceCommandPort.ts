import { config, type DeviceCommandPort, type DeviceCommandResult } from '@parking/core';
import { Client } from 'azure-iothub';

/**
 * IoT Hub ダイレクトメソッドによる {@link DeviceCommandPort} 実装（IoT 連携スライス c）。
 *
 * gate-down サービスが投げる DOWN 指示を、IoT Hub の **`down` ダイレクトメソッド**として
 * 実デバイス（または device-sim）へ送る。メッセージ契約（メソッド名・本文・応答）は
 * `device-sim/README.md` を source of truth とし、それに一致させる。
 *
 * 設計上の要点（ADR 0006）:
 * - **core を Azure 非依存に保つ**ため、port interface は core に置き、実装（azure-iothub 依存）は
 *   backend に置く。backend は App Service にデプロイされるため Azure SDK に依存してよい。
 * - **写像ロジックを Azure なしで単体テスト可能**にするため、SDK 呼び出しを {@link DirectMethodInvoker}
 *   越しに隠す。本番は {@link createIotDeviceCommandPort} が azure-iothub の Client を注入し、
 *   テストは偽 invoker を注入して 成功 / timeout / 想定外 の分岐を検証する。
 *
 * @module reservations/iotDeviceCommandPort
 */

/** DOWN ダイレクトメソッド名（device-sim/README のメッセージ契約 §2）。 */
const DOWN_METHOD = 'down';

/**
 * ダイレクトメソッド呼び出しの最小シグネチャ（azure-iothub への依存をここに隔離する）。
 *
 * 実装は「完了応答の `{status, payload}` を resolve」し、**無応答・未接続・ゲートウェイ
 * タイムアウト**は error を throw する。この境界のおかげで {@link IotDeviceCommandPort} の
 * 写像ロジックは Azure SDK を import せずにテストできる。
 */
export interface DirectMethodInvoker {
  /**
   * 指定デバイスのダイレクトメソッドを呼ぶ。
   *
   * @param deviceId 対象デバイス識別子（Device.device_id）
   * @param methodName メソッド名（DOWN は `down`）
   * @param payload メソッド本文（DOWN は `{ requestId }`）
   * @param timeoutSeconds 応答待ち／接続タイムアウト秒数
   * @returns デバイスの完了応答（HTTP 風 status とアプリ本文）
   * @throws デバイス無応答・未接続・ゲートウェイタイムアウト、その他の SDK エラー
   */
  invoke(
    deviceId: string,
    methodName: string,
    payload: unknown,
    timeoutSeconds: number,
  ): Promise<{ status: number; payload: unknown }>;
}

/**
 * azure-iothub による {@link DeviceCommandPort} 実装。
 */
export class IotDeviceCommandPort implements DeviceCommandPort {
  /**
   * @param invoker ダイレクトメソッド呼び出し（本番は azure-iothub・テストは偽物）
   * @param timeoutSeconds 応答待ちタイムアウト秒数
   */
  constructor(
    private readonly invoker: DirectMethodInvoker,
    private readonly timeoutSeconds: number,
  ) {}

  /**
   * デバイスへ DOWN 指示を送る。
   *
   * 結果の写像（{@link DeviceCommandResult} は `ok:true` か `timeout` のみ表現）:
   * - 完了応答 status `200` → `{ ok: true }`。
   * - **無応答・未接続・ゲートウェイタイムアウト** → `{ ok: false, reason: 'timeout' }`（→ 504 retryable）。
   *   「接続ありで無応答」も「未接続」も、利用者から見れば再試行で回復し得る一過性失敗なので timeout に寄せる。
   * - それ以外（想定外の status・認証/設定不備など）→ 例外を伝播（→ 500）。正常系では起きない契約違反。
   *
   * @param deviceId 対象デバイス識別子
   * @param requestId 冪等キー（本文 `{ requestId }` として送る。デバイス側の二重発火防止に使う）
   * @returns 成功 or タイムアウト
   * @throws 想定外の応答 status や、timeout 以外の SDK エラー
   */
  async sendDown(deviceId: string, requestId: string): Promise<DeviceCommandResult> {
    try {
      const res = await this.invoker.invoke(
        deviceId,
        DOWN_METHOD,
        { requestId },
        this.timeoutSeconds,
      );
      // 成功は status 200（契約）。backend は常に UUID を送るため 400 invalid_requestId は
      // 正常系で来ない。200 以外は契約違反として想定外扱い（→ 500）にする。
      if (res.status === 200) return { ok: true };
      throw new Error(`DOWN ダイレクトメソッドが想定外の status を返しました: ${res.status}`);
    } catch (err) {
      // 無応答・未接続は一過性失敗とみなし 504 retryable へ寄せる。
      if (isTimeoutLike(err)) return { ok: false, reason: 'timeout' };
      // 認証・設定不備などはバグ/運用不備なので握らず伝播させる。
      throw err;
    }
  }
}

/**
 * タイムアウト相当（無応答・未接続）の Azure IoT エラーかどうかをエラー名で判定する。
 *
 * azure-iothub は応答待ちタイムアウトを `GatewayTimeoutError`、デバイス未接続を
 * `DeviceNotFoundError` / `DeviceNotConnectedError` で表す。これらは利用者視点では同じ
 * 「デバイスが応えなかった」状態なので、まとめて timeout（504 retryable）に写像する。
 *
 * @param err catch した例外
 * @returns timeout 相当なら true
 */
function isTimeoutLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (typeof name !== 'string') return false;
  return (
    name === 'GatewayTimeoutError' ||
    name === 'DeviceNotFoundError' ||
    name === 'DeviceNotConnectedError' ||
    name.includes('Timeout')
  );
}

/**
 * 本番用ファクトリ。azure-iothub の Client を生成し、設定値で {@link IotDeviceCommandPort} を組む。
 *
 * `invokeDeviceMethod` は内部的に IoT Hub のサービス REST API を使うため、AMQP の
 * `open()` は不要（接続文字列から生成した Client をそのまま使える）。接続文字列が無い環境では
 * `config.iot.hubConnectionString` が throw するので、呼び出し側（app.ts）は
 * `IOT_HUB_CONNECTION_STRING` の有無で生成を分岐し、未設定なら未設定スタブを使う。
 *
 * @returns 実 IoT Hub に DOWN を送る DeviceCommandPort
 */
export function createIotDeviceCommandPort(): IotDeviceCommandPort {
  const client = Client.fromConnectionString(config.iot.hubConnectionString);
  const invoker: DirectMethodInvoker = {
    async invoke(deviceId, methodName, payload, timeoutSeconds) {
      // Promise 形のオーバーロード。戻り値 r.result が DeviceMethodResponse（{status, payload}）。
      const r = await client.invokeDeviceMethod(deviceId, {
        methodName,
        payload,
        responseTimeoutInSeconds: timeoutSeconds,
        connectTimeoutInSeconds: timeoutSeconds,
      });
      const result = r.result as { status: number; payload: unknown };
      return { status: result.status, payload: result.payload };
    },
  };
  return new IotDeviceCommandPort(invoker, config.iot.methodTimeoutSeconds);
}
