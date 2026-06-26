import { validationError } from '../http/errors.js';
import { RESERVATION_STATUSES, type ReservationStatus } from './repository.js';

/**
 * 予約 API（作成・変更・一覧）のリクエスト検証。
 *
 * @module reservations/validation
 */

/** 検証済みの予約作成入力（時刻は UTC の Date）。 */
export interface CreateReservationInput {
  spotId: string;
  start: Date;
  end: Date;
}

/** 予約変更の部分更新パッチ（指定されたフィールドのみ持つ。時刻は UTC の Date）。 */
export interface ReservationPatch {
  spotId?: string;
  start?: Date;
  end?: Date;
}

/** GET /reservations のクエリ（status は任意の絞り込み）。 */
export interface ListReservationsQuery {
  status?: ReservationStatus;
}

/** UUID（v4 想定だがバージョンは厳密に縛らない）の形式判定用。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 値を ISO 日時として Date に変換する。文字列でない・空・不正な日時なら `undefined`。
 *
 * @param v 任意の入力値（JSON ボディの値は unknown 扱い）
 * @returns 妥当な Date、不正なら undefined
 */
function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * 予約枠の時間不変条件を検証する（作成・変更で共有）。
 *
 * - `end > start`（ゼロ幅・逆転を弾く。DDL の CK_Resv_time と同じ不変条件）
 * - 過去開始でない（既に始まっている枠は予約・変更できない）
 *
 * @param start 開始（UTC）
 * @param end 終了（UTC）
 * @param now 現在時刻（過去判定の基準）
 * @throws {AppError} 422 `validation_error` — end<=start または過去開始
 */
function assertWindowInvariants(start: Date, end: Date, now: Date): void {
  if (end.getTime() <= start.getTime()) {
    throw validationError('end_time は start_time より後である必要があります');
  }
  if (start.getTime() < now.getTime()) {
    throw validationError('過去の日時は予約できません');
  }
}

/**
 * 予約作成ボディを検証し、型付きの入力へ変換する。
 *
 * 検証順に: ボディが object → spot_id が UUID → start/end が ISO 日時 →
 * end>start → 過去開始でない。最初に見つかった違反で 422 を投げる。
 *
 * @param body `req.body`（express.json でパース済み）
 * @param now 現在時刻（過去日時判定の基準。テスト容易性のため引数で受ける）
 * @returns 検証済みの `{ spotId, start, end }`
 * @throws {AppError} 422 `validation_error` — 型不正・end<=start・過去開始のいずれか
 */
export function parseCreateReservationBody(body: unknown, now: Date): CreateReservationInput {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const spotId = b['spot_id'];
  if (typeof spotId !== 'string' || !UUID_RE.test(spotId)) {
    throw validationError('spot_id は UUID で指定してください');
  }

  const start = parseDate(b['start_time']);
  const end = parseDate(b['end_time']);
  if (start === undefined) throw validationError('start_time は ISO 日時で指定してください');
  if (end === undefined) throw validationError('end_time は ISO 日時で指定してください');
  assertWindowInvariants(start, end, now);

  return { spotId, start, end };
}

/**
 * 予約変更ボディ（部分更新）を検証し、指定されたフィールドのみのパッチへ変換する。
 *
 * フィールドはすべて任意。**存在するフィールドだけ**形式を検証する（UUID / ISO 日時）。
 * end>start・過去開始の不変条件は、現在値とマージした後にサービス層で検証する
 * （省略フィールドは DB の現在値で補うため、ここでは判定できない）。
 *
 * @param body `req.body`
 * @returns 指定フィールドのみを持つ {@link ReservationPatch}
 * @throws {AppError} 422 `validation_error` — 指定フィールドの形式不正、または更新項目が空
 */
export function parseUpdateReservationBody(body: unknown): ReservationPatch {
  const b = (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;
  const patch: ReservationPatch = {};

  if (b['spot_id'] !== undefined) {
    if (typeof b['spot_id'] !== 'string' || !UUID_RE.test(b['spot_id'])) {
      throw validationError('spot_id は UUID で指定してください');
    }
    patch.spotId = b['spot_id'];
  }
  if (b['start_time'] !== undefined) {
    const start = parseDate(b['start_time']);
    if (start === undefined) throw validationError('start_time は ISO 日時で指定してください');
    patch.start = start;
  }
  if (b['end_time'] !== undefined) {
    const end = parseDate(b['end_time']);
    if (end === undefined) throw validationError('end_time は ISO 日時で指定してください');
    patch.end = end;
  }

  // 何も指定が無い更新は無意味なので弾く（誤呼び出し検知）
  if (patch.spotId === undefined && patch.start === undefined && patch.end === undefined) {
    throw validationError('変更するフィールドを1つ以上指定してください');
  }
  return patch;
}

/**
 * 現在値とパッチをマージした結果の時間不変条件を検証する（変更時）。
 *
 * @param start マージ後の開始
 * @param end マージ後の終了
 * @param now 現在時刻
 * @throws {AppError} 422 `validation_error` — end<=start または過去開始
 */
export function assertMergedWindow(start: Date, end: Date, now: Date): void {
  assertWindowInvariants(start, end, now);
}

/**
 * パスパラメータの予約 ID を検証する。
 *
 * `req.params` の値は型上 `string | string[] | undefined` になり得るため、
 * UUID 形式の単一文字列であることをここで保証する。
 *
 * @param raw `req.params.id`
 * @returns UUID 文字列
 * @throws {AppError} 422 `validation_error` — UUID でない場合
 */
export function parseReservationId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw validationError('予約 ID は UUID で指定してください');
  }
  return raw;
}

/**
 * GET /reservations のクエリを検証する。
 *
 * @param query `req.query`
 * @returns `{ status? }`（status は ReservationStatus のいずれか）
 * @throws {AppError} 422 `validation_error` — status が未知の値
 */
export function parseListQuery(query: unknown): ListReservationsQuery {
  const q = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const status = q['status'];
  if (status === undefined || status === '') return {};
  // enum 外の値は弾く（タイプミスを黙って無視＝全件返し、にしない）
  if (typeof status !== 'string' || !(RESERVATION_STATUSES as readonly string[]).includes(status)) {
    throw validationError('status の値が不正です');
  }
  return { status: status as ReservationStatus };
}
