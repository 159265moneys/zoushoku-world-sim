// 霧 ── 見え方の3段（#17 §6-6）と、晴れ方（§6-8）
//
// ★ 層A の余りビットに混ぜてはいけない。層Aは種から再生成できるがセーブに載せない。
//   霧は再生成できない遊び手固有の状態で、**セーブに載る唯一の地図データ**（144KB）。
//
// byte : bit0   既知（地形・川・海・鉱種が見える。ただし最後に見た年の状態）
//        bit1   可視（いまの状態が全部。区画1枚ずつ）
//        bit2-7 最後に見てから経過した年数 0..62（63 ＝ 63年以上前）
import { W, N } from './mapgen.js';

export const KNOWN = 1, SEEN = 2, AGE = 0xFC;
export const makeFog = () => new Uint8Array(N);          // 147,456B ＝ 144KB

export const isKnown = (f, i) => (f[i] & KNOWN) !== 0;
export const isSeen  = (f, i) => (f[i] & SEEN)  !== 0;
export const ageOf   = (f, i) => f[i] >> 2;

/** 円形に霧を晴らす。level 2＝可視（既知も立つ）／1＝既知だけ */
export function reveal(f, cx, cy, r, level) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy; if (y < 0 || y >= W) continue;
    const w = Math.floor(Math.sqrt(r2 - dy * dy));
    for (let dx = -w; dx <= w; dx++) {
      const x = cx + dx; if (x < 0 || x >= W) continue;
      const i = y * W + x;
      f[i] = (f[i] | KNOWN | (level >= 2 ? SEEN : 0)) & ~AGE;   // 見た年に戻す
    }
  }
}

/** 毎月：拠点の周りを塗り直す（§6-8 拠点そのもの＝半径2里 可視／外周2〜4里 既知） */
export function fromSettlements(f, S, n = S.n, PPL = 4) {
  for (let i = 0; i < N; i++) f[i] &= ~SEEN;               // 可視は毎月引き直す
  for (let k = 0; k < n; k++) {
    const cx = (S.vx[k] / PPL) | 0, cy = (S.vy[k] / PPL) | 0;
    reveal(f, cx, cy, 4, 1);                               // 外周 ＝ 既知
    reveal(f, cx, cy, 2, 2);                               // 中心 ＝ 可視
  }
}

/** 斥候：幅3里の帯を進む。月に12里マス進み、帯が既知・中心線が可視（§6-8） */
export function scout(f, x0, y0, dirRad, months = 1) {
  const steps = 12 * months;
  let x = x0, y = y0;
  const dx = Math.cos(dirRad), dy = Math.sin(dirRad);
  for (let s = 0; s < steps; s++) {
    x += dx; y += dy;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= W) break;
    reveal(f, ix, iy, 1, 1);      // 幅3里の帯（半径1里）＝ 既知
    const i = iy * W + ix;
    f[i] = (f[i] | KNOWN | SEEN) & ~AGE;                   // 中心線は一時的に可視
  }
  return { x, y };
}

/** 毎年1月：既知かつ非可視の里マスだけ +1（63で止める） */
export function ageFog(f) {
  for (let i = 0; i < N; i++) {
    if ((f[i] & KNOWN) === 0 || (f[i] & SEEN) !== 0) continue;
    const a = f[i] >> 2;
    if (a < 63) f[i] = (f[i] & ~AGE) | ((a + 1) << 2);
  }
}

export function stats(f, g) {
  let unknown = 0, known = 0, seen = 0, landKnown = 0, land = 0, oreKnown = 0, ore = 0;
  for (let i = 0; i < N; i++) {
    const k = f[i] & KNOWN, s = f[i] & SEEN;
    if (s) seen++; else if (k) known++; else unknown++;
    if (g.land[i]) { land++; if (k) landKnown++; }
    if (g.ore[i]) { ore++; if (k) oreKnown++; }
  }
  return { unknown, known, seen, landKnown, land, oreKnown, ore, bytes: f.byteLength };
}
