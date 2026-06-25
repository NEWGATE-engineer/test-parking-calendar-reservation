import { validationError } from '../http/errors.js';

/**
 * POST /reservations のリクエストボディ検証。
 *
 * @module reservations/validation
 */

/** 検証済みの予約作成入力（時刻は UTC の Date）。 */
export interface CreateReservationInput {
  spotId: string;
  start: Date;
  end: Date;
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
  // ゼロ幅・逆転を弾く（DDL の CK_Resv_time と同じ不変条件をアプリ側でも先に検証）
  if (end.getTime() <= start.getTime()) throw validationError('end_time は start_time より後である必要があります');
  // 過去開始は受け付けない（既に始まっている枠は予約できない）
  if (start.getTime() < now.getTime()) throw validationError('過去の日時は予約できません');

  return { spotId, start, end };
}
