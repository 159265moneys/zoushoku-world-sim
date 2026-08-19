// テスト基盤の共有ユーティリティ。統計・決定的ハッシュ・ASCIIグラフ。
// Math.random() / Date.now() はこのディレクトリのどこにも書かない。

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function round(x, d = 4) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

export function mean(a) {
  if (!a.length) return 0;
  let s = 0; for (const x of a) s += x;
  return s / a.length;
}
export function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0; for (const x of a) s += (x - m) * (x - m);
  return Math.sqrt(s / (a.length - 1));
}
export function quantile(a, q) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1);
  return s[i];
}
export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 1e-12 || syy <= 1e-12) return 0;
  return sxy / Math.sqrt(sxx * syy);
}
export function euclid(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// ---- 決定的ハッシュ（FNV-1a 32bit）----
export class Hasher {
  constructor() { this.h = 0x811c9dc5; }
  push(s) {
    const str = String(s);
    let h = this.h;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.h = h >>> 0;
    return this;
  }
  get hex() { return ('00000000' + this.h.toString(16)).slice(-8); }
}
export function hashOf(parts) {
  const h = new Hasher();
  for (const p of parts) h.push(p).push('|');
  return h.hex;
}

// ---- ASCIIグラフ ----

/** 時系列を width 列 × height 行の折れ線に落とす。0..1 前提だが lo/hi 指定可。 */
export function lineChart(series, opts = {}) {
  const width = opts.width ?? 64;
  const height = opts.height ?? 12;
  const lo = opts.lo ?? 0, hi = opts.hi ?? 1;
  if (!series.length) return '(no data)';
  // 平均でダウンサンプル
  const cols = [];
  for (let c = 0; c < width; c++) {
    const a = Math.floor(c * series.length / width);
    const b = Math.max(a + 1, Math.floor((c + 1) * series.length / width));
    cols.push(mean(series.slice(a, b)));
  }
  const grid = [];
  for (let r = 0; r < height; r++) grid.push(new Array(width).fill(' '));
  for (let c = 0; c < width; c++) {
    const t = clamp((cols[c] - lo) / (hi - lo || 1), 0, 1);
    const r = clamp(height - 1 - Math.round(t * (height - 1)), 0, height - 1);
    grid[r][c] = '*';
  }
  const out = [];
  for (let r = 0; r < height; r++) {
    const v = hi - (r / (height - 1)) * (hi - lo);
    out.push(v.toFixed(2).padStart(5) + ' |' + grid[r].join(''));
  }
  out.push('      +' + '-'.repeat(width));
  const lab = opts.xlabel ?? `0 .. ${series.length}`;
  out.push('       ' + lab);
  return out.join('\n');
}

/** ラベル付き横棒。rows = [[label, value], ...] */
export function barChart(rows, opts = {}) {
  const width = opts.width ?? 40;
  const max = opts.max ?? Math.max(1e-9, ...rows.map(r => r[1]));
  const lw = Math.max(...rows.map(r => strWidth(r[0])), 4);
  return rows.map(([label, v]) => {
    const n = clamp(Math.round((v / max) * width), 0, width);
    const fmt = opts.fmt ? opts.fmt(v) : String(round(v, 3));
    return padTo(label, lw) + ' |' + '#'.repeat(n) + ' '.repeat(width - n) + '| ' + fmt;
  }).join('\n');
}

/** 数値配列のヒストグラム。 */
export function histogram(values, opts = {}) {
  const bins = opts.bins ?? 10;
  const lo = opts.lo ?? Math.min(...values, 0);
  const hi = opts.hi ?? Math.max(...values, 1);
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const i = clamp(Math.floor((v - lo) / ((hi - lo) || 1) * bins), 0, bins - 1);
    counts[i]++;
  }
  const rows = counts.map((c, i) => {
    const a = lo + (hi - lo) * i / bins, b = lo + (hi - lo) * (i + 1) / bins;
    return [`${fmtNum(a)}-${fmtNum(b)}`, c];
  });
  return barChart(rows, { width: opts.width ?? 40, fmt: v => String(v) });
}
function fmtNum(x) { return Number.isInteger(x) ? String(x) : x.toFixed(1); }

// 全角を2幅として数えるゆるい整形（レポートの表を崩さないため）
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}
function padTo(s, w) {
  const cur = strWidth(s);
  return String(s) + ' '.repeat(Math.max(0, w - cur));
}
export { strWidth, padTo };

export function pct(x) { return (x * 100).toFixed(1) + '%'; }
