import { config } from './config.js';
import { buildApp } from './app.js';
import { getPool, closePool } from './db.js';

async function main(): Promise<void> {
  // 起動時に DB プールを温める（失敗してもログのみ。/health は DB 非依存で応答可）
  try {
    await getPool();
    console.log('DB プール接続 OK');
  } catch (e) {
    console.error('DB 接続初期化に失敗（リクエスト時に再試行）:', e);
  }

  const app = buildApp();
  // Flutter（Windows 側ブラウザ）から到達できるよう 0.0.0.0 でリッスンする
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`backend listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} 受信。シャットダウンします`);
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
