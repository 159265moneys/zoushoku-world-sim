// 土地と村を繋ぐ ── #17 の地図（層A・層B・霧）を、village.js の村に結ぶ。
//
// ★ ここが「地図」と「人口シミュレータ」の唯一の接点。
//   village.js は座標を持たない（「座標は UI 側だけが持つ」）ままにして、
//   座標と区画はこの層が持つ。依存の向きは land → (mapgen/parcel/settle/fog) の一方向。
import { W, N } from './mapgen.js';
import { PW, R } from './parcel.js';
import { CLAIM, N21, PPL, MIN_GAP } from './settle.js';

// ★ 地力の基準（#17 §5-1）。ここで倍率が厳密に 1.000 になる
export const FERT_BASE = 8, FERT_POW = 0.6;
/** 地力の倍率 `(地力/8)^0.6`。★ 人工の耕地にだけ掛ける（森・川・海湖・鉱脈には掛けない） */
export const fertMul = (f) => Math.pow(Math.max(0, f) / FERT_BASE, FERT_POW);
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

  /** 定員を数え直す。**畑と森の定員が crowd の分母になる**（#17 §2-2）
   *
   * ★★ 2026-08-31：**「畑にできる区画」ではなく「実際の耕地」を数えるように直した。**★★
   *   旧実装は 平野・荒地・森林を畑の定員に足していたので、13区画そろった村は
   *   定員 13×7 ＝ **91人月**を持っていた。正典9857 は
   *   「段2の標準村は **畑6（定員42）**が38.5を、**森林3（定員18）**が16.5を全部飲む」
   *   と書いており、**正典の2.2倍**だった。これが「300年走らせても crowdF が
   *   一度も1.000を割らない ＝ 土地が一度も効かない」の正体（M-48）。
   *   耕地は #17 §4-2 の**開墾で作る**もので、最初から在るものではない。
   */
  recap(v) {
    let field = 0, forest = 0;
    for (const p of this.cells[v]) {
      const role = this.L.b0[p] & 15;
      // 人工の耕地6種だけが畑の定員を持つ（拠点地・工事中・自然は持たない）
      if (role >= R.FIELD && role <= R.PADDY) field++;
      else if (role === R.WOOD) forest++;
    }
    this.fieldCap[v] = field * CAP_FIELD;
    this.forestCap[v] = forest * CAP_FOREST;

    // ★ 地力（#17 §5-1 の `(地力/8)^0.6`。**人工の耕地にだけ掛かる**）。
    //   その村が持つ「畑にできる区画」の地力の平均。基準は 8 ＝ そこで倍率が厳密に 1.000。
    //   正典5-1「基準の村（地力8・crowd 1.00・F[具] 0.50・収穫1.00・道具1.00）では
    //   5項とも厳密に 1.000。だから 135.8／117.3／分岐点 が動かない」
    //   ★ 2026-08-31：**区画が持つ地力（byte0 bit4-7）を読む。**旧実装は里マスの
    //     肥沃度を読んでいたので、開墾で地力を持ち越しても（§9-3 抜け道1の塞ぎ）
    //     効かなかった。荒地から開いた畑は地力0 で、正典どおり産出0になる。
    let fs = 0, fn = 0;
    for (const p of this.cells[v]) {
      const role = this.L.b0[p] & 15;
      if (role < R.FIELD || role > R.PADDY) continue;
      fs += this.L.b0[p] >> 4; fn++;
    }
    this.fert = this.fert || [];
    this.fert[v] = fn ? fs / fn : FERT_BASE;
  }

  /**
   * 村を立ち上げるときに書き込む区画（工事キューを**通さない**）。
   *   分村 … 拠点地1枚だけ（正典8810「分村が作る最初の拠点地区画だけは 11-B が直接書き込む。
   *          これが無いと、新村は自分の拠点地を建てられず、分村そのものが成立しない」）
   *   創世 … それに加えて **畑6枚**（正典9857「段2の標準村は畑6（定員42）」・
   *          正典8202「創世の村の畑区画の初期地力は8」）
   * ★ 分村に畑を渡さないのは正典どおり。**娘村は開墾で畑を作る。**
   */
  seedParcels(v, fields = 0) {
    const cells = this.cells[v] ?? [];
    let home = 0, made = 0;
    for (const p of cells) {
      const role = this.L.b0[p] & 15;
      if (!home && (role === R.PLAIN || role === R.WASTE)) {       // 拠点地は1枚
        this.L.b0[p] = R.HOME; this.L.b1[p] |= 2; home = 1; continue;
      }
      if (made >= fields) continue;
      if (role !== R.PLAIN) continue;                              // 畑は平野からだけ開く
      const fert = this.L.b0[p] >> 4;                              // 平野の状態値＝里マスの肥沃度
      this.L.b0[p] = R.FIELD | (fert << 4); this.L.b1[p] |= 2; made++;
    }
    this.recap(v);
    return { home, fields: made };
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
  /**
   * 霧の年次。**最後に見てからの経過年数を1つ進める**（既知だが可視でない土地だけ）。
   * ★ #17 §6-6 が「毎年1月に1回」と決めており、これが霧の要（「N年前に見た地図」）。
   *   呼んでいなかったので、経過年数が一度も進んでいなかった（2026-08-29 に繋いだ）。
   */
  fogYear() { F.ageFog(this.fog); }

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
