// @ts-check
'use strict';

/**
 * device-sim: AUTOSTAND（ロック板）の疑似デバイス。
 *
 * 役割（IoT 連携スライス (a) 最小骨組み）:
 *   1. クラウド（backend）からの **DOWN ダイレクトメソッド**を受け、板を down にして応答する。
 *      冪等キー requestId で二重発火を防ぐ（ADR 0003 / DeviceCommandPort）。
 *   2. **テレメトリ（entry / exit / up）を手動送出**する。functions 側が
 *      onEntryDetected / onExitDetected / onPlateUp として消費する（バックエンド処理一覧 §B）。
 *
 * 状態機械は簡易。安全インターロック（§5.3 の自動 UP 条件）は実装せず、UP は手動コマンドで送る。
 *
 * 2 つの動作モード:
 *   - オンライン: 環境変数 IOT_DEVICE_CONNECTION_STRING があれば Azure IoT Hub に接続し、
 *     ダイレクトメソッド受信＋テレメトリ送信を実機経路で行う。
 *   - オフライン(dry-run): 接続文字列が無ければ Hub に繋がず、送信予定の JSON を標準出力に出す。
 *     Azure 無しでローカル開発・契約確認ができる（日常開発はローカル完結の方針）。
 *
 * 起動:
 *   オフライン: `npm start`
 *   オンライン: `npm run start:env`（device-sim/.env の接続文字列を Node の --env-file で読む）
 *
 * メッセージ契約の詳細は device-sim/README.md を参照（functions/backend と共有する取り決め）。
 */

const readline = require('node:readline');
const crypto = require('node:crypto');

// ── 契約定数（functions / backend と一致させること。詳細は README.md）────────────────
/** テレメトリ・メソッドのスキーマ版。破壊的変更時に上げる。 */
const SCHEMA_VERSION = 1;
/** DOWN ダイレクトメソッドのメソッド名（backend の実 DeviceCommandPort 実装と一致させる）。 */
const DOWN_METHOD = 'down';
/** テレメトリ種別。 */
const TELEMETRY = Object.freeze({ ENTRY: 'entry', EXIT: 'exit', UP: 'up' });

// ── デバイス状態（簡易ステートマシン）──────────────────────────────────────────────
const state = {
  /** ロック板の位置。DOWN メソッドで down、up テレメトリ送出で up（手動）。 */
  plate: /** @type {'up'|'down'} */ ('up'),
  /** 区画の在車状態（表示用。クラウドは自前で導出するためあくまでローカルの見た目）。 */
  occupancy: /** @type {'vacant'|'occupied'} */ ('vacant'),
  /**
   * DOWN の挙動モード。
   * - 'ok': 通常どおり down にして成功応答。
   * - 'timeout': 応答を返さない（無応答＝接続ありタイムアウトを模擬。backend の 504 経路検証用）。
   */
  downMode: /** @type {'ok'|'timeout'} */ ('ok'),
  /** 処理済み requestId（冪等再送で板を再発火しないために覚えておく）。 */
  handledRequestIds: new Set(),
};

// ── 接続情報 ────────────────────────────────────────────────────────────────────
const connectionString = process.env.IOT_DEVICE_CONNECTION_STRING || '';
const online = connectionString.length > 0;
/** デバイス識別子。接続文字列の DeviceId= から拾い、無ければ env / 既定値。 */
const deviceId =
  parseDeviceId(connectionString) || process.env.DEVICE_ID || 'sim-device-01';

/** オンライン時のみ生成する IoT Hub クライアント（遅延 require でオフライン時は依存不要）。 */
let iotClient = null;

/**
 * 接続文字列から DeviceId を取り出す。
 * @param {string} cs IoT デバイス接続文字列
 * @returns {string} DeviceId（見つからなければ空文字）
 */
function parseDeviceId(cs) {
  const m = /(?:^|;)DeviceId=([^;]+)/.exec(cs);
  return m ? m[1] : '';
}

/**
 * テレメトリ・ペイロードを組み立てる。
 *
 * at-least-once 配信に備え、毎回ユニークな eventId を付ける（functions 側はこれで冪等化する。
 * バックエンド処理一覧 §B 実装メモ：同一イベントの二度処理に備える）。
 * @param {string} type entry|exit|up
 * @returns {{schemaVersion:number,type:string,deviceId:string,eventId:string,occurredAt:string}}
 */
function buildTelemetry(type) {
  return {
    schemaVersion: SCHEMA_VERSION,
    type,
    deviceId,
    eventId: crypto.randomUUID(),
    // 時刻はすべて UTC（CLAUDE.md）。表示時に JST 変換するのはクラウド/アプリ側の責務。
    occurredAt: new Date().toISOString(),
  };
}

/**
 * テレメトリを 1 件送出する。オンラインなら IoT Hub へ、オフラインなら標準出力へ。
 * @param {string} type entry|exit|up
 */
async function sendTelemetry(type) {
  const payload = buildTelemetry(type);

  // 送出に合わせてローカルの見た目状態も更新（あくまで表示用）。
  if (type === TELEMETRY.ENTRY) state.occupancy = 'occupied';
  if (type === TELEMETRY.EXIT) state.occupancy = 'vacant';
  if (type === TELEMETRY.UP) state.plate = 'up';

  if (!online) {
    console.log(`[offline] テレメトリ送出（dry-run）: ${JSON.stringify(payload)}`);
    return;
  }

  // オンライン: IoT Hub へ。azure-iot-device は遅延 require 済み（iotClient 生成時）。
  const { Message } = require('azure-iot-device');
  const msg = new Message(JSON.stringify(payload));
  msg.contentType = 'application/json';
  msg.contentEncoding = 'utf-8';
  // ルーティングしやすいようにアプリプロパティにも種別を載せる。
  msg.properties.add('telemetryType', type);
  try {
    await iotClient.sendEvent(msg);
    console.log(`[online] テレメトリ送出: ${JSON.stringify(payload)}`);
  } catch (err) {
    console.error(`[online] テレメトリ送出失敗: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * DOWN 指示を処理する（板を down にする）。オンラインのダイレクトメソッドと
 * オフラインの手動コマンドの両方からここに合流する。
 *
 * 冪等性: 同じ requestId は板を再発火せず成功扱いにする（物理安全。ADR 0003 §3）。
 * @param {string} requestId 冪等キー
 * @returns {{ok:true, replayed:boolean} | {ok:false, reason:'timeout'}}
 */
function handleDown(requestId) {
  // timeout モード: 応答しない＝無応答を模擬（板も動かさない）。
  if (state.downMode === 'timeout') {
    console.log(`[down] requestId=${requestId} → timeout モードのため無応答（板は ${state.plate} のまま）`);
    return { ok: false, reason: 'timeout' };
  }

  // 冪等再送: 既知 requestId なら再発火せず成功を返す。
  if (state.handledRequestIds.has(requestId)) {
    console.log(`[down] requestId=${requestId} → 冪等再送（板は再発火しない・現在 ${state.plate}）`);
    return { ok: true, replayed: true };
  }

  state.handledRequestIds.add(requestId);
  state.plate = 'down';
  console.log(`[down] requestId=${requestId} → 板を DOWN にしました`);
  return { ok: true, replayed: false };
}

/** オンライン時: IoT Hub に接続し、DOWN ダイレクトメソッドのハンドラを登録する。 */
async function connectIotHub() {
  // 遅延 require: オフライン経路では azure-iot-device に一切触れない（未インストールでも動く）。
  const { Client } = require('azure-iot-device');
  const { Mqtt } = require('azure-iot-device-mqtt');

  iotClient = Client.fromConnectionString(connectionString, Mqtt);
  await iotClient.open();
  console.log(`[online] IoT Hub に接続しました（deviceId=${deviceId}）`);

  // DOWN ダイレクトメソッド受信。payload.requestId を冪等キーに使う。
  iotClient.onDeviceMethod(DOWN_METHOD, (request, response) => {
    const requestId =
      (request.payload && request.payload.requestId) || '(requestId 欠落)';
    const result = handleDown(requestId);

    // timeout モードは応答を返さない（呼び出し側＝backend がタイムアウトする）。
    if (state.downMode === 'timeout') return;

    // 成功応答（200）。本文に板位置と冪等再送フラグを載せる。
    response.send(
      200,
      { ok: true, requestId, plate: state.plate, replayed: result.ok === true && result.replayed },
      (err) => {
        if (err) console.error(`[down] 応答送信失敗: ${err.message}`);
      },
    );
  });
}

// ── 対話 REPL（手動操作）────────────────────────────────────────────────────────
const HELP = `
コマンド:
  entry            在車検知テレメトリを送る（→ functions: onEntryDetected）
  exit             空車検知テレメトリを送る（→ functions: onExitDetected）
  up               UP 実行テレメトリを送る（→ functions: onPlateUp / 板=up）
  down [requestId] DOWN を手動実行（オフライン検証用。requestId 省略時は自動採番）
  mode ok|timeout  DOWN の挙動を切替（timeout=無応答で backend の 504 経路を模擬）
  status           現在のデバイス状態を表示
  help             このヘルプ
  quit             終了
`;

function printStatus() {
  console.log(
    `[status] deviceId=${deviceId} mode=${online ? 'online' : 'offline'} ` +
      `plate=${state.plate} occupancy=${state.occupancy} downMode=${state.downMode} ` +
      `handledDowns=${state.handledRequestIds.size}`,
  );
}

/**
 * 1 行のコマンドを処理する。
 * @param {string} line 入力行
 */
async function handleCommand(line) {
  const [cmd, arg] = line.trim().split(/\s+/, 2);
  switch (cmd) {
    case '':
      return;
    case 'entry':
      await sendTelemetry(TELEMETRY.ENTRY);
      return;
    case 'exit':
      await sendTelemetry(TELEMETRY.EXIT);
      return;
    case 'up':
      await sendTelemetry(TELEMETRY.UP);
      return;
    case 'down': {
      // オフライン検証用に手動で DOWN を流せるようにする（オンラインは Hub 経由が本筋）。
      const requestId = arg || `manual-${crypto.randomUUID()}`;
      handleDown(requestId);
      return;
    }
    case 'mode':
      if (arg === 'ok' || arg === 'timeout') {
        state.downMode = arg;
        console.log(`[mode] downMode=${arg}`);
      } else {
        console.log('使い方: mode ok|timeout');
      }
      return;
    case 'status':
      printStatus();
      return;
    case 'help':
      console.log(HELP);
      return;
    case 'quit':
      await shutdown();
      return;
    default:
      console.log(`未知のコマンド: ${cmd}（help でヘルプ）`);
  }
}

let rl = null;
let shuttingDown = false;

/** 後始末して終了する（quit コマンドと close イベントの双方から呼ばれるため二重実行を防ぐ）。 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n終了します…');
  try {
    if (rl) rl.close();
    if (iotClient) await iotClient.close();
  } catch (err) {
    console.error(`クローズ中エラー: ${/** @type {Error} */ (err).message}`);
  }
  process.exit(0);
}

async function main() {
  console.log('=== device-sim（AUTOSTAND 疑似デバイス）===');
  if (online) {
    await connectIotHub();
  } else {
    console.log(
      '[offline] IOT_DEVICE_CONNECTION_STRING 未設定のためオフライン dry-run で起動。\n' +
        '          テレメトリは標準出力に出ます。オンライン接続は `npm run start:env`。',
    );
  }
  printStatus();
  console.log(HELP);

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sim> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    try {
      await handleCommand(line);
    } catch (err) {
      console.error(`コマンド処理エラー: ${/** @type {Error} */ (err).message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => shutdown());
}

// Ctrl-C でも綺麗に終了。
process.on('SIGINT', () => shutdown());

main().catch((err) => {
  console.error(`起動失敗: ${err.message}`);
  process.exit(1);
});
