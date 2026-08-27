// 土地と村を繋ぐ ── #17 の地図（層A・層B・霧）を、village.js の村に結ぶ。
//
// ★ ここが「地図」と「人口シミュレータ」の唯一の接点。
//   village.js は座標を持たない（「座標は UI 側だけが持つ」）ままにして、
//   座標と区画はこの層が持つ。依存の向きは land → (mapgen/parcel/settle/fog) の一方向。
import { W, N } from './mapgen.js';
import { PW, R } from './parcel.js';
import { CLAIM, N21, PPL, MIN_GAP } from './settle.js';
import * as F from './fog.js';

// §2-1 の定員（1区画が何人月を吸えるか）
export const CAP_FIELD = 7;     // 畑（三圃）
export const CAP_FOREST = 6;    // 森林

/** 村ごとの土地。村ID → { px, py, cells[13], fieldCap, forestCap } */
export class Land {
  constructor(g, L) {
    this.g = g; this.L = L;
    this.owned = new Uint8Array(L.b0.length);
    this.px = []; this.py = []; this.cells = [];
    this.fieldCap = []; this.forestCap = [];
    this.fog = F.makeFog();
  }

  /** 村を置いて 13区画を claim する（#17 §6-4。地形による除外は掛けない） */
  place(v, px, py) {
    this.px[v] = px; this.py[v] = py;
    const cells = [];
    for (const [dx, dy] of CLAIM) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= PW || y >= PW) continue;
      const p = y * PW + x;
      if (this.owned[p]) continue;              // 先に取った村のもの（Voronoi の代わり）
      this.owned[p] = 1; cells.push(p);
    }
    this.cells[v] = cells;
    this.recap(v);
    return cells.length;
  }

  /** 定員を数え直す。**畑と森の定員が crowd の分母になる**（#17 §2-2） */
  recap(v) {
    let field = 0, forest = 0;
    for (const p of this.cells[v]) {
      const role = this.L.b0[p] & 15;
      // 畑にできる区画（平野・荒地・森林）は、いずれ畑になる ＝ 畑の定員に数える
      if (role === R.PLAIN || role === R.WASTE) field++;
      else if (role === R.WOOD) { forest++; field++; }   // 森林は森の定員でもあり、伐れば畑
    }
    this.fieldCap[v] = field * CAP_FIELD;
    this.forestCap[v] = forest * CAP_FOREST;
  }

  /** 分村できる場所を探す（11-B ＋ #17 §6-5 の 4a/4c/4d） */
  findSplit(parent, nVillages, rng) {
    const g = this.g, L = this.L;
    // 1-2. 既存の全村への方位角のうち、隙間が最大の場所の中央
    let th;
    if (nVillages <= 1) th = rng() * Math.PI * 2;
    else {
      const a = [];
      for (let k = 0; k < nVillages; k++) { if (k === parent || this.px[k] === undefined) continue;
        a.push(Math.atan2(this.py[k] - this.py[parent], this.px[k] - this.px[parent])); }
      a.sort((p, q) => p - q);
      let best = -1; th = 0;
      for (let k = 0; k < a.length; k++) {
        const lo = a[k], hi = (k + 1 < a.length) ? a[k + 1] : a[0] + Math.PI * 2;
        if (hi - lo > best) { best = hi - lo; th = (lo + hi) / 2; }
      }
    }
    let r = (4 + rng() * 2) * PPL;
    while (r <= 12 * PPL) {
      for (let t = 0; t < 8; t++) {
        const px = Math.round(this.px[parent] + Math.cos(th) * r);
        const py = Math.round(this.py[parent] + Math.sin(th) * r);
        if (this.ok(px, py, nVillages)) return { px, py, r: r / PPL };
        th += 40 * Math.PI / 180;
      }
      r += 2 * PPL;
    }
    return null;                       // r > 12里 ＝ 分村しない（「溢れたまま」）
  }

  ok(px, py, n) {
    if (px < 2 || py < 2 || px >= PW - 2 || py >= PW - 2) return false;
    for (let k = 0; k < n; k++) {      // 4. 既存のどの村からも3里以上
      if (this.px[k] === undefined) continue;
      const dx = px - this.px[k], dy = py - this.py[k];
      if (dx * dx + dy * dy < MIN_GAP * MIN_GAP) return false;
    }
    const tx = (px / PPL) | 0, ty = (py / PPL) | 0;
    if (!this.g.hab[ty * W + tx]) return false;                 // 4a. 居住可能
    if (!F.isKnown(this.fog, ty * W + tx)) return false;        // 4b. 既知（★ 霧が効く）
    let free = 0, rich = 0;                                     // 4c/4d
    for (const [ax, ay] of N21) {
      const jx = tx + ax, jy = ty + ay;
      if (jx < 0 || jy < 0 || jx >= W || jy >= W) continue;
      const f = this.g.fert[jy * W + jx];
      for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) {
        const p = (jy * PPL + ly) * PW + (jx * PPL + lx);
        if (this.owned[p]) continue;
        const role = this.L.b0[p] & 15;
        if (role !== R.PLAIN && role !== R.WASTE && role !== R.WOOD) continue;
        free++;
        if (role !== R.WASTE && f >= 8) rich++;
      }
    }
    return free >= 11 && rich >= 6;
  }

  /** 毎月：霧を引き直す（#17 §6-8。beginMonth → 拠点 の順） */
  fogMonth(nVillages) {
    F.beginMonth(this.fog);
    for (let v = 0; v < nVillages; v++) {
      if (this.px[v] === undefined) continue;
      const cx = (this.px[v] / PPL) | 0, cy = (this.py[v] / PPL) | 0;
      F.reveal(this.fog, cx, cy, 4, 1);
      F.reveal(this.fog, cx, cy, 2, 2);
    }
  }
  /** 分村したとき：親→子の道すじも晴れる（§6-8） */
  fogSplit(px0, py0, px1, py1) {
    F.splitReveal(this.fog, (px0 / PPL) | 0, (py0 / PPL) | 0, (px1 / PPL) | 0, (py1 / PPL) | 0);
  }
}
