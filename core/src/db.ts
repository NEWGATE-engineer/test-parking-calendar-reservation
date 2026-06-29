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

/**
 * トランザクションのハンドル。
 *
 * リポジトリのメソッドはこれを受け取り `new mssql.Request(tx)` でクエリを実行する。
 * サービス層はこれを「不透明な値」として repo に渡すだけで、mssql の API は直接触らない
 * （＝トランザクション制御の都合がサービスのドメインロジックに漏れない）。
 */
export type Tx = mssql.Transaction;

/**
 * トランザクション境界を実行する関数の型。
 *
 * サービスはこの型の値を注入で受け取り、ユースケース本体（SELECT→判定→INSERT）を
 * コールバックとして渡す。テストでは「即座にコールバックを実行するだけの偽ランナー」に
 * 差し替えれば、DB なしでサービスのロジックを単体検証できる。
 */
export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * SQL Server のデッドロック被害者エラー（1205）かどうかを判定する。
 *
 * SERIALIZABLE 下では複数トランザクションが互いの範囲ロックを待ち合って
 * デッドロックになり得る。SQL Server は一方を「被害者」として 1205 で中断するので、
 * 呼び出し側はこれを検知して安全に再試行できる（被害者側のトランザクションは
 * 既にロールバック済み）。
 *
 * @param err catch した例外
 * @returns 1205 デッドロックなら `true`
 */
function isDeadlockError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'number' in err &&
    (err as { number?: unknown }).number === 1205
  );
}

/** {@link withSerializableTx} の挙動を調整するオプション。 */
export interface SerializableTxOptions {
  /** 1205 デッドロック時の最大再試行回数（既定 3）。これを超えたら例外を再送出。 */
  maxRetries?: number;
}

/**
 * SERIALIZABLE 分離レベルでトランザクションを張り、コールバックを実行する。
 *
 * 「重複・近接予約の判定 → 条件付き INSERT」のように、読み取りと書き込みを
 * 原子的に行う必要がある処理で使う。範囲排他制約が Azure SQL に無いため、
 * SERIALIZABLE の範囲ロックで TOCTOU（判定と INSERT の隙間に他者が割り込む競合）を防ぐ。
 *
 * - コールバックが正常終了したら commit。
 * - 例外（ドメイン違反の {@link AppError} 含む）が出たら rollback して再送出。
 *   ドメイン違反は「INSERT しない」ための制御フローなので、ロールバックが正しい挙動。
 * - 1205 デッドロックのときだけ、短いバックオフを挟んで `maxRetries` 回まで再試行する。
 *
 * @typeParam T コールバックの戻り値型
 * @param fn トランザクション内で実行する処理（`tx` を repo に渡してクエリする）
 * @param options 再試行回数などの調整
 * @returns コールバックの戻り値
 * @throws {AppError} コールバックが投げたドメイン例外はそのまま伝播する
 * @throws {Error} デッドロックが再試行上限を超えた場合や、その他の DB 例外
 */
export async function withSerializableTx<T>(
  fn: (tx: Tx) => Promise<T>,
  options: SerializableTxOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  // for(;;) で「成功 return / 非デッドロック例外 throw / デッドロックは continue」を回す
  for (let attempt = 0; ; attempt++) {
    const pool = await getPool();
    const tx = new mssql.Transaction(pool);
    await tx.begin(mssql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      // 失敗時は必ずロールバック。被害者トランザクションは SQL 側で既に中断されていて
      // rollback 自体が失敗し得るので、元の err を握り潰さないようログに留める。
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        console.error('トランザクションの rollback に失敗:', rollbackErr);
      }
      // デッドロック被害者かつ再試行枠が残っていれば、バックオフしてやり直す
      if (isDeadlockError(err) && attempt < maxRetries) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * 指数バックオフ（小さなジッタ付き）で待機する。
 *
 * 再試行が同時に殺到して再びデッドロックするのを避けるため、待機にばらつきを与える。
 *
 * @param attempt 0 始まりの試行回数（0,1,2,... と増えるほど待機が伸びる）
 */
function backoff(attempt: number): Promise<void> {
  const baseMs = 20 * 2 ** attempt; // 20ms, 40ms, 80ms, ...
  const jitterMs = Math.floor(Math.random() * baseMs);
  return new Promise((resolve) => setTimeout(resolve, baseMs + jitterMs));
}
