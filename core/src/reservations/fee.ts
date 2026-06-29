/**
 * 予約枠の見込み料金（estimated_slot_fee）を計算する純粋ロジック。
 *
 * DB にもネットワークにも依存しないので、境界値を含めて単体テストしやすいよう
 * 副作用のない関数として切り出す。確定額（Fee テーブル）は完了時に別途算出するため、
 * ここで計算するのはあくまで「作成・変更時に返す見込み額」。
 *
 * @module reservations/fee
 */

/** 料金計算に使う設定（`config.reservation` のうち単価・課金単位）。 */
export interface SlotFeeConfig {
  /** 課金単位あたりの単価（円）。仮 100 円（要件 §12 #1）。 */
  unitPriceJpy: number;
  /** 課金単位（分）。仮 30 分。 */
  unitMinutes: number;
}

/**
 * 予約枠の見込み料金を「単位時間ごとの切り上げ課金」で算出する。
 *
 * 例: 単価 100円 / 30分 のとき、45分なら 2 単位で 200円（端数は切り上げ）。
 *
 * @param start 予約開始（UTC）
 * @param end 予約終了（UTC）。`start` より後である前提（検証は呼び出し側 validation の責務）
 * @param cfg 単価・課金単位
 * @returns 見込み料金（円）。常に 1 単位以上を課金する
 */
export function estimateSlotFee(start: Date, end: Date, cfg: SlotFeeConfig): number {
  // 所要分。validation で end>start を保証済みなので正の値になる
  const durationMin = (end.getTime() - start.getTime()) / 60_000;
  // 端数は切り上げ（30分単位なら 31分でも 2 単位）。最低 1 単位。
  const units = Math.max(1, Math.ceil(durationMin / cfg.unitMinutes));
  return units * cfg.unitPriceJpy;
}
