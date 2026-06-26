import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool, getPool } from './db.js';

/**
 * アプリのエントリポイント。
 *
 * DB プールのウォームアップ → Express の起動 → グレースフルシャットダウンの配線を行う。
 *
 * @module index
 */

/**
 * サーバを起動する。
 *
 * - 起動時に DB プールを温める（失敗してもログのみ。/health は DB 非依存で応答できる）。
 * - Flutter（Windows 側ブラウザ）から到達できるよう `0.0.0.0` でリッスンする。
 * - SIGTERM/SIGINT で接続を閉じてから終了する。
 */
async function main(): Promise<void> {
  try {
    await getPool();
    console.log('DB プール接続 OK');
  } catch (e) {
    // 起動を止めない（リクエスト時に getPool が再接続を試みる）
    console.error('DB 接続初期化に失敗（リクエスト時に再試行）:', e);
  }

  const app = buildApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`backend listening on http://0.0.0.0:${String(config.port)} (${config.nodeEnv})`);
  });

  /** シグナル受信時に受付を止め、プールを閉じてから終了する。 */
  const shutdown = (signal: string): void => {
    console.log(`${signal} 受信。シャットダウンします`);
    server.close(() => {
      void closePool().finally(() => {
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

void main();
