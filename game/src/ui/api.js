// sim の解決と名前の吸収層。UI は必ずこの api 越しに sim を呼ぶ（直接 import しない）。
//
// 既定は mock。src/sim の経済が落ち着いたら DEFAULT_SOURCE を 'sim' にするだけで切り替わる。
//   ?sim=sim   … 本物の src/sim を使う
//   ?sim=mock  … mock を使う（既定）
//
// 本物の sim は名前が一部違うので、ここで UI 側の呼び名に写す。
// UI のコードは一切変えない。ズレはすべてこのファイルに閉じ込める。

import * as mock from './mock.js';
import { makeAdapter, setRoster, adaptWorld } from './adapter.js';

const DEFAULT_SOURCE = 'sim';

const params = new URLSearchParams(location.search);
const want = params.get('sim') || DEFAULT_SOURCE;

let real = null;
if (want !== 'mock') {
  try { real = await import('../sim/index.js'); }
  catch (e) { console.warn('[api] src/sim の読み込みに失敗したので mock を使う', e); real = null; }
}

// 本物の sim は world も battle も UI とは違う形を持っている。
// 名前の別名だけでは足りないので、adapter.js が形ごと写す。
const bridge = real ? makeAdapter(real) : null;

const filled = new Set();   // 本物にも adapter にも無くて mock で埋めた名前

function resolve(k) {
  if (bridge) {
    if (k in bridge && bridge[k] !== undefined) return bridge[k];
    if (k in real && real[k] !== undefined) return real[k];
  }
  if (k in mock) { if (real) filled.add(k); return mock[k]; }
  return undefined;
}

export const api = new Proxy({}, {
  get(_, k) { return typeof k === 'string' ? resolve(k) : undefined; },
  has(_, k) { return resolve(k) !== undefined; },
});

export const SIM_SOURCE = real ? 'sim' : 'mock';
export const SIM_FILLED = filled;
export const rawSim = real;

/** roster を adapter に預ける（startWar が相手の world を引くのに要る） */
export function registerRoster(roster) { setRoster(roster); }

/**
 * 進行層（flow/run.js の createRun）が作った world に、画面が読む面を生やす。
 * 世界を作るのは flow の仕事になったので、写し取りだけをここから呼べるようにする。
 *
 * 注意：**世界を進めるのは常に本物の sim**（`src/flow/` は sim を直に import する）。
 * `?sim=mock` で落ちてくるのは「本物に無い関数の穴埋め」だけで、mock が世界を
 * 走らせることはもう無い。本物が読めないときは画面が成立しないので、黙らない。
 */
export function adapt(world) { return adaptWorld(world); }

if (!real) {
  console.error('[api] src/sim が読めていない。進行層（src/flow/）は sim を直接使うので、'
    + 'この状態では画面と世界が食い違う。ビルドが壊れている。');
}

if (real) {
  // どの関数が mock 由来のままかを起動時に一度だけ出す（無言で混ざるのが一番危ない）
  setTimeout(() => {
    if (filled.size) console.info('[api] mock で埋めている関数:', [...filled].join(', '));
  }, 0);
}
