// sim の解決。src/sim/index.js があればそれを使い、無い関数だけ mock で埋める。
// UI は必ずこの api 越しに sim を呼ぶ。直接 import しないこと。

import * as mock from './mock.js';

let real = null;
try {
  real = await import('../sim/index.js');
} catch (e) {
  try { real = await import('../sim/world.js'); } catch (e2) { real = null; }
}

const missing = new Set();

export const api = new Proxy({}, {
  get(_, k) {
    if (typeof k !== 'string') return undefined;
    if (real && k in real && real[k] !== undefined) return real[k];
    if (k in mock) { if (real) missing.add(k); return mock[k]; }
    return undefined;
  },
  has(_, k) { return (real && k in real) || k in mock; },
});

export const SIM_SOURCE = real ? 'sim' : 'mock';
export const SIM_MISSING = missing;   // 実 sim にまだ無くて mock で埋めた関数名
export const rawSim = real;
