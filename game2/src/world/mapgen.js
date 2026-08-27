// 世界の地形生成。正典-統合ver.md #17 §3-1（S0〜S8）／§3-3（鉱脈）の実装。
//
// 純粋関数。DOM も window も知らない。乱数は世界の種の専用ストリームで、
// シミュレーション側の消費順に一切割り込まない（#17 §3-1 S0）。
//
// 出力は層A（里マス・4バイト相当を配列で持つ）。層Bの展開（§3-2）は別。

import { RNG } from '../core/rng.js';

export const W = 384;                 // 里マス。世界 = 384里四方 = 1,920km四方
export const N = W * W;               // 147,456
const CX = W / 2, CY = W / 2;

// 地形ID（#17 §2-5 の bit0-3）
export const T = {
  SEA: 0, LAKE: 1, RIVER: 2, MARSH: 3, PLAIN: 4, GRASS: 5,
  WOOD: 6, JUNGLE: 7, HILL: 8, MTN: 9, ALP: 10, WASTE: 11,
  SAND: 12, ROCK: 13, SALTLAKE: 14, ICE: 15,
};
// 鉱種（bit4-7）。4は空き番（旧・銀。R-26 で鉛へ吸収）
export const ORE = { NONE: 0, IRON: 1, COPPER: 2, TIN: 3, _GAP: 4, GOLD: 5, LEAD: 6, STONE: 7, ROCKSALT: 8 };

// ── 値ノイズ1オクターブ（格子 g 里・振幅 amp）
function octave(h, g, amp, rng) {
  const gw = Math.ceil(W / g) + 2;
  const grid = new Float32Array(gw * gw);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const sm = (t) => t * t * (3 - 2 * t);          // smoothstep
  for (let y = 0; y < W; y++) {
    const gy = y / g, y0 = Math.floor(gy), fy = sm(gy - y0);
    for (let x = 0; x < W; x++) {
      const gx = x / g, x0 = Math.floor(gx), fx = sm(gx - x0);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      h[y * W + x] += amp * ((a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy);
    }
  }
}

// ── 分位点：値の配列から「上位 p の位置にある値」を返す（256段のカウンティング）
function quantile(vals, mask, p) {
  const bins = new Uint32Array(257);
  let n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (mask && !mask[i]) continue;
    bins[Math.min(256, Math.max(0, Math.floor(vals[i] * 256)))]++; n++;
  }
  let want = Math.floor(n * (1 - p)), acc = 0;
  for (let b = 0; b <= 256; b++) { acc += bins[b]; if (acc >= want) return b / 256; }
  return 1;
}

export function generate(seed = 1, opts = {}) {
  const rng = new RNG(seed >>> 0 || 1);

  // ── S1 標高場 h（値ノイズ4オクターブ ＋ 外周の減算マスク）
  const h = new Float32Array(N);
  octave(h, 64, 8, rng); octave(h, 32, 4, rng); octave(h, 16, 2, rng); octave(h, 8, 1, rng);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  for (let i = 0; i < N; i++) h[i] = (h[i] - lo) / (hi - lo);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - CX, y - CY);
    h[y * W + x] -= Math.max(0, (r / (W / 2) - 0.75) / 0.25);   // ★乗算マスクは使わない
  }

  // ── S2 海面（分位点。陸ちょうど40%）
  const seaLevel = quantile(h, null, 0.40);
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = h[i] > seaLevel ? 1 : 0;

  // 外周から4近傍フラッドフィル → 繋がる水＝海、繋がらない水＝湖
  const ter = new Uint8Array(N).fill(T.LAKE);
  const st = [];
  for (let x = 0; x < W; x++) { st.push(x, (W - 1) * W + x); }
  for (let y = 0; y < W; y++) { st.push(y * W, y * W + W - 1); }
  const seen = new Uint8Array(N);
  while (st.length) {
    const i = st.pop();
    if (seen[i] || land[i]) continue;
    seen[i] = 1; ter[i] = T.SEA;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) st.push(i - 1); if (x < W - 1) st.push(i + 1);
    if (y > 0) st.push(i - W); if (y < W - 1) st.push(i + W);
  }

  // 陸のなかの分位点（高山4%／山9%／鉱脈の母集団20%／川の源流28%）
  const qAlp = quantile(h, land, 0.04), qMtn = quantile(h, land, 0.09);
  const qOre = quantile(h, land, 0.20), qSrc = quantile(h, land, 0.28);

  // ── S3a 窪みを埋める（priority-flood）
  //   ★ これが無いと最急降下がすぐ窪みで止まり、川が仕様の 1/5 しか出ない（2026-08-26 実測）
  const hf = Float32Array.from(h);
  {
    const EPS = 1e-4;
    // 優先度つき待ち行列（二分ヒープ）
    const hq = []; const push = (v, i) => { hq.push([v, i]); let k = hq.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (hq[p][0] <= hq[k][0]) break; [hq[p], hq[k]] = [hq[k], hq[p]]; k = p; } };
    const pop = () => { const top = hq[0], last = hq.pop();
      if (hq.length) { hq[0] = last; let k = 0;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < hq.length && hq[l][0] < hq[m][0]) m = l;
          if (r < hq.length && hq[r][0] < hq[m][0]) m = r;
          if (m === k) break; [hq[m], hq[k]] = [hq[k], hq[m]]; k = m; } }
      return top; };
    const done = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!land[i]) { done[i] = 1; push(hf[i], i); }
    while (hq.length) {
      const [v, i] = pop();
      const x = i % W, y = (i / W) | 0;
      for (const d of [-1, 1, -W, W]) {
        const j = i + d; if (j < 0 || j >= N || done[j]) continue;
        if (Math.abs((j % W) - x) > 1) continue;
        done[j] = 1;
        if (hf[j] <= v) hf[j] = v + EPS;
        push(hf[j], j);
      }
    }
  }

  // ── S3 川（★ 真の流域面積で出す。2026-08-26 実測での補正）
  //   仕様は「源流60本を抽選 → 最急降下で辿る」だったが、それだと
  //   流域面積A が「通った経路の本数」になって **大河が1本も出ない**（実測）。
  //   A の定義（通過した上流里マス数）どおり、**全陸マスの流下集積**を出す。
  const flow = new Float32Array(N).fill(1);   // 自分自身の1里マス
  const river = new Uint8Array(N);
  const down = new Int32Array(N).fill(-1);
  const D8 = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  {
    // 各陸マスの流下先（8近傍の最急降下・窪みは埋め済み）
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      const x = i % W; let best = -1, bh = hf[i];
      for (const d of D8) {
        const j2 = i + d; if (j2 < 0 || j2 >= N) continue;
        if (Math.abs((j2 % W) - x) > 1) continue;
        if (hf[j2] < bh) { bh = hf[j2]; best = j2; }
      }
      down[i] = best;
    }
    // 高い順に並べて、自分の集積を流下先へ渡す
    const order = [];
    for (let i = 0; i < N; i++) if (land[i]) order.push(i);
    order.sort((a, b) => hf[b] - hf[a]);
    for (const i of order) { const d = down[i]; if (d >= 0) flow[d] += flow[i]; }
  }
  // 等級：A（上流の里マス数）で切る。閾値は「陸の約7%が川になる」ように実測で決めた
  const RIVER_MIN = opts.riverMin ?? 20, GRADE2 = 60, GRADE3 = 400;
  for (let i = 0; i < N; i++) {
    if (!land[i] || flow[i] < RIVER_MIN) continue;
    river[i] = flow[i] >= GRADE3 ? 3 : flow[i] >= GRADE2 ? 2 : 1;
  }

  // ── S4 気候
  const Temp = new Float32Array(N), Moist = new Float32Array(N);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    Temp[i] = 1 - Math.abs(y - CY) / CY * 0.9 - h[i] * 0.5;   // ★ノイズは下で足す
  }
  // ★ 湿度は「水からの距離」を主とし、西風の移流を修飾として掛ける。
  //   2026-08-26 実測での補正 ── 仕様の「西岸から東へ1里ごとに×0.985」だけだと
  //   **行が独立するので、行ごとに最大減衰量が変わり、必ず横縞になる**（絵にして分かった）。
  //   水からの距離は行をまたいで結合するので、縞が消える。
  //   「西が湿って東が乾く」「山の東は雨陰」という向きは、下の2項で保つ。
  {
    // (a) 水（海・湖）からの距離を BFS で出す
    const dist = new Int32Array(N).fill(-1);
    let q = [], nq = [];
    for (let i2 = 0; i2 < N; i2++) if (!land[i2]) { dist[i2] = 0; q.push(i2); }
    let dcur = 0;
    while (q.length) {
      dcur++;
      for (const i2 of q) {
        const x = i2 % W;
        for (const d of [-1, 1, -W, W]) {
          const j2 = i2 + d; if (j2 < 0 || j2 >= N || dist[j2] >= 0) continue;
          if (Math.abs((j2 % W) - x) > 1) continue;
          dist[j2] = dcur; nq.push(j2);
        }
      }
      q = nq; nq = [];
    }

    // (b) 西風：自分より西にある山の高さを見る（雨陰）
    const shadow = new Float32Array(N).fill(1);
    for (let y = 0; y < W; y++) {
      let block = 0;
      for (let x = 0; x < W; x++) {
        const i2 = y * W + x;
        block *= 0.985;                              // 山を越えた影響は東へ薄れる
        if (land[i2] && h[i2] > 0.68) block = 1;
        shadow[i2] = 1 - 0.45 * block;               // 雨陰は最大 0.55倍
      }
    }

    // (c) 2次元のノイズ（縞を確実に崩す。振幅は距離項と同じ桁）
    const nz = new Float32Array(N);
    octave(nz, 40, 1.0, rng); octave(nz, 20, 0.5, rng); octave(nz, 10, 0.25, rng);
    let a = Infinity, b = -Infinity;
    for (let i2 = 0; i2 < N; i2++) { if (nz[i2] < a) a = nz[i2]; if (nz[i2] > b) b = nz[i2]; }

    for (let i2 = 0; i2 < N; i2++) {
      if (!land[i2]) { Moist[i2] = 1; continue; }
      const dw = Math.exp(-dist[i2] / 55);           // 水から遠いほど乾く
      const west = 1 - 0.30 * ((i2 % W) / W);        // 西が湿って東が乾く（弱い全体傾斜）
      const n = 0.65 + 0.70 * ((nz[i2] - a) / (b - a));
      Moist[i2] = dw * west * shadow[i2] * n;
    }
    // 軽くならす
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        let s = 0, n2 = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= W || xx < 0 || xx >= W) continue;
          s += Moist[yy * W + xx]; n2++;
        }
        tmp[y * W + x] = s / n2;
      }
      Moist.set(tmp);
    }
  }

  // ── S5 植生（★ S2 と同じ「分位点」で切る。固定の閾値だと荒地と砂地が陸の54%を食う）
  //   2026-08-26 実測での補正。仕様の固定閾値（M<0.28→荒地 ほか）は
  //   草原の帯が 0.02 幅しか無く、平野+草原が陸の 0.4% しか出なかった。
  {
    // 先に T/h で決まるもの（氷・高山・山）を抜く
    const rest = [];
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      if (Temp[i] < 0.12) { ter[i] = T.ICE; continue; }
      if (h[i] >= qAlp) { ter[i] = T.ALP; continue; }
      if (h[i] >= qMtn) { ter[i] = T.MTN; continue; }
      rest.push(i);
    }
    // ★ 丘は「残りのうち標高の高い15%」。仕様の h≥0.58 だと陸の22%が丘になり平野を食う
    rest.sort((a, b) => h[b] - h[a]);
    const nHill = Math.round(rest.length * 0.15);
    for (let i2 = 0; i2 < nHill; i2++) ter[rest[i2]] = T.HILL;
    const rest2 = rest.slice(nHill);

    // 残りを湿度の高い順に並べ、帯で切る（合計100）
    rest2.sort((a, b) => Moist[b] - Moist[a]);
    const BAND = [
      [5,  T.MARSH],   // 湿地
      [16, T.JUNGLE],  // 密林
      [40, T.WOOD],    // 疎林   → 森林系 ＝ 陸の約40%
      [24, T.PLAIN],   // 平野
      [9,  T.GRASS],   // 草原
      [5,  T.WASTE],   // 荒地   ← ここが岩塩の帯
      [1,  T.SAND],    // 砂地
    ];
    let k = 0;
    for (const [pct, v] of BAND) {
      const n = Math.round(rest2.length * pct / 100);
      for (let c2 = 0; c2 < n && k < rest2.length; c2++, k++) {
        const i = rest2[k];
        let t = v;
        if (v === T.MARSH && h[i] >= 0.46) t = T.JUNGLE;
        if (v === T.SAND && Temp[i] <= 0.5) t = T.WASTE;
        ter[i] = t;
      }
    }
    const rest3 = rest2;
    while (k < rest3.length) ter[rest3[k++]] = T.WASTE;
  }

  // ── S7 鉱脈（§3-3。数は世界の里マス数で固定）
  const ore = new Uint8Array(N);
  const place = (kind, count, ok) => {
    const pool = [];
    for (let i = 0; i < N; i++) if (land[i] && !ore[i] && ok(i)) pool.push(i);
    for (let k = 0; k < count && pool.length; k++) {
      const p = (rng.next() * pool.length) | 0;
      ore[pool[p]] = kind; pool[p] = pool[pool.length - 1]; pool.pop();
    }
  };
  const isM = (i) => ter[i] === T.MTN || ter[i] === T.HILL || ter[i] === T.ROCK || ter[i] === T.ALP;
  place(ORE.STONE, 900, isM);                                  // 石＋石灰岩：均す
  place(ORE.IRON, 320, (i) => isM(i) || h[i] >= qOre);          // 鉄：均す
  place(ORE.COPPER, 120, (i) => h[i] >= qOre);                  // 銅：半均し
  place(ORE.LEAD, 104, (i) => h[i] >= qOre);                    // 鉛（うち24が含銀）
  place(ORE.ROCKSALT, 96, (i) => ter[i] === T.WASTE);           // 岩塩：雨陰の荒地のみ
  place(ORE.TIN, 32, (i) => h[i] >= qOre);
  place(ORE.GOLD, 8, (i) => river[i] >= 3);                     // 砂金：大河沿い
  // 含銀の鉛（世界に3塊 × 8里マス ＝ 24）
  const silver = new Uint8Array(N);
  { const leadIdx = []; for (let i = 0; i < N; i++) if (ore[i] === ORE.LEAD) leadIdx.push(i);
    for (let k = 0; k < 24 && leadIdx.length; k++) {
      const p = (rng.next() * leadIdx.length) | 0;
      silver[leadIdx[p]] = 1; leadIdx[p] = leadIdx[leadIdx.length - 1]; leadIdx.pop();
    } }

  // ── S6 肥沃度
  const fert = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    const x = i % W, y = (i / W) | 0;
    let nearRiver = river[i] > 0 ? 1 : 0;
    if (!nearRiver) for (const d of [-1, 1, -W, W]) {
      const j = i + d; if (j >= 0 && j < N && river[j] > 0) { nearRiver = 1; break; }
    }
    const v = ter[i];
    let f = 8 + (nearRiver ? 4 : 0)
      + (v === T.PLAIN ? 2 : v === T.MARSH ? 1 : v === T.GRASS ? 1
        : v === T.WASTE ? -5 : v === T.MTN ? -6 : v === T.SAND ? -6 : 0)
      + Math.floor(Moist[i] * 4) - 2
      - Math.floor(h[i] * 6)
      - (ore[i] ? 3 : 0);
    fert[i] = Math.max(0, Math.min(15, f));
  }

  // ── S8 居住可能
  const HAB = new Set([T.PLAIN, T.GRASS, T.WOOD, T.JUNGLE, T.HILL, T.MARSH]);
  const hab = new Uint8Array(N);
  for (let i = 0; i < N; i++)
    hab[i] = (land[i] && (HAB.has(ter[i]) || river[i] > 0) && h[i] < qMtn && fert[i] >= 3) ? 1 : 0;

  return { seed, h, land, ter, river, ore, silver, fert, hab, Temp, Moist,
           seaLevel, qAlp, qMtn, qOre, qSrc };
}
