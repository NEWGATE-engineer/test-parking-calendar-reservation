import { config } from '../config.js';
import { AppError, notFound } from '../http/errors.js';
import { isDeviceHealthy } from '../spots/availability.js';
import type { CommandLogRepository } from './commandLog.repository.js';
import type { DeviceCommandPort } from './deviceCommandPort.js';

/**
 * gate-down（ロック板 DOWN 指示・入庫）のユースケース。
 *
 * 設計はシーケンス図 F4-6 に準拠する。CommandLog は「pending を INSERT → 結果で UPDATE」に
 * 統一し、冪等性は CommandLog.request_id の UNIQUE で担保する。デバイスへの送信は
 * {@link DeviceCommandPort} 越しに行い、Azure 非依存・テスト容易にする。
 *
 * @module reservations/gateDown.service
 */

/** gate-down 成功レスポンス（OpenAPI GateDownResponse）。 */
export interface GateDownResponse {
  result: 'down';
  command_id: string;
}

/**
 * gate-down（DOWN 指示）のユースケースサービス。
 *
 * 予約 CRUD（{@link ReservationsService}）とは依存（CommandLog・{@link DeviceCommandPort}）が
 * 異なるため独立したサービスとして構成する。冪等性・失敗時の HTTP マッピング・デバイス送信の
 * オーケストレーションを担う。
 */
export class GateDownService {
  /**
   * @param repo CommandLog データアクセス層
   * @param devicePort デバイスコマンド送信ポート（既定は未設定スタブ。本番は IoT 実装、テストはモック）
   */
  constructor(
    private readonly repo: CommandLogRepository,
    private readonly devicePort: DeviceCommandPort,
  ) {}

  /**
   * DOWN 指示を実行する。
   *
   * 流れ（F4-6）: 冪等再送チェック → コンテキスト取得(404) → pending INSERT →
   * 状態/期間(409) → 物理占有(409) → デバイス健全性(503) → デバイス送信(504/200)。
   * 404・冪等再送 以外の各分岐は CommandLog を failure/success に更新してから返す。
   *
   * @param userId 認証済みユーザー ID（予約の所有者）
   * @param reservationId 予約 ID
   * @param requestId 冪等キー
   * @returns 成功時の {@link GateDownResponse}
   * @throws {AppError} 404 `not_found` — 予約が存在しない／他人の予約
   * @throws {AppError} 409 `invalid_state` — reserved 以外、または now が予約期間外
   * @throws {AppError} 409 `physical_occupancy` — 区画が物理占有中
   * @throws {AppError} 409 `command_in_progress` / `command_failed` — 同一 request_id 再送（処理中／既に失敗）
   * @throws {AppError} 503 `device_unhealthy` — デバイス事前 NG（IoT を呼ばず即時失敗）
   * @throws {AppError} 504 `timeout` — デバイス無応答（再試行可）
   */
  async execute(
    userId: string,
    reservationId: string,
    requestId: string,
  ): Promise<GateDownResponse> {
    // 0) 冪等再送: 自分の同一 request_id の既存結果を先に確認する（user_id で絞り認可も担保）。
    //    success は副作用（板ダウン）を伴うため、デバイスを再発火させず初回と同じ結果を返す。
    const existing = await this.repo.findCommandByRequestId(requestId, userId);
    if (existing !== null) return this.replay(existing);

    // 1) 予約コンテキスト取得。無ければ 404（他人秘匿。CommandLog も書かない＝FK 上書けない唯一の経路）。
    const ctx = await this.repo.findGateDownContext(reservationId, userId);
    if (ctx === null) throw notFound('指定の予約は存在しません');

    // 2) pending を INSERT（以降は全分岐で success/failure に update）。
    //    並行する同一 request_id 再送は UNIQUE 違反で inserted:false → 冪等再送に合流。
    const ins = await this.repo.insertPendingCommand({ reservationId, userId, requestId });
    if (!ins.inserted) {
      const concurrent = await this.repo.findCommandByRequestId(requestId, userId);
      if (concurrent !== null) return this.replay(concurrent);
      // 競合で消えた等の極稀ケースは処理中として扱う
      throw new AppError(409, 'command_in_progress', '同じ操作を処理中です', false);
    }
    const commandId = ins.commandId;

    // 3) 状態・期間チェック（reserved かつ now が [start, end] 内）。NG は failure→409 invalid_state。
    const now = new Date();
    const inPeriod =
      now.getTime() >= ctx.start_time.getTime() && now.getTime() <= ctx.end_time.getTime();
    if (ctx.status !== 'reserved' || !inPeriod) {
      await this.recordResult(commandId, 'failure');
      throw new AppError(409, 'invalid_state', 'この予約は現在 DOWN 指示できません', false);
    }

    // 4) 物理占有の事前判定（occupancy=occupied は IoT を呼ぶ前に拒否）。
    if (ctx.occupancy === 'occupied') {
      await this.recordResult(commandId, 'failure');
      throw new AppError(409, 'physical_occupancy', '区画が使用中です', false);
    }

    // 5) デバイス事前 NG（last_seen_at が古い／未割当）。IoT を呼ばず即時 503（タイムアウト待ちを避ける）。
    const healthy = isDeviceHealthy(
      ctx.device_last_seen_at,
      config.device.healthThresholdMinutes,
      now,
    );
    if (!healthy || ctx.device_id === null) {
      await this.recordResult(commandId, 'failure');
      throw new AppError(503, 'device_unhealthy', 'デバイスが応答できる状態にありません', false);
    }

    // 6) デバイスへ DOWN 送信。無応答(timeout)は failure→504(retryable)、成功は success→200。
    const sent = await this.devicePort.sendDown(ctx.device_id, requestId);
    if (!sent.ok) {
      await this.recordResult(commandId, 'failure');
      throw new AppError(504, 'timeout', 'デバイスが応答しませんでした', true);
    }
    await this.recordResult(commandId, 'success');
    return { result: 'down', command_id: commandId };
  }

  /**
   * CommandLog の結果を best-effort で記録する。
   *
   * 監査用の UPDATE が DB エラーで失敗しても、本来返すべきドメイン結果（AppError や 200）を
   * 握り潰して 500 にしないよう、失敗はログに留めて握る。これにより「結果 UPDATE 失敗 →
   * 例外が AppError を覆い隠す → CommandLog が pending 残留」という不具合を避ける。
   *
   * @param commandId 対象 CommandLog.id
   * @param result 確定結果
   */
  private async recordResult(commandId: string, result: 'success' | 'failure'): Promise<void> {
    try {
      const rows = await this.repo.updateCommandResult(commandId, result);
      // 条件付き UPDATE が 0 件＝既に pending でない（二重更新・競合）。監査として警告に留める。
      if (rows === 0) {
        console.warn(`CommandLog が pending でなく更新されず (id=${commandId}, result=${result})`);
      }
    } catch (err) {
      // 監査記録の失敗はユーザー応答に影響させない（結果自体は確定している）
      console.error(`CommandLog 結果更新に失敗 (id=${commandId}, result=${result}):`, err);
    }
  }

  /**
   * 冪等再送の結果を、既存 CommandLog の状態から再現する。
   *
   * success のみ完全再現（同じ command_id で 200）。pending/failure は 409 にマップする
   * （失敗理由は DDL に保持しないため、再試行は新しい request_id で行わせる）。
   *
   * @param existing 既存 CommandLog（id・result）
   * @returns success のときのみ {@link GateDownResponse}
   * @throws {AppError} 409 `command_in_progress`（pending）／`command_failed`（failure）
   */
  private replay(existing: {
    id: string;
    result: 'pending' | 'success' | 'failure';
  }): GateDownResponse {
    if (existing.result === 'success') return { result: 'down', command_id: existing.id };
    if (existing.result === 'pending') {
      throw new AppError(409, 'command_in_progress', '同じ操作を処理中です', false);
    }
    // failure: この request_id は既に失敗済み。再試行は新しい request_id で行う。
    throw new AppError(
      409,
      'command_failed',
      'この操作は既に失敗しています（新しい操作で再試行してください）',
      false,
    );
  }
}
