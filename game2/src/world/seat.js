// 創世の村の座標を選ぶ（#17 §3-4）＋ 鉱種ごとの保証半径を掛ける（#17 §3-3）。
// 純粋関数。generate() の出力を受け取り、その場で ore を書き換えることがある。

import { W, N, T, ORE } from './mapgen.js';

// 鉱種ごとの保証半径（里）。#17 §3-3
export const GUARD = [
  [ORE.STONE,    10],
  [ORE.IRON,     20],
  [ORE.COPPER,   25],
  [ORE.ROCKSALT, 15],  // ★ 30→15。塩は生活必需品（オーナー裁定 2026-08-27）
  [ORE.LEAD,     35],
  [ORE.TIN,      45],
  [ORE.GOLD,     80],
];
// 含銀の鉛は 50里（鉛の中の部分集合として別に見る）
export const SILVER_R = 50;

// 最大の陸塊を出す
export function biggestLandmass(g) {
  const comp = new Int32Array(N).fill(-1);
  let best = -1, bestN = 0, id = 0;
  for (let s = 0; s < N; s++) {
    if (!g.land[s] || comp[s] >= 0) continue;
    const st = [s]; comp[s] = id; let n = 0;
    while (st.length) {
      const i = st.pop(); n++;
      const x = i % W;
      for (const d of [-1, 1, -W, W]) {
        const j = i + d;
        if (j < 0 || j >= N || comp[j] >= 0 || !g.land[j]) continue;
        if (Math.abs((j % W) - x) > 1) continue;
        comp[j] = id; st.push(j);
      }
    }
    if (n > bestN) { bestN = n; best = id; }
    id++;
  }
  return { comp, best, size: bestN };
}

const near = (i, r, f) => {          // 半径 r 里の円の中を見る
  const x0 = i % W, y0 = (i / W) | 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = y0 + dy; if (y < 0 || y >= W) continue;
    const w = Math.floor(Math.sqrt(r * r - dy * dy));
    for (let dx = -w; dx <= w; dx++) {
      const x = x0 + dx; if (x < 0 || x >= W) continue;
      if (f(y * W + x)) return true;
    }
  }
  return false;
};
const countNear = (i, r, f) => {
  const x0 = i % W, y0 = (i / W) | 0; let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = y0 + dy; if (y < 0 || y >= W) continue;
    const w = Math.floor(Math.sqrt(r * r - dy * dy));
    for (let dx = -w; dx <= w; dx++) {
      const x = x0 + dx; if (x < 0 || x >= W) continue;
      if (f(y * W + x)) n++;
    }
  }
  return n;
};

export function pickSeat(g) {
  const lm = biggestLandmass(g);
  const fail = { ok: false, size: lm.size };
  if (lm.size < 20000) return { ...fail, why: '最大の陸塊が20,000里マス未満' };

  // (5) 自分か4近傍に 山／丘／鉱脈:石 があること（13区画に山か石が入るための里マス版）
  const hasStone = (i) => {
    const x = i % W;
    for (const d of [0, -1, 1, -W, W]) {
      const j = i + d; if (j < 0 || j >= N) continue;
      if (d === -1 || d === 1) if (Math.abs((j % W) - x) > 1) continue;
      if (g.ter[j] === T.MTN || g.ter[j] === T.HILL || g.ore[j] === ORE.STONE) return true;
    }
    return false;
  };

  const stat = { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0 };
  let best = -1, bestScore = -1, bestTie = -1;
  for (let i = 0; i < N; i++) {
    if (!g.land[i] || lm.comp[i] !== lm.best) continue;      // (1) 最大の陸塊
    stat.c1++;
    if (!g.hab[i] || g.fert[i] !== 8) continue;              // (2) 居住可能かつ肥沃ちょうど8
    stat.c2++;
    if (g.river[i] < 1) continue;                            // (3) 川等級 ≥1
    stat.c3++;
    if (!near(i, 6, (j) => g.ter[j] === T.WOOD || g.ter[j] === T.JUNGLE)) continue;  // (4) 半径6里に森
    stat.c4++;
    if (!hasStone(i)) continue;                              // (5) 山 or 石
    stat.c5++;
    if (countNear(i, 12, (j) => g.land[j]) < 200) continue;  // (6) 半径12里に陸200
    stat.c6++;
    // (7) 半径12里の 肥沃≥10 の数が最大。同点は **海接続の高い順、次に** 世界中心から遠い順
    const score = countNear(i, 12, (j) => g.land[j] && g.fert[j] >= 10);
    const tie = (g.coast[i] | 0) * 1e6 + Math.hypot((i % W) - W / 2, ((i / W) | 0) - W / 2);
    if (score > bestScore || (score === bestScore && tie > bestTie)) {
      best = i; bestScore = score; bestTie = tie;
    }
  }
  if (best >= 0)
    return { ok: true, seat: best, x: best % W, y: (best / W) | 0, score: bestScore, size: lm.size, stat };

  // ★ 8条件を全部通す里マスが無いとき ── 仕様どおり、最上位候補を書き換えて作る。
  //   「肥沃度を8に書き換え、13区画のうち最寄りの1区画を 鉱脈:石 に書き換える」（#17 §3-4）
  //   実測：50種のうち1種（種39）で必要になった。効くのは条件(5)〈山 or 石〉
  let bg = -1, bs = -1, bt = -1;
  for (let i = 0; i < N; i++) {
    if (!g.land[i] || lm.comp[i] !== lm.best) continue;
    if (!g.hab[i]) continue;
    if (g.river[i] < 1) continue;
    if (!near(i, 6, (j) => g.ter[j] === T.WOOD || g.ter[j] === T.JUNGLE)) continue;
    if (countNear(i, 12, (j) => g.land[j]) < 200) continue;
    const sc = countNear(i, 12, (j) => g.land[j] && g.fert[j] >= 10);
    const tie = Math.hypot((i % W) - W / 2, ((i / W) | 0) - W / 2);
    if (sc > bs || (sc === bs && tie > bt)) { bg = i; bs = sc; bt = tie; }
  }
  if (bg < 0) return { ...fail, why: '書き換えの候補すら無い', stat };
  g.fert[bg] = 8;
  if (!hasStone(bg)) g.ore[bg] = ORE.STONE;      // 13区画のうち最寄りの1区画＝自分の里マス
  return { ok: true, seat: bg, x: bg % W, y: (bg / W) | 0, score: bs, size: lm.size, stat, rewrote: true };
}

// (8) 鉱種ごとの保証半径を掛ける。足りなければ「席から最も遠い」候補に書き込む
export function guarantee(g, seat) {
  const wrote = [];
  const cond = {
    [ORE.STONE]:    (i) => g.ter[i] === T.MTN || g.ter[i] === T.HILL || g.ter[i] === T.ROCK || g.ter[i] === T.ALP,
    [ORE.IRON]:     (i) => g.ter[i] === T.MTN || g.ter[i] === T.HILL || g.h[i] >= g.qOre,
    [ORE.COPPER]:   (i) => g.h[i] >= g.qOre,
    [ORE.ROCKSALT]: (i) => g.ter[i] === T.WASTE,
    [ORE.LEAD]:     (i) => g.h[i] >= g.qOre,
    [ORE.TIN]:      (i) => g.h[i] >= g.qOre,
    [ORE.GOLD]:     (i) => g.river[i] >= 3,
  };
  for (const [kind, r] of GUARD) {
    if (near(seat, r, (j) => g.ore[j] === kind)) continue;
    // ★ 塩だけは「岩塩 または 沿岸（海に接する陸）」で満たす。#17 §3-3「沿岸なら海塩で代替可」
    if (kind === ORE.ROCKSALT && near(seat, r, (j) => g.coast[j] >= 2)) {
      wrote.push({ kind, r, at: -2 }); continue;         // -2 ＝ 海塩で満たした（沿岸＝海接続2）
    }
    // 半径 r 以内で条件を満たすもののうち、席から最も遠いものに書き込む
    const x0 = seat % W, y0 = (seat / W) | 0;
    let far = -1, fd = -1;
    for (let dy = -r; dy <= r; dy++) {
      const y = y0 + dy; if (y < 0 || y >= W) continue;
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let dx = -w; dx <= w; dx++) {
        const x = x0 + dx; if (x < 0 || x >= W) continue;
        const j = y * W + x;
        if (!g.land[j] || g.ore[j] || !cond[kind](j)) continue;
        const d = dx * dx + dy * dy;
        if (d > fd) { fd = d; far = j; }
      }
    }
    if (far >= 0) { g.ore[far] = kind; g.recompute(far); wrote.push({ kind, r, at: far }); continue; }

    // ★ 条件を満たす里マスすら無いとき ── 地形を書き換えて保証する。
    //   §3-3 は石について「足りなければ最も近い山系の1里マスを石に書き換える」と
    //   地形の書き換えを既に認めている。同じ手を他の鉱種にも通す。
    //   選ぶのは「その鉱種がいちばん出そうな1マス」で、席から最も遠いもの。
    const PICK = {
      [ORE.ROCKSALT]: { to: T.WASTE, rank: (j) => -g.Moist[j] },        // いちばん乾いたところ
      [ORE.GOLD]:     { to: null,    rank: (j) => g.river[j] },         // いちばん大きい川
      [ORE.STONE]:    { to: T.HILL,  rank: (j) => g.h[j] },             // いちばん高いところ
      [ORE.IRON]:     { to: T.HILL,  rank: (j) => g.h[j] },
      [ORE.COPPER]:   { to: T.HILL,  rank: (j) => g.h[j] },
      [ORE.LEAD]:     { to: T.HILL,  rank: (j) => g.h[j] },
      [ORE.TIN]:      { to: T.HILL,  rank: (j) => g.h[j] },
    }[kind];
    let pick = -1, pr = -Infinity;
    for (let dy = -r; dy <= r; dy++) {
      const y = y0 + dy; if (y < 0 || y >= W) continue;
      const w2 = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let dx = -w2; dx <= w2; dx++) {
        const x = x0 + dx; if (x < 0 || x >= W) continue;
        const j = y * W + x;
        if (!g.land[j] || g.ore[j] || g.hab[j] === 0 && PICK.to === null) continue;
        if (g.ter[j] === T.ALP || g.ter[j] === T.ICE) continue;
        const v = PICK.rank(j) + Math.hypot(dx, dy) / (r * 1000);   // 同点は遠いほう
        if (v > pr) { pr = v; pick = j; }
      }
    }
    if (pick >= 0) {
      if (PICK.to !== null) g.ter[pick] = PICK.to;
      g.ore[pick] = kind;
      g.recompute(pick);          // ★ 肥沃度 −3 と居住可能を掛け直す
      wrote.push({ kind, r, at: pick, rewrote: PICK.to !== null });
    } else wrote.push({ kind, r, at: -1 });   // それでも無い＝保証できない
  }
  // 含銀の鉛（50里）
  if (!near(seat, SILVER_R, (j) => g.silver[j])) {
    const x0 = seat % W, y0 = (seat / W) | 0; let far = -1, fd = -1;
    for (let dy = -SILVER_R; dy <= SILVER_R; dy++) {
      const y = y0 + dy; if (y < 0 || y >= W) continue;
      const w = Math.floor(Math.sqrt(SILVER_R * SILVER_R - dy * dy));
      for (let dx = -w; dx <= w; dx++) {
        const x = x0 + dx; if (x < 0 || x >= W) continue;
        const j = y * W + x;
        if (g.ore[j] !== ORE.LEAD || g.silver[j]) continue;
        const d = dx * dx + dy * dy; if (d > fd) { fd = d; far = j; }
      }
    }
    if (far >= 0) { g.silver[far] = 1; wrote.push({ kind: 'silver', r: SILVER_R, at: far }); }
    else wrote.push({ kind: 'silver', r: SILVER_R, at: -1 });
  }
  return wrote;
}


// ═══════════════════════════════════════════════════════════════════════
//  生活必需品の充実（オーナー裁定 2026-08-27「創世の村付近だけは資源充実させてね。
//  特に生活必需品」）
//
//  仕様が「届くまで何が起きないか」で分けている必需品のうち、
//  席の周りに下限が無かったのは **糧（肥沃な土地）** と **森（薪・材）** の2つ。
//  塩は保証半径を 30里→15里 に詰めた（上の GUARD）。石10里・鉄20里は元から届いている。
//
//  使う操作は §3-4 が救済経路として既に自分で認めているものだけ ── 肥沃度の書き換えと
//  地形の書き換え。新しい機構は足していない。
//
//  ★ 席の里マス自身には絶対に触らない。肥沃＝8ちょうどが #3-(h) の 135.8 を保存しているため
//  ★ 書き上げるのは **席から遠い順**。§3-4 の
//    「足下は並の土地で、良い土地は目の前にある ── これが分村の動機になる」を壊さないため
//  ★ 鉱脈の保証（guarantee）の **後** に走らせる。保証の地形書き換えが農地を食った分も直すため
// ═══════════════════════════════════════════════════════════════════════

export const NEED = {
  WOOD_R: 6,  WOOD_MIN: 12,   // 半径6里（113里マス）に 森林の里マス 12枚。実測の下位35%を底上げ
  FOOD_R: 12, FOOD_MIN: 40,   // 半径12里（441里マス）に 肥沃≥10 を 40枚。実測の中央値42に揃える
};

export function enrich(g, seat) {
  const x0 = seat % W, y0 = (seat / W) | 0;
  const log = { wood: 0, food: 0 };

  // 席から遠い順に並べた、半径 r 以内の里マス
  const ring = (r) => {
    const a = [];
    for (let dy = -r; dy <= r; dy++) {
      const y = y0 + dy; if (y < 0 || y >= W) continue;
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let dx = -w; dx <= w; dx++) {
        const x = x0 + dx; if (x < 0 || x >= W) continue;
        const j = y * W + x; if (j === seat) continue;      // 席には触らない
        a.push([dx * dx + dy * dy, j]);
      }
    }
    a.sort((p, q) => q[0] - p[0]);                          // 遠い順
    return a.map((e) => e[1]);
  };

  // ── 1) 森（薪・材・植林の種）。平野か草原を疎林に書き換える
  //    先にやる：疎林は平野より肥沃度が2低いので、あとの糧の勘定に効く
  {
    const cells = ring(NEED.WOOD_R);
    let have = 0;
    for (const j of cells) if (g.ter[j] === T.WOOD || g.ter[j] === T.JUNGLE) have++;
    if (g.ter[seat] === T.WOOD || g.ter[seat] === T.JUNGLE) have++;
    for (const j of cells) {
      if (have >= NEED.WOOD_MIN) break;
      if (!g.land[j] || g.ore[j]) continue;
      if (g.ter[j] !== T.PLAIN && g.ter[j] !== T.GRASS) continue;
      g.ter[j] = T.WOOD; g.recompute(j); have++; log.wood++;
    }
  }

  // ── 2) 糧（分村の動機になる良い土地）。肥沃度を 10 に書き上げる
  //    ★ 居住可能な陸だけ。山・荒地・砂地・氷を「良い土地」にはしない
  {
    const cells = ring(NEED.FOOD_R);
    let have = 0;
    for (const j of cells) if (g.land[j] && g.fert[j] >= 10) have++;
    for (const j of cells) {
      if (have >= NEED.FOOD_MIN) break;
      if (!g.land[j] || g.fert[j] >= 10 || !g.hab[j] || g.ore[j]) continue;
      g.fert[j] = 10; have++; log.food++;
    }
  }
  return log;
}
