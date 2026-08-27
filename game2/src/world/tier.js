// 段 ── 集落が村から首都まで育つ（2026-08-27 のオーナー裁定）
//
// ★ 裁定：村は分けて飛ばすだけでなく **その場で太る**。30→60→120→240→480→960軒。
//   だから #17 §6-1 の「拠点＝分村の木の根から12里以内の村の集合」は**要らなくなる。**
//   §6-1 が自分で書いた存在理由（「30軒で必ず分村するなら100人を超える拠点が
//   原理的に発生しない」）が、その場で太れる時点で消えるため。**拠点＝村。**
//
// ★ 裁定：段の門は「人が住む建物の数」。分岐は発展度。人口は付随値。
import { W } from './mapgen.js';
import { PW, R } from './parcel.js';
import { PPL } from './settle.js';

// 段ごとの：人が住む建物・建築枠・公共枠・拠点地区画・claim半径（区画）
export const TIER = [
  { name: '開拓地', homes:   9, build:   12, pub:   2, hub:  1, r:  2 },
  { name: '村',     homes:  30, build:   32, pub:   6, hub:  2, r:  2 },
  { name: '大村',   homes:  60, build:   68, pub:  12, hub:  3, r:  3 },
  { name: '町',     homes: 120, build:  150, pub:  24, hub:  5, r:  4, dev: 20 },
  { name: '都市',   homes: 240, build:  320, pub:  48, hub: 11, r:  6, dev: 30 },
  { name: '大都市', homes: 480, build:  680, pub:  96, hub: 23, r:  8, dev: 40 },
  { name: '首都',   homes: 960, build: 1400, pub: 200, hub: 47, r: 12, dev: 50 },
];
// 1人が住む建物あたりの人数（疎＝木造家屋4人／密＝長屋の混ざった街）
const PPH = [3.5, 3.8, 4.0, 4.4, 5.2, 6.0, 6.6];

// 拠点地にできる区画（平野・荒地・森林。山と川と海湖と鉱脈と使用不可は不可）
const buildable = (v) => v === R.PLAIN || v === R.WASTE || v === R.WOOD;

/**
 * 段を割り当てる。**育つ順は「交易の便」で決める。**
 *   川の等級 ＋ 海への接続 ＋ 他の集落への近さ（中心性）。
 *   歴史的に都は結節点に立つ。創世の村は最初の1つなので下駄を履かせる。
 */
export function assignTiers(g, L, S, target) {
  const n = S.n;
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tx = (S.vx[i] / PPL) | 0, ty = (S.vy[i] / PPL) | 0;
    const t = ty * W + tx;
    let s = g.river[t] * 3 + g.coast[t] * 2 + g.fert[t] * 0.2;
    // 中心性：12里以内の他の集落の数
    let near = 0;
    for (let k = 0; k < n; k++) { if (k === i) continue;
      const dx = S.vx[i]-S.vx[k], dy = S.vy[i]-S.vy[k];
      if (dx*dx + dy*dy <= (12*PPL)*(12*PPL)) near++; }
    s += near * 0.5;
    if (i === 0) s += 8;                       // 創世の村（最初に立った利）
    score[i] = s;
  }
  const order = [...Array(n).keys()].sort((a, b) => score[b] - score[a]);

  const tier = new Uint8Array(n);
  const owned = new Uint8Array(L.b0.length);
  const stat = { placed: new Array(7).fill(0), short: new Array(7).fill(0), pop: 0, hubTotal: 0 };

  // 上位から順に、目標の段を与えられるか土地で確かめる
  let qi = 0; const queue = [];
  for (let t = 6; t >= 0; t--) for (let k = 0; k < (target[t] || 0); k++) queue.push(t);

  for (const i of order) {
    const want = qi < queue.length ? queue[qi] : 0;
    const got = tryClaim(i, want);
    tier[i] = got;
    stat.placed[got]++;
    if (got < want) stat.short[want]++;
    stat.hubTotal += TIER[got].hub;
    stat.pop += Math.round(TIER[got].homes * PPH[got]);
    qi++;
  }
  return { tier, owned, stat, score };

  // その集落が段 want に要る拠点地区画を claim できるか。無理なら段を下げる
  function tryClaim(i, want) {
    for (let t = want; t >= 0; t--) {
      const need = TIER[t].hub, rr = TIER[t].r;
      const px = S.vx[i], py = S.vy[i];
      let free = 0;
      const got = [];
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        if (dx*dx + dy*dy > rr*rr) continue;
        const x = px+dx, y = py+dy;
        if (x < 0 || y < 0 || x >= PW || y >= PW) continue;
        const p = y*PW + x;
        if (owned[p] || !buildable(L.b0[p] & 15)) continue;
        free++; if (got.length < need) got.push(p);
      }
      if (free >= need) { for (const p of got) owned[p] = 1; return t; }
    }
    return 0;
  }
}
