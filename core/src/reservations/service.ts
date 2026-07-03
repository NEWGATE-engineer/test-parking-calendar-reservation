import { config } from '../config.js';
import { type TxRunner, withSerializableTx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import {
  type AvailabilityReason,
  availabilityForSpot,
  isDeviceHealthy,
} from '../spots/availability.js';
import { estimateSlotFee } from './fee.js';
import type { ReservationRow, ReservationStatus, ReservationsRepository } from './repository.js';
import {
  assertMergedWindow,
  type CreateReservationInput,
  type ReservationPatch,
} from './validation.js';

/**
 * 予約のユースケース。
 *
 * トランザクション境界（SERIALIZABLE）はこのサービスが所有し、その中で
 * 「区画 SELECT → 競合判定 → 条件付き INSERT」を原子的に行う。判定ロジックは
 * 純粋関数 {@link availabilityForSpot}（GET /spots/availability と共有）を再利用し、
 * 「予約可と出たのに作れない」食い違いを防ぐ。
 *
 * @module reservations/service
 */

/** POST /reservations の 201 レスポンス（OpenAPI ReservationResponse）。 */
export interface ReservationResponse {
  id: string;
  spot_id: string;
  /** ISO 8601・UTC。 */
  start_time: string;
  /** ISO 8601・UTC。 */
  end_time: string;
  status: ReservationStatus;
  /** ISO 8601・UTC。 */
  created_at: string;
  /** 予約枠の見込み額（円）。確定額は Fee（完了時）。 */
  estimated_slot_fee: number;
  /** 在車中か（open な UsageRecord の有無）。利用終了ボタンの活性判定などに使う。 */
  in_car: boolean;
}

/**
 * availability の reason を、予約作成 API のエラー（HTTP status / code）へ変換する。
 *
 * availability と語彙をそろえつつ、API 側の code 命名（conflict_overlap / conflict_buffer）に
 * 寄せる。いずれも retryable=false（別時間・別区画の再選択を促す）。
 *
 * @param reason availabilityForSpot が返した不可理由
 * @returns 対応する {@link AppError}
 */
function conflictError(reason: AvailabilityReason): AppError {
  switch (reason) {
    // 素の時間帯重複
    case 'reserved':
      return new AppError(409, 'conflict_overlap', '指定の時間帯はすでに予約されています', false);
    // バッファ未満の近接
    case 'buffer':
      return new AppError(
        409,
        'conflict_buffer',
        '前後の予約とのバッファ時間が不足しています',
        false,
      );
    // デバイス不健全
    case 'device_unhealthy':
      return new AppError(
        409,
        'device_unhealthy',
        'デバイスが応答していないため予約できません',
        false,
      );
    // ok は available=true 側で扱うのでここには来ないが、網羅性のため保険
    default:
      return new AppError(409, 'conflict', '予約できません', false);
  }
}

export class ReservationsService {
  /**
   * @param repo 予約データアクセス層（既定は SqlReservationsRepository を router 側で注入）
   * @param runTx トランザクションランナー（既定 {@link withSerializableTx}。テストは偽ランナーに差し替え）
   */
  constructor(
    private readonly repo: ReservationsRepository,
    private readonly runTx: TxRunner = withSerializableTx,
  ) {}

  /**
   * 予約を作成する。
   *
   * SERIALIZABLE トランザクション内で区画存在・デバイス健全性・時間帯競合を確認し、
   * 問題なければ INSERT する。競合判定と INSERT を同一トランザクションに束ねることで、
   * 判定と書き込みの隙間に他者が割り込む TOCTOU を防ぐ（範囲排他制約は Azure SQL に無い）。
   *
   * @param userId 認証済みユーザー ID（予約の所有者）
   * @param input 検証済みの作成入力（区画・時間帯）
   * @returns 作成された予約（見込み料金つき）
   * @throws {AppError} 404 `not_found` — 区画が存在しない
   * @throws {AppError} 409 `conflict_overlap` / `conflict_buffer` / `device_unhealthy` — 競合・不健全
   */
  async create(userId: string, input: CreateReservationInput): Promise<ReservationResponse> {
    const now = new Date();
    const threshold = config.device.healthThresholdMinutes;
    const buffer = config.reservation.bufferMinutes;

    // トランザクション境界はサービスが所有し、ドメイン判断（可否）もこの中で下す。
    // repo には tx を渡すだけ。違反時は throw でロールバック（INSERT させない）。
    const created = await this.runTx(async (tx) => {
      // 1) 区画＋デバイス最終通信を取得。存在しなければ 404（他人秘匿と同じ語彙）。
      const spot = await this.repo.findSpotWithDevice(tx, input.spotId);
      if (spot === null) throw notFound('指定の区画は存在しません');

      // 2) 同一区画のバッファ込み競合を取得（SERIALIZABLE 下で範囲ロックを保持）
      const conflicts = await this.repo.findConflictsForSpot(
        tx,
        input.spotId,
        input.start,
        input.end,
        buffer,
      );

      // 3) デバイス健全性＋競合から可否を判定（GET availability と同じ純粋ロジックを再利用）
      const healthy = isDeviceHealthy(spot.last_seen_at, threshold, now);
      const { available, reason } = availabilityForSpot({
        deviceHealthy: healthy,
        window: { start: input.start, end: input.end },
        conflicts,
        bufferMinutes: buffer,
      });
      if (!available) throw conflictError(reason);

      // 4) 条件を満たしたので INSERT（status は既定 'reserved'）
      return this.repo.insertReservation(tx, {
        userId,
        spotId: input.spotId,
        start: input.start,
        end: input.end,
      });
    });

    // 見込み料金つきのレスポンスへ整形（Fee 行はここでは作らない＝完了時のみ）
    return this.toResponse(created);
  }

  /**
   * 自分の予約一覧を返す（任意で status 絞り込み）。
   *
   * @param userId 認証済みユーザー ID
   * @param status 絞り込む status（省略時は全件）
   * @returns 予約ビューの配列（新しい開始順・見込み料金つき）
   * @throws 業務例外は投げない。DB 例外はそのまま上位（→ 500）へ伝播する。
   */
  async list(userId: string, status?: ReservationStatus): Promise<ReservationResponse[]> {
    const rows = await this.repo.listReservations(userId, status);
    return rows.map((r) => this.toResponse(r));
  }

  /**
   * 予約を変更する（`reserved` のみ・部分更新）。
   *
   * 省略フィールドは現在値を維持してマージし、マージ後の時間で不変条件と競合を再チェックする。
   * 時刻・区画が変わり得るため SERIALIZABLE トランザクション内で「対象 SELECT →
   * 状態確認 → 競合再チェック（自分除外）→ 条件付き UPDATE」を原子的に行う。
   *
   * @param userId 認証済みユーザー ID（所有者）
   * @param id 予約 ID
   * @param patch 変更内容（指定フィールドのみ）
   * @returns 変更後の予約（見込み料金つき）
   * @throws {AppError} 404 `not_found` — 予約または区画が存在しない（他人の予約含む）
   * @throws {AppError} 409 `not_modifiable` — reserved 以外、または判定後に状態が変化した
   * @throws {AppError} 409 `conflict_overlap` / `conflict_buffer` / `device_unhealthy` — 競合・不健全
   * @throws {AppError} 422 `validation_error` — マージ後に end<=start または過去開始
   */
  async update(userId: string, id: string, patch: ReservationPatch): Promise<ReservationResponse> {
    const now = new Date();
    const threshold = config.device.healthThresholdMinutes;
    const buffer = config.reservation.bufferMinutes;

    const updated = await this.runTx(async (tx) => {
      // 1) 対象を所有者付きで取得（無ければ 404）。SERIALIZABLE 下で行をロックして読む。
      const current = await this.repo.findOwnedReservation(tx, id, userId);
      if (current === null) throw notFound('指定の予約は存在しません');
      // 2) reserved 以外は変更不可（409）
      if (current.status !== 'reserved') {
        throw new AppError(409, 'not_modifiable', 'reserved 以外の予約は変更できません', false);
      }

      // 3) 省略フィールドは現在値で補ってマージ → 不変条件を再検証
      const spotId = patch.spotId ?? current.spot_id;
      const start = patch.start ?? current.start_time;
      const end = patch.end ?? current.end_time;
      assertMergedWindow(start, end, now);

      // 4) 競合再チェック（自分自身は除外）。区画変更にも対応するため区画 SELECT も行う。
      const spot = await this.repo.findSpotWithDevice(tx, spotId);
      if (spot === null) throw notFound('指定の区画は存在しません');
      const conflicts = await this.repo.findConflictsForSpot(tx, spotId, start, end, buffer, id);
      const healthy = isDeviceHealthy(spot.last_seen_at, threshold, now);
      const { available, reason } = availabilityForSpot({
        deviceHealthy: healthy,
        window: { start, end },
        conflicts,
        bufferMinutes: buffer,
      });
      if (!available) throw conflictError(reason);

      // 5) 条件付き UPDATE。0 件＝判定後に状態が変化した＝競合（防御的に 409）。
      const rows = await this.repo.updateReservation(tx, { id, userId, spotId, start, end });
      if (rows === 0) {
        throw new AppError(409, 'not_modifiable', '予約の状態が変化したため変更できません', false);
      }

      // created_at・status（reserved のまま）は据え置き、変更後の値で返す。
      // 変更は reserved のみ可＝まだ入庫していないので在車していない（in_car=false）。
      return {
        id,
        spot_id: spotId,
        start_time: start,
        end_time: end,
        status: current.status,
        created_at: current.created_at,
        in_car: false,
      };
    });

    return this.toResponse(updated);
  }

  /**
   * 予約をキャンセルする（`reserved` のみ）。
   *
   * 状態遷移は単一の条件付き UPDATE で原子的に行う。0 件のときだけ、不在（404）と
   * reserved 以外（409）を所有者付きの status 取得で切り分ける。
   *
   * @param userId 認証済みユーザー ID（所有者）
   * @param id 予約 ID
   * @throws {AppError} 404 `not_found` — 予約が存在しない（他人の予約含む）
   * @throws {AppError} 409 `not_cancelable` — reserved 以外は取消不可
   */
  async cancel(userId: string, id: string): Promise<void> {
    const rows = await this.repo.cancelReservation(id, userId);
    if (rows === 1) return;
    // 0 件: 状態が reserved でなかったか、そもそも存在しない（他人含む）か
    const status = await this.repo.findOwnedStatus(id, userId);
    if (status === null) throw notFound('指定の予約は存在しません');
    throw new AppError(409, 'not_cancelable', 'reserved 以外の予約は取消できません', false);
  }

  /**
   * DB の予約行を、見込み料金つきの API レスポンスへ整形する（作成・変更・一覧で共有）。
   *
   * 引数は {@link ReservationRow} 形（`CreatedReservation` や update の確定値も構造的に適合）。
   *
   * @param row 予約行（時刻は Date）
   * @returns ReservationResponse（時刻は ISO 文字列・estimated_slot_fee つき）
   */
  private toResponse(row: ReservationRow): ReservationResponse {
    const estimatedSlotFee = estimateSlotFee(row.start_time, row.end_time, config.reservation);
    return {
      id: row.id,
      spot_id: row.spot_id,
      start_time: row.start_time.toISOString(),
      end_time: row.end_time.toISOString(),
      status: row.status,
      created_at: row.created_at.toISOString(),
      estimated_slot_fee: estimatedSlotFee,
      in_car: row.in_car,
    };
  }
}
