/**
 * デバイスへのコマンド送信ポート（IoT Hub ダイレクトメソッドの抽象）。
 *
 * gate-down サービスはこの interface 越しに DOWN 指示を送る。実体（Azure IoT Hub
 * ダイレクトメソッド）は device-sim / IoT 連携スライスで実装する。ここを抽象化することで、
 * サービスのドメインロジックを Azure 非依存にし、テストではモックに差し替えられる。
 *
 * @module reservations/deviceCommandPort
 */

/**
 * DOWN 指示の結果。
 * - 成功: 板がダウンした。
 * - 失敗: 現状は接続あり無応答（タイムアウト）のみ表現する（→ 504 にマップ）。
 *   デバイス事前 NG（不健全）は IoT を呼ぶ前にサービス側で判定するため、ここには現れない。
 */
export type DeviceCommandResult = { ok: true } | { ok: false; reason: 'timeout' };

/** デバイスコマンド送信の抽象。 */
export interface DeviceCommandPort {
  /**
   * 指定デバイスへ DOWN 指示を送る（タイムアウト付き同期呼び出し）。
   *
   * @param deviceId 対象デバイス識別子（Device.device_id）
   * @param requestId 冪等キー（デバイス側の二重発火防止にも使う）
   * @returns 成功 or タイムアウト
   */
  sendDown(deviceId: string, requestId: string): Promise<DeviceCommandResult>;
}

/**
 * 未設定スタブ。IoT 実接続が未配線の状態で実行されたら明示的に失敗させる。
 *
 * 本番経路で gate-down を使うには、IoT 連携スライスで実 {@link DeviceCommandPort} を
 * 注入する必要がある。テストでは常にモックを注入するため、このスタブは呼ばれない。
 */
export const notConfiguredDeviceCommandPort: DeviceCommandPort = {
  sendDown(): Promise<DeviceCommandResult> {
    return Promise.reject(
      new Error('DeviceCommandPort 未設定: IoT 連携スライスで実装を注入してください'),
    );
  },
};
