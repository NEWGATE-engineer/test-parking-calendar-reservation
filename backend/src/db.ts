import mssql from 'mssql';
import { config } from './config.js';

/**
 * mssql コネクションプールのシングルトン。
 * リクエストごとに接続を張り直さず再利用する（serverless の resume 遅延・コスト対策）。
 */
let pool: mssql.ConnectionPool | undefined;
let connecting: Promise<mssql.ConnectionPool> | undefined;

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
        connecting = undefined;
        throw e;
      });
  }
  return connecting;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = undefined;
  }
}
