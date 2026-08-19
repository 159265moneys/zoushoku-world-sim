// sim の解決と名前の吸収層。UI は必ずこの api 越しに sim を呼ぶ（直接 import しない）。
//
// 既定は mock。src/sim の経済が落ち着いたら DEFAULT_SOURCE を 'sim' にするだけで切り替わる。
//   ?sim=sim   … 本物の src/sim を使う
//   ?sim=mock  … mock を使う（既定）
//
// 本物の sim は名前が一部違うので、ここで UI 側の呼び名に写す。
// UI のコードは一切変えない。ズレはすべてこのファイルに閉じ込める。

import * as mock from './mock.js';

const DEFAULT_SOURCE = 'mock';

const params = new URLSearchParams(location.search);
const want = params.get('sim') || DEFAULT_SOURCE;

let real = null;
if (want === 'sim' || want === 'real') {
  try { real = await import('../sim/index.js'); }
  catch (e) { console.warn('[api] src/sim の読み込みに失敗したので mock を使う', e); real = null; }
}

// 本物の sim の名前 -> UI が呼んでいる名前
const ALIAS = {
  powerOf: 'citizenPower',
  nationPower: 'rankNation',
  canonize: 'setCanon',
  stepRoster: 'advanceRoster',
  createRoster: 'createRoster',
  listOpponents: 'listOpponents',
  peek: 'peek',
};

const filled = new Set();   // 本物に無くて mock で埋めた名前

function resolve(k) {
  if (real) {
    if (k in real && real[k] !== undefined) return real[k];
    const a = ALIAS[k];
    if (a && a in real && real[a] !== undefined) return real[a];
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

if (real) {
  // どの関数が mock 由来のままかを起動時に一度だけ出す（無言で混ざるのが一番危ない）
  setTimeout(() => {
    if (filled.size) console.info('[api] mock で埋めている関数:', [...filled].join(', '));
  }, 0);
}
