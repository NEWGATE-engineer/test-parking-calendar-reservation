import { app, type InvocationContext, type Timer } from '@azure/functions';
import { LifecycleService, SqlLifecycleRepository } from '@parking/core';

/**
 * 予約ライフサイクルの定期走査（detectNoShow / detectOverstay / autoComplete）。
 *
 * Azure Functions のタイマートリガで定期実行し、`@parking/core` の {@link LifecycleService} に
 * 委譲する薄いアダプタ。状態遷移・冪等・確定料金はすべて core が持ち（ADR 0007）、この関数は
 * トリガ配線と結果ログに徹する。イベント駆動（onExitDetected）の取りこぼしの安全網も兼ねる。
 *
 * @module functions/lifecycleSweep
 */

// サービスはモジュールスコープで 1 度だけ生成し、ウォーム間で再利用する（DB プールは core 側で
// シングルトン管理）。
const service = new LifecycleService(new SqlLifecycleRepository());

/**
 * タイマートリガ本体。1 回走査して結果をログする。
 *
 * autoComplete の個別失敗は {@link LifecycleService.sweep} が握って `failures` に積むため、
 * ここでエラーログを出すだけで関数自体は正常終了する（次走査で安全網が再試行）。set-based の
 * no_show/overstay 更新が失敗した場合は例外が伝播し、Functions が次のスケジュールで再実行する。
 *
 * @param _timer タイマー情報（未使用）
 * @param context Functions 実行コンテキスト（ログ出力）
 */
export async function onLifecycleSweep(_timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  const result = await service.sweep(now);
  context.log(
    `lifecycle sweep: ${JSON.stringify({
      noShow: result.noShow,
      overstay: result.overstay,
      completed: result.completed,
      feesInserted: result.feesInserted,
      failed: result.failures.length,
    })}`,
  );
  for (const f of result.failures) {
    context.error(`autoComplete 失敗 reservationId=${f.reservationId}: ${f.error}`);
  }
}

app.timer('onLifecycleSweep', {
  // 走査間隔（NCRONTAB・UTC）。仮 5 分毎（§12 #9・serverless 自動停止とのコスト綱引き）。
  // App Settings の LIFECYCLE_SWEEP_SCHEDULE で上書き可。
  schedule: process.env.LIFECYCLE_SWEEP_SCHEDULE ?? '0 */5 * * * *',
  handler: onLifecycleSweep,
});
