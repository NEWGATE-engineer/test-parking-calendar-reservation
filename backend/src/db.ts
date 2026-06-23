import mssql from 'mssql';
import { config } from './config.js';

/**
 * SQL Server 接続プールの管理。
 *
 * コネクションプールは**シングルトン**で持ち、リクエストごとに接続を張り直さない。
 * Azure SQL（serverless）は無アクセスで自動一時停止するため、毎回新規接続すると
 * resume 遅延・コスト増を招く。プールを再利用してこれを避ける。
 *
 * @module db
 */

/** 接続済みプール（未接続時は undefined）。 */
let pool: mssql.ConnectionPool | undefined;
/** 接続処理中の Promise（同時呼び出しの二重接続を防ぐ）。 */
let connecting: Promise<mssql.ConnectionPool> | undefined;

/**
 * 共有のコネクションプールを取得する（無ければ接続して生成）。
 *
 * 同時に複数回呼ばれても接続は1回だけ行う（`connecting` で重複を吸収）。
 *
 * @returns 接続済みの `ConnectionPool`
 * @throws {Error} 接続に失敗した場合（呼び出し側でリトライ/ログ）
 */
export async function getPool(): Promise<mssql.ConnectionPool> {
  if (pool?.connected) return pool;
  if (!connecting) {
    connecting = new mssql.ConnectionPool(config.sqlConnectionString)
      .connect()
      .then((p) => {
        pool = p;
        connecting = undefined;
        return p;
      })
      .catch((e: unknown) => {
        // 失敗時は connecting を解除し、次回呼び出しで再接続できるようにする
        connecting = undefined;
        throw e;
      });
  }
  return connecting;
}

/**
 * プールを閉じる（グレースフルシャットダウン時に呼ぶ）。
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = undefined;
  }
}
