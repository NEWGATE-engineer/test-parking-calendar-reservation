import { config } from '../config.js';
import { type TxRunner, withSerializableTx } from '../db.js';
import { settleCompletion } from '../reservations/completion.js';
import type { TelemetryRepository } from './repository.js';
import type {
  EntryResult,
  ExitResult,
  PlateUpResult,
  TelemetryEvent,
  TelemetryResult,
} from './types.js';

/**
 * テレメトリ処理のユースケース（onEntryDetected / onExitDetected / onPlateUp）。
 *
 * IoT Hub トリガは at-least-once（同じイベントが二度来うる）。本サービスは
 * **ドメイン条件で冪等化**する（ADR 0005）:
 *   - 入庫: open な UsageRecord があれば UsageRecord を挿入しない。
 *   - 状態遷移（reserved→active / →completed / 板 down→up / 出庫の exit_time）はすべて
 *     「現在状態を WHERE に含めた条件付き UPDATE」で行い、0 件は「既処理」とみなす。
 *   - DeviceEvent の記録も上記の「実際に遷移した（行数 1）」ときだけに限定し、再配信での重複行を避ける。
 *
 * トランザクション境界（SERIALIZABLE）はサービスが所有し、read→write の隙間に他テレメトリ／
 * タイマー（autoComplete 等）が割り込むのを防ぐ。CommandLog には触らない（DOWN の成否記録は
 * backend の同期応答のみが担当＝論点D）。
 *
 * @module telemetry/service
 */
export class TelemetryService {
  /**
   * @param repo テレメトリデータアクセス層（既定は SqlTelemetryRepository を functions 側で注入）
   * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナーに差し替え）
   */
  constructor(
    private readonly repo: TelemetryRepository,
    private readonly runTx: TxRunner = withSerializableTx,
  ) {}

  /**
   * テレメトリ種別で適切なハンドラへ振り分ける（functions の単一エントリ用）。
   *
   * @param ev 検証済みテレメトリイベント
   * @returns 種別タグ付きの処理結果
   */
  async handle(ev: TelemetryEvent): Promise<TelemetryResult> {
    switch (ev.type) {
      case 'entry':
        return { kind: 'entry', ...(await this.handleEntry(ev)) };
      case 'exit':
        return { kind: 'exit', ...(await this.handleExit(ev)) };
      case 'up':
        return { kind: 'up', ...(await this.handlePlateUp(ev)) };
    }
  }

  /**
   * 在車検知（入庫）。区画を occupied にし、対応予約があれば初回のみ UsageRecord 挿入＋
   * reserved→active、DeviceEvent(entry) を記録する。
   *
   * @param ev entry テレメトリ
   * @returns 何が起きたかの内訳（ログ・テスト用）
   * @throws DB 接続失敗・タイムアウト・デッドロック等（一時障害。functions が再 throw し Functions が再試行する）
   */
  async handleEntry(ev: TelemetryEvent): Promise<EntryResult> {
    return this.runTx(async (tx) => {
      const device = await this.repo.findDeviceById(tx, ev.deviceId);
      if (device === null) {
        // 未登録デバイス＝対応づけ不能。記録せず無視（ログは呼び出し側 functions が出す）。
        return {
          deviceFound: false,
          reservationId: null,
          usageInserted: false,
          activated: false,
          eventRecorded: false,
        };
      }

      // 全テレメトリで最終通信を更新。入庫なので生の在車も occupied に。
      await this.repo.touchDevice(tx, device.device_id, ev.occurredAt, 'occupied');
      // 確定在車状態（表示・物理占有事前判定に使う）も occupied に。
      await this.repo.setSpotOccupancy(tx, device.spot_id, 'occupied');

      // この区画の「いま有効な予約」を特定（reserved/active かつ発生時刻が期間内）。
      const resv = await this.repo.findActiveReservationForSpotAt(
        tx,
        device.spot_id,
        ev.occurredAt,
      );

      if (resv === null) {
        // 予約に紐づかない入庫（物理占有の残存リスク・§4.3.2）。occupancy は occupied にした上で
        // 監査として DeviceEvent(entry) を残す。予約なしなので open ゲートが効かず再配信で重複し得る
        // （MVP 許容・稀な異常系）。状態遷移・UsageRecord は行わない。
        await this.repo.insertDeviceEvent(tx, {
          deviceId: device.device_id,
          reservationId: null,
          type: 'entry',
          occurredAt: ev.occurredAt,
        });
        return {
          deviceFound: true,
          reservationId: null,
          usageInserted: false,
          activated: false,
          eventRecorded: true,
        };
      }

      // 冪等化: 既に open な UsageRecord があれば再配信/再入庫とみなし二重挿入しない。
      const hasOpen = await this.repo.hasOpenUsageRecord(tx, resv.id);
      let usageInserted = false;
      let eventRecorded = false;
      if (!hasOpen) {
        await this.repo.insertUsageEntry(tx, resv.id, ev.occurredAt);
        usageInserted = true;
        // DeviceEvent(entry) は「新規入庫」のときだけ記録し、再配信での重複行を避ける。
        await this.repo.insertDeviceEvent(tx, {
          deviceId: device.device_id,
          reservationId: resv.id,
          type: 'entry',
          occurredAt: ev.occurredAt,
        });
        eventRecorded = true;
      }

      // reserved→active（条件付き UPDATE のため再配信でも安全に呼べる。0 件＝既に active＝初回でない）。
      const activatedRows = await this.repo.activateReservation(tx, resv.id);

      return {
        deviceFound: true,
        reservationId: resv.id,
        usageInserted,
        activated: activatedRows === 1,
        eventRecorded,
      };
    });
  }

  /**
   * 空車検知（出庫）。open な利用記録を閉じ、区画を vacant にする。さらに
   * 「終了時刻を経過 かつ 残 open 利用記録なし」なら completed に確定し、確定料金（枠＋超過）を
   * Fee に INSERT する（条件付き UPDATE が 1 件成功したときだけ＝UQ_Fee_resv 二重防止）。
   *
   * @param ev exit テレメトリ
   * @returns 何が起きたかの内訳（ログ・テスト用）
   * @throws DB 接続失敗・タイムアウト・デッドロック等（一時障害。functions が再 throw し Functions が再試行する）
   */
  async handleExit(ev: TelemetryEvent): Promise<ExitResult> {
    return this.runTx(async (tx) => {
      const device = await this.repo.findDeviceById(tx, ev.deviceId);
      if (device === null) {
        return {
          deviceFound: false,
          reservationId: null,
          usageClosed: false,
          completed: false,
          feeInserted: false,
          eventRecorded: false,
        };
      }

      await this.repo.touchDevice(tx, device.device_id, ev.occurredAt, 'vacant');
      await this.repo.setSpotOccupancy(tx, device.spot_id, 'vacant');

      // 区画の open な利用記録（＋予約期間）を取得。無ければ閉じる対象なし（再配信・予約なし）。
      const open = await this.repo.findOpenUsageForSpot(tx, device.spot_id);
      if (open === null) {
        return {
          deviceFound: true,
          reservationId: null,
          usageClosed: false,
          completed: false,
          feeInserted: false,
          eventRecorded: false,
        };
      }

      // exit_time 未記録のときだけ閉じる（条件付き UPDATE）。0 件＝既に閉じている＝再配信。
      const closedRows = await this.repo.closeUsageRecord(tx, open.usage_id, ev.occurredAt);
      if (closedRows !== 1) {
        return {
          deviceFound: true,
          reservationId: open.reservation_id,
          usageClosed: false,
          completed: false,
          feeInserted: false,
          eventRecorded: false,
        };
      }

      // 実際に閉じたときだけ DeviceEvent(exit) を記録（再配信での重複行を避ける）。
      await this.repo.insertDeviceEvent(tx, {
        deviceId: device.device_id,
        reservationId: open.reservation_id,
        type: 'exit',
        occurredAt: ev.occurredAt,
      });

      // 完了判定: 終了時刻を経過 かつ この予約に残る open 利用記録が無い（＝空車）。
      let completed = false;
      let feeInserted = false;
      const ended = ev.occurredAt.getTime() >= open.reservation_end.getTime();
      const remainingOpen = await this.repo.countOpenUsageForReservation(tx, open.reservation_id);
      if (ended && remainingOpen === 0) {
        // 完了確定＋料金確定は共有オーケストレーションへ（条件付き UPDATE が1件成功時のみ Fee）。
        // この出庫が最終出庫（残 open 0 件を確認済み）なので lastExit = ev.occurredAt。
        const settled = await settleCompletion(tx, this.repo, {
          reservationId: open.reservation_id,
          start: open.reservation_start,
          end: open.reservation_end,
          lastExit: ev.occurredAt,
          calculatedAt: new Date(),
          cfg: config.reservation,
        });
        completed = settled.completed;
        feeInserted = settled.completed;
      }

      return {
        deviceFound: true,
        reservationId: open.reservation_id,
        usageClosed: true,
        completed,
        feeInserted,
        eventRecorded: true,
      };
    });
  }

  /**
   * UP 実行。デバイスの板位置を down→up にし、遷移したときだけ DeviceEvent(up) を記録する。
   * 予約状態は変えない（入出庫の UP はデバイス側の責務・クラウドは記録のみ・§5.3）。
   *
   * @param ev up テレメトリ
   * @returns 何が起きたかの内訳（ログ・テスト用）
   * @throws DB 接続失敗・タイムアウト・デッドロック等（一時障害。functions が再 throw し Functions が再試行する）
   */
  async handlePlateUp(ev: TelemetryEvent): Promise<PlateUpResult> {
    return this.runTx(async (tx) => {
      const device = await this.repo.findDeviceById(tx, ev.deviceId);
      if (device === null) {
        return { deviceFound: false, raised: false, eventRecorded: false };
      }

      // up は在車状態を変えないので last_occupancy は据え置き（null）。last_seen_at のみ更新。
      await this.repo.touchDevice(tx, device.device_id, ev.occurredAt, null);

      // down のときだけ up へ（条件付き UPDATE）。0 件＝既に up（再配信・冗長 up）。
      const raisedRows = await this.repo.raisePlate(tx, device.device_id);
      let eventRecorded = false;
      if (raisedRows === 1) {
        await this.repo.insertDeviceEvent(tx, {
          deviceId: device.device_id,
          reservationId: null,
          type: 'up',
          occurredAt: ev.occurredAt,
        });
        eventRecorded = true;
      }

      return { deviceFound: true, raised: raisedRows === 1, eventRecorded };
    });
  }
}
