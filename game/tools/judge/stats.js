// 判定に使う統計の原始関数。
//
// 方針：t分布やF分布の数表を実装しない。**並べ替え検定とブートストラップだけ**で通す。
// 理由は2つ。(1) 分布の仮定を置かずに済む（世代シミュの成績は正規から遠い。絶滅で0に
// 潰れる裾を持つ）。(2) 実装ミスが検定の甘さとして静かに出ない——並べ替えは定義から
// 直に書けるので、間違えると明らかに壊れる。
//
// 乱数は src/core/rng.js と同じ xorshift32。Math.random() は使わない。

import { RNG } from '../../src/core/rng.js';

export { RNG };

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

export const sd = (xs) => Math.sqrt(variance(xs));

/** 標準誤差。ばらつきではなく「平均がどれだけ当てにならないか」 */
export const sem = (xs) => (xs.length ? sd(xs) / Math.sqrt(xs.length) : NaN);

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export const median = (xs) => quantile(xs, 0.5);

/** 平均のブートストラップ信頼区間。分布を仮定しない。 */
export function bootstrapMeanCI(xs, rng, B = 2000, alpha = 0.05) {
  if (xs.length < 2) return { lo: xs[0] ?? NaN, hi: xs[0] ?? NaN };
  const boots = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[rng.int(xs.length)];
    boots[b] = s / xs.length;
  }
  return { lo: quantile(boots, alpha / 2), hi: quantile(boots, 1 - alpha / 2) };
}

/**
 * 2群の平均差の並べ替え検定（両側）。
 * 帰無仮説「ラベルは成績と無関係」の下でラベルを混ぜ直し、観測した差以上が出る割合を返す。
 */
export function permTestDiff(a, b, rng, B = 4000) {
  const obs = Math.abs(mean(a) - mean(b));
  const all = [...a, ...b];
  const na = a.length;
  let ge = 0;
  for (let i = 0; i < B; i++) {
    rng.shuffle(all);
    const m1 = mean(all.slice(0, na));
    const m2 = mean(all.slice(na));
    if (Math.abs(m1 - m2) >= obs - 1e-12) ge++;
  }
  return (ge + 1) / (B + 1); // +1 は 0 を返さないための補正（Davison–Hinkley）
}

/**
 * 対応のある差の並べ替え検定。同じ種で2方針を回したときはこちら。
 * 種のばらつきが両方に乗るので、対応なしより桁で鋭い。
 */
export function permTestPaired(a, b, rng, B = 4000) {
  const d = a.map((x, i) => x - b[i]);
  const obs = Math.abs(mean(d));
  let ge = 0;
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let j = 0; j < d.length; j++) s += rng.bool() ? d[j] : -d[j];
    if (Math.abs(s / d.length) >= obs - 1e-12) ge++;
  }
  return (ge + 1) / (B + 1);
}

/** 効果量。平均差を「ばらつき何個分か」に直す。0.2小 / 0.5中 / 0.8大 */
export function cohenD(a, b) {
  const va = variance(a), vb = variance(b);
  const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / Math.max(1, a.length + b.length - 2));
  return pooled > 0 ? (mean(a) - mean(b)) / pooled : 0;
}

/** P(ランダムに1本ずつ引いて a が b を上回る)。プレイヤーが体感する「上手さの効き」 */
export function probSuperior(a, b) {
  let win = 0, tie = 0;
  for (const x of a) for (const y of b) { if (x > y) win++; else if (x === y) tie++; }
  return (win + tie / 2) / (a.length * b.length);
}

/** Holm補正。多重比較で「10本も比べれば1本は当たる」を潰す。 */
export function holm(pvals) {
  const idx = pvals.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(pvals.length);
  let prev = 0;
  for (let k = 0; k < idx.length; k++) {
    const adj = Math.min(1, Math.max(prev, (pvals.length - k) * idx[k][0]));
    out[idx[k][1]] = adj;
    prev = adj;
  }
  return out;
}

/** 順位（1が最良、同値は平均順位） */
export function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function zscore(xs) {
  const m = mean(xs), s = sd(xs);
  return s > 0 ? xs.map((x) => (x - m) / s) : xs.map(() => 0);
}

export const fmt = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : 'n/a');
