// 入植 ── 11-B（分村の方向）＋ #17 §6-5（分村の検査4行）＋ #17 §6-1（拠点）
//
// ここは**座標と土地だけ**を見る。人口・産出・不満は見ない（village.js の担当）。
// 目的は「この地図は 1,000村＝10万人 を収容できるか」「拠点は何村になるか」を測ること。
//
// 位置は**区画の単位**で持つ（1里＝4区画）。3里＝12区画、12里＝48区画。
import { W, N } from './mapgen.js';
import { PW, R } from './parcel.js';

export const PPL = 4;                    // 1里 ＝ 4区画
export const MIN_GAP = 3 * PPL;          // 11-B 4: 既存の村から3里以上
export const HUB_R   = 12 * PPL;         // §6-1: 拠点は根から12里以内
export const CLAIM = []; for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) if (dx*dx+dy*dy<=4) CLAIM.push([dx,dy]);
// §6-5 4c「半径2里（21里マス＝336区画）」＝ 5×5 から四隅を落とした21里マス
export const N21 = []; for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) if (dx*dx+dy*dy<=5) N21.push([dx,dy]);

const canFarm = (v) => v === R.PLAIN || v === R.WOOD || v === R.WASTE;

export function settle(g, L, seat, opts = {}) {
  const CAP = opts.cap || 1000;
  const rng = mulberry(opts.seed ?? (g.seed * 7919 + 13));
  const owned = new Uint8Array(L.b0.length);

  const vx = new Int32Array(CAP), vy = new Int32Array(CAP);
  const root = new Int32Array(CAP), parent = new Int32Array(CAP).fill(-1);
  let n = 0;
  const stat = { tries:0, gap:0, hab:0, c4c:0, c4d:0, over12:0, byR:new Array(13).fill(0) };

  const claimFor = (px, py) => { for (const [dx,dy] of CLAIM) {
    const p = (py+dy)*PW + (px+dx); if (p>=0 && p<owned.length) owned[p] = 1; } };

  // 創世の村
  vx[0] = seat % W * PPL + 2; vy[0] = ((seat / W) | 0) * PPL + 2; root[0] = 0; n = 1;
  claimFor(vx[0], vy[0]);

  // 11-B: 親が30軒に達するたびに発火する。ここでは待ち行列で近似する
  //   （分けたあと親はまた30軒まで戻るので、親も列に戻す）
  const q = [0];
  while (q.length && n < CAP) {
    const v = q.shift();
    const born = trySplit(v);
    if (born >= 0) { q.push(v); q.push(born); }      // 親は31軒目へ向けて生き続ける
  }
  return { n, vx, vy, root, parent, owned, stat, hubs: hubStats() };

  // ── 11-B 本体
  function trySplit(v) {
    // 1-2. 既存の全村への方位角のうち、隙間が最大の場所の中央を θ にする
    let th;
    if (n === 1) th = rng() * Math.PI * 2;
    else {
      const a = [];
      for (let k = 0; k < n; k++) { if (k === v) continue;
        a.push(Math.atan2(vy[k]-vy[v], vx[k]-vx[v])); }
      a.sort((p,q2)=>p-q2);
      let best = -1, bth = 0;
      for (let k = 0; k < a.length; k++) {
        const lo = a[k], hi = (k+1 < a.length) ? a[k+1] : a[0] + Math.PI*2;
        if (hi - lo > best) { best = hi - lo; bth = (lo + hi) / 2; }
      }
      th = bth;
    }
    // 3-4. r = 4〜6里。θ を 40°ずつ最大8回、だめなら r += 2。r > 12里 で分村しない
    let r = (4 + rng() * 2) * PPL;
    while (r <= 12 * PPL) {
      for (let t = 0; t < 8; t++) {
        const px = Math.round(vx[v] + Math.cos(th) * r);
        const py = Math.round(vy[v] + Math.sin(th) * r);
        if (ok(px, py)) { stat.byR[Math.min(12,Math.round(r/PPL))]++; return place(px, py, v); }
        th += 40 * Math.PI / 180;
      }
      r += 2 * PPL;
    }
    stat.over12++;
    return -1;                                        // 「溢れたまま」（11-I の固まる側）
  }

  function ok(px, py) {
    stat.tries++;
    if (px < 2 || py < 2 || px >= PW-2 || py >= PW-2) return false;
    for (let k = 0; k < n; k++) {                     // 4. 既存のどの村からも3里以上
      const dx = px-vx[k], dy = py-vy[k];
      if (dx*dx + dy*dy < MIN_GAP*MIN_GAP) return false;
    }
    stat.gap++;
    const tx = (px / PPL) | 0, ty = (py / PPL) | 0;
    if (!g.hab[ty*W + tx]) return false;               // 4a. 居住可能
    stat.hab++;
    // 4c/4d. 半径2里（21里マス＝336区画）のうち、無主かつ人工化できる区画が11以上、
    //        そのうち 肥沃≥8 が6以上
    let free = 0, rich = 0;
    for (const [ax,ay] of N21) {
      const jx = tx+ax, jy = ty+ay; if (jx<0||jy<0||jx>=W||jy>=W) continue;
      const f = g.fert[jy*W + jx];
      for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) {
        const p = (jy*PPL+ly)*PW + (jx*PPL+lx);
        if (owned[p]) continue;
        const role = L.b0[p] & 15;
        if (!canFarm(role)) continue;
        free++;
        // 荒地の地力は0（§9-3）。平野と森林は里マスの肥沃度で始まる（§3-2）
        if (role !== R.WASTE && f >= 8) rich++;
      }
    }
    if (free < 11) return false;  stat.c4c++;
    if (rich < 6) return false;   stat.c4d++;
    return true;
  }

  function place(px, py, from) {
    const i = n++;
    vx[i] = px; vy[i] = py; parent[i] = from;
    // §6-1: 親の根から12里以内なら同じ拠点。超えたらそこが新しい木の根
    const rt = root[from];
    const dx = px-vx[rt], dy = py-vy[rt];
    root[i] = (dx*dx + dy*dy <= HUB_R*HUB_R) ? rt : i;
    claimFor(px, py);
    return i;
  }

  function hubStats() {
    const m = new Map();
    for (let i = 0; i < n; i++) m.set(root[i], (m.get(root[i]) || 0) + 1);
    const sizes = [...m.values()].sort((a,b)=>b-a);
    return { count: m.size, sizes,
             max: sizes[0] || 0, avg: n / (m.size || 1),
             solo: sizes.filter(s=>s===1).length,
             ge50: sizes.filter(s=>s>=50).length };
  }
}

function mulberry(a) { return function () {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
