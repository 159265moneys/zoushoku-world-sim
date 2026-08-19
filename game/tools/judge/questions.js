// 4つの問いへの答えを計算する。ここが判定器の本体。
//
// 全体を貫く方針：**同じ種・同じ相手で組（ブロック）を作って比べる**。
// 方針Aを種1〜30で、方針Bを別の種で回して平均を比べると、種の運が方針の差に化ける。
// 全方針を同じ種で回しているのだから、(相手, 種) ごとに揃えて比較する。
// この blocked 比較にしただけで、必要な種数が桁で減る。

import {
  mean, sd, sem, median, quantile, bootstrapMeanCI, permTestPaired, cohenD,
  probSuperior, holm, RNG, fmt,
} from './stats.js';
import {
  encode, encodeActive, distance, FEATURE_NAMES, CARD_IDS, CATEGORICAL, perturb,
  N_KNOBS, isInert, getInertCards, activeKnobCount,
} from './space.js';
import { metricOf } from './evaluate.js';
import {
  kmeans, gapStatistic, withinBetween, permTestClusters, identificationRate,
  pairSeparation, measureNoiseFloor, silhouette,
} from './cluster.js';

// ------------------------------------------------------------------ 成績表

export function buildTable(rows, policies, seeds, opponents, metric) {
  const ids = policies.map((p) => p.id);
  const iOf = new Map(ids.map((id, i) => [id, i]));
  const oOf = new Map(opponents.map((o, i) => [o, i]));
  const sOf = new Map(seeds.map((s, i) => [s, i]));
  // v[p][o][s]
  const v = ids.map(() => opponents.map(() => new Array(seeds.length).fill(NaN)));
  let filled = 0;
  for (const r of rows) {
    const p = iOf.get(r.id), o = oOf.get(r.opponent), s = sOf.get(r.seed);
    if (p == null || o == null || s == null) continue;
    v[p][o][s] = metricOf(r, metric);
    filled++;
  }
  const missing = ids.length * opponents.length * seeds.length - filled;

  // ブロック内 z 化：(相手, 種) を固定して方針間で標準化する。
  // 相手の強さと種の運が丸ごと落ちるので、相手をまたいだ平均が意味を持つ。
  const z = ids.map(() => opponents.map(() => new Array(seeds.length).fill(0)));
  for (let o = 0; o < opponents.length; o++) {
    for (let s = 0; s < seeds.length; s++) {
      const col = ids.map((_, p) => v[p][o][s]).filter(Number.isFinite);
      const m = mean(col), sdv = sd(col);
      for (let p = 0; p < ids.length; p++) {
        z[p][o][s] = sdv > 0 && Number.isFinite(v[p][o][s]) ? (v[p][o][s] - m) / sdv : 0;
      }
    }
  }

  const t = {
    ids, policies, seeds, opponents, v, z, missing, metric,
    idx: (id) => iOf.get(id),
    raw: (p, o) => v[p][o],                       // 種の配列
    zAll: (p) => z[p].flat(),                     // 相手×種の平列
    rawAll: (p) => v[p].flat(),
    meanByOpp: (p) => v[p].map((xs) => mean(xs.filter(Number.isFinite))),
    zMeanByOpp: (p) => z[p].map((xs) => mean(xs)),
    overall: (p) => mean(z[p].flat()),            // 総合＝ブロックz の平均
    overallRaw: (p) => mean(v[p].flat().filter(Number.isFinite)),
  };
  t.order = ids.map((_, p) => p).sort((a, b) => t.overall(b) - t.overall(a));
  return t;
}

// ----------------------------------------------- 「かたち」（相手別の得意不得意）

const centerVec = (v) => { const m = mean(v); return v.map((x) => x - m); };
const vnorm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const cosine = (a, b) => {
  const na = vnorm(a), nb = vnorm(b);
  return na > 0 && nb > 0 ? a.reduce((s, x, i) => s + x * b[i], 0) / (na * nb) : 0;
};
const rmsDist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / a.length);

/** 方針の「かたち」＝相手別の成績から自分の平均を引いたベクトル。強さではなく得意不得意 */
export const shapeOf = (t, p) => centerVec(t.zMeanByOpp(p));

/** かたちの測定誤差の床。同じ方針を種の半分ずつで2回測って実測する */
export function shapeNoiseFloor(t, idxs, rng, reps = 20) {
  const seedIdxs = t.seeds.map((_, i) => i);
  const f = (p, sIdx) => centerVec(t.opponents.map((_, o) => mean(sIdx.map((s) => t.z[p][o][s]))));
  return measureNoiseFloor(idxs, seedIdxs, f, rng, reps);
}

// ------------------------------------- 前提の点検：天井と分解能

/** 指標ごとの「互角」の線。ここを超えられないなら、勝ち筋の議論より先に手の数の問題 */
const PARITY = { winRate: 0.5, netWins: 0, power: null };

/**
 * 判定の前に、測定そのものの限界を出しておく。これを見ないと4つの答えを読み違える。
 *
 * 天井 … この探索空間で到達できた最良の成績。互角の線に届いていなければ、
 *        「支配戦略が無い」のは装置が効いているからではなく、**そもそも勝てない**から。
 *        プレイヤーの動詞が相手（rival profile）より少ないなら、それは設計の勝利ではない。
 * 分解能 … いまの種数で分離できる最小の差。上位どうしの広がりがこれを下回るなら、
 *        「上位N本」の順位は測れていない。
 */
export function measurementLimits(t, topK = 10) {
  const rawMeans = t.ids.map((_, p) => t.overallRaw(p));
  const top = t.order.slice(0, Math.min(topK, t.order.length));

  // 分解能：対応あり・両側α=.05・検出力.8 → 必要差 ≈ 2.8 × sd(差) / √n
  const sds = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = t.rawAll(top[i]), b = t.rawAll(top[j]);
      const d = a.map((x, k) => x - b[k]).filter(Number.isFinite);
      if (d.length > 1) sds.push(sd(d));
    }
  }
  const sdDiff = sds.length ? mean(sds) : NaN;
  const nBlocks = t.seeds.length * t.opponents.length;
  const mddOverall = 2.8 * sdDiff / Math.sqrt(nBlocks);
  const mddPerOpp = 2.8 * sdDiff / Math.sqrt(t.seeds.length);
  const topSpread = Math.max(...top.map((p) => t.overallRaw(p))) - Math.min(...top.map((p) => t.overallRaw(p)));

  const parity = PARITY[t.metric];
  const best = Math.max(...rawMeans);
  return {
    metric: t.metric, parity,
    ceiling: best, medianRaw: median(rawMeans), floor: Math.min(...rawMeans),
    atParity: parity == null ? null : best >= parity * 0.9,
    aboveParityFrac: parity == null ? null : rawMeans.filter((x) => x >= parity).length / rawMeans.length,
    sdDiff, nBlocks, mddOverall, mddPerOpp, topSpread, topK: top.length,
    // 上位どうしを分離できているか。できていないなら「上位N本」の順序は意味を持たない
    topResolvable: topSpread > mddOverall,
  };
}

// ------------------------------------------------------- 問1：支配戦略はあるか

/** ブロックごとの勝ち上がり。A が B を上回ったブロックの割合 */
function beatFraction(t, a, b) {
  let win = 0, n = 0;
  for (let o = 0; o < t.opponents.length; o++) {
    for (let s = 0; s < t.seeds.length; s++) {
      const x = t.v[a][o][s], y = t.v[b][o][s];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++; if (x > y) win++; else if (x === y) win += 0.5;
    }
  }
  return n ? win / n : 0.5;
}

export function q1Dominance(t, rng, alpha = 0.05) {
  const P = t.ids.length, O = t.opponents.length;

  // (a) 相手ごとの「最上位ティア」：その相手の最良と、対応のある並べ替えで
  //     有意差がつかなかった方針の集合。Holm で多重比較を締める。
  const tierByOpp = [];
  for (let o = 0; o < O; o++) {
    const meansO = t.ids.map((_, p) => mean(t.v[p][o].filter(Number.isFinite)));
    const bestP = meansO.indexOf(Math.max(...meansO));
    const pvals = [], cand = [];
    for (let p = 0; p < P; p++) {
      if (p === bestP) continue;
      const a = t.v[bestP][o], b = t.v[p][o];
      const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      pvals.push(permTestPaired(pairs.map((x) => x[0]), pairs.map((x) => x[1]), rng, 1500));
      cand.push(p);
    }
    const adj = holm(pvals);
    const tier = new Set([bestP]);
    cand.forEach((p, i) => { if (adj[i] >= alpha) tier.add(p); });
    tierByOpp.push({ opponent: t.opponents[o], best: bestP, bestMean: meansO[bestP], tier });
  }

  // (b) 全相手で最上位ティアに入る方針＝「どこでも通じる」集合 U
  const universal = [];
  for (let p = 0; p < P; p++) if (tierByOpp.every((x) => x.tier.has(p))) universal.push(p);

  // (c) 一番強い候補が、他の全方針をブロック単位で上回っているか
  const champ = t.order[0];
  const beats = t.ids.map((_, p) => (p === champ ? null : beatFraction(t, champ, p)));
  const beatsAll = beats.filter((x) => x != null);
  const minBeat = beatsAll.length ? Math.min(...beatsAll) : 1;
  // 文字どおりの「全種・全相手で勝つ」
  const strictOverAll = beatsAll.every((x) => x === 1);

  // (d) U の広がり。**パラメータではなく「かたち」で測る**。
  //     死んでいるカードがあると、挙動が同一の方針がパラメータ空間に散らばる。
  //     パラメータの直径で判定すると、支配戦略があるのに「複数の型」と読み違える
  //     （ダミー世界 dominant で実際にそう外した）。
  const uEnc = universal.map((p) => encodeActive(t.policies[p]));
  let uDiameter = 0;
  for (let i = 0; i < uEnc.length; i++) {
    for (let j = i + 1; j < uEnc.length; j++) uDiameter = Math.max(uDiameter, distance(uEnc[i], uEnc[j]));
  }
  const uShapes = universal.map((p) => shapeOf(t, p));
  let uShapeDiameter = 0;
  for (let i = 0; i < uShapes.length; i++) {
    for (let j = i + 1; j < uShapes.length; j++) uShapeDiameter = Math.max(uShapeDiameter, rmsDist(uShapes[i], uShapes[j]));
  }
  const noiseFloor = universal.length > 1 ? shapeNoiseFloor(t, universal, rng.fork(77), 12) : NaN;

  // (e) そもそも方針の差が測れているか。ティアがほぼ全員なら「差が無い」ではなく
  //     「差を測れていない」。ここを区別しないと、ノイズだらけの測定を
  //     「支配戦略なし＝設計の勝ち」と読み違える。
  const tierSizes = tierByOpp.map((x) => x.tier.size);
  const tierFrac = mean(tierSizes) / P;

  let verdict;
  if (tierFrac >= 0.8) verdict = 'NO_SIGNAL';
  else if (strictOverAll) verdict = 'DOMINANT_STRICT';
  else if (universal.length === 0) verdict = 'NONE';
  else if (universal.length === 1 || uShapeDiameter < 2 * noiseFloor) verdict = 'DOMINANT_TYPE';
  else verdict = 'MULTI_UNIVERSAL';

  return {
    verdict, universal, universalIds: universal.map((p) => t.ids[p]),
    uDiameter, uShapeDiameter, noiseFloor, tierFrac,
    champ, champId: t.ids[champ], champOverall: t.overall(champ),
    minBeat, beats, tierByOpp, tierSizes,
  };
}

// ------------------------------------------------ 問1の付録：どのカードが効くか

/** ゼロ分散列を落として標準化。回帰の係数を比較可能にする。 */
function standardize(X) {
  const d = X[0].length;
  const keep = [], mu = [], sg = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((x) => x[j]);
    const s = sd(col);
    if (s > 1e-9) { keep.push(j); mu.push(mean(col)); sg.push(s); }
  }
  return { keep, Z: X.map((x) => keep.map((j, k) => (x[j] - mu[k]) / sg[k])) };
}

/** リッジ回帰（正規方程式＋部分ピボット選択のガウス消去）。多重共線を潰すために λ を入れる。 */
function ridge(Z, y, lambda = 1.0) {
  const n = Z.length, d = Z[0].length;
  const A = Array.from({ length: d }, (_, i) => new Array(d + 1).fill(0));
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      let s = 0; for (let k = 0; k < n; k++) s += Z[k][i] * Z[k][j];
      A[i][j] = s + (i === j ? lambda : 0);
    }
    let s = 0; for (let k = 0; k < n; k++) s += Z[k][i] * y[k];
    A[i][d] = s;
  }
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= d; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : row[d] / A[i][i]));
}

/** 空間全体で、どの特徴が成績を説明しているか（標準化回帰係数） */
export function globalSensitivity(t) {
  const X = t.policies.map((p) => encode(p));
  const y = t.ids.map((_, p) => t.overall(p));
  const { keep, Z } = standardize(X);
  const ym = mean(y), ys = sd(y);
  const yz = y.map((v) => (ys > 0 ? (v - ym) / ys : 0));
  const beta = ridge(Z, yz, Math.max(1, Z.length * 0.02));
  // 決定係数（当てはまり）。低ければ「線形では説明できない」＝相互作用が本体
  const pred = Z.map((row) => row.reduce((a, v, j) => a + v * beta[j], 0));
  const ssRes = yz.reduce((a, v, i) => a + (v - pred[i]) ** 2, 0);
  const ssTot = yz.reduce((a, v) => a + v * v, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  const terms = keep.map((j, k) => ({ feature: FEATURE_NAMES[j], beta: beta[k] }))
    .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
  return { terms, r2, n: X.length };
}

/**
 * 一因子ずつ動かす感度分析（OAT）。支配戦略が見つかったときに
 * 「どのカードがどれだけ効いているか」を出すのが仕事。評価器を追加で叩く。
 */
export async function oatSensitivity(basePolicy, evaluator, seeds, opponents, metric, rng, step = 0.25) {
  const variants = [];
  for (const id of CARD_IDS) {
    for (const d of [-step, step]) {
      const p = perturb(basePolicy, id, d);
      p.id = `oat_${id}_${d > 0 ? 'up' : 'dn'}`;
      variants.push({ knob: id, delta: d, policy: p });
    }
  }
  for (const d of [-0.25, 0.25]) {
    const p = perturb(basePolicy, 'warAppetite', d);
    p.id = `oat_warAppetite_${d > 0 ? 'up' : 'dn'}`;
    variants.push({ knob: 'warAppetite', delta: d, policy: p });
  }
  for (const [key, vals] of Object.entries(CATEGORICAL)) {
    for (const val of vals) {
      if (basePolicy[key] === val) continue;
      const p = JSON.parse(JSON.stringify(basePolicy));
      p[key] = val; p.id = `oat_${key}_${val}`;
      variants.push({ knob: `${key}=${val}`, delta: null, policy: p });
    }
  }
  const base = { ...JSON.parse(JSON.stringify(basePolicy)), id: 'oat_base' };
  const all = [base, ...variants.map((x) => x.policy)];
  const rows = await evaluator.run(all, seeds, opponents);
  const t = buildTable(rows, all, seeds, opponents, metric);

  const bi = t.idx('oat_base');
  const baseVec = t.rawAll(bi);
  const out = [];
  for (const vr of variants) {
    const i = t.idx(vr.policy.id);
    if (i == null) continue;
    const vec = t.rawAll(i);
    const pairs = baseVec.map((x, k) => [x, vec[k]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    const d = mean(pairs.map(([a, b]) => b - a));
    const p = permTestPaired(pairs.map((x) => x[1]), pairs.map((x) => x[0]), rng, 1500);
    out.push({ knob: vr.knob, delta: vr.delta, dScore: d, p, dz: t.overall(i) - t.overall(bi) });
  }
  // つまみごとに「動かしたときの最大の効き」でまとめる
  const byKnob = new Map();
  for (const r of out) {
    const k = r.knob.split('=')[0];
    const cur = byKnob.get(k);
    if (!cur || Math.abs(r.dScore) > Math.abs(cur.effect)) {
      byKnob.set(k, { knob: k, effect: r.dScore, p: r.p, at: r.knob });
    }
  }
  return { rows: out, byKnob: [...byKnob.values()].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)) };
}

// --------------------------------------------------- 問2：勝ち筋は何本あるか

/**
 * 上位方針の集め方が結論を左右するので、ここは明示しておく。
 *
 * 「総合の上位N本」だけを取ると、**特定の相手にだけ刺さる専門家が落ちる**。
 * 相手依存が本当にあるなら勝ち筋の一部は専門家として現れるので、
 *   (a) どれか1国に対して最上位ティアに入った方針  ∪  (b) 総合上位15%
 * を上位集合とする。(a) は問1の検定の副産物なのでタダで手に入る。
 */
function eliteSet(t, q1, topFrac) {
  const s = new Set();
  if (q1) for (const x of q1.tierByOpp) for (const p of x.tier) s.add(p);
  const n = Math.max(8, Math.round(t.ids.length * topFrac));
  for (const p of t.order.slice(0, n)) s.add(p);
  return [...s].sort((a, b) => t.overall(b) - t.overall(a));
}

/**
 * 「型」の定義。ここを決めないと数は何とでも言える。
 *
 *   型 ＝ **相手ごとの得意不得意のパターン（向き）**。
 *   得意不得意が同じで強さだけ違うのは、別の型ではなく**同じ型の上手い下手**。
 *
 * だから相手別の成績プロファイルから、その方針自身の平均（＝全体の強さ）を引いた
 * 「かたち」でクラスタリングする。引かないと、単に強い方針と弱い方針が別の島になって
 * 勝ち筋の数が水増しされる。それは問4で測るべきものであって、勝ち筋の本数ではない。
 *
 * パラメータ空間で割らない理由：成績に効かない死にカードの違いが型の違いに化けるため。
 * パラメータ側は「その型が別のカード設定として記述できるか」の確認に回す。
 */
const COS_SAME_SHAPE = 0.80; // 重心の向きがこれ以上似ていたら「強度違いの同じ型」

export function q2WinLines(t, rng, q1, { topFrac = 0.15, kmax = 6 } = {}) {
  const top = eliteSet(t, q1, topFrac);
  const nTop = top.length;
  const nOpp = t.opponents.length;
  const X = top.map((p) => encodeActive(t.policies[p]));   // パラメータ空間（死にカードは0）
  const V = top.map((p) => shapeOf(t, p));           // かたちの空間

  // 測定誤差の床を実測する（同じ方針を種の半分ずつで2回測って、かたちがどれだけブレるか）
  const noiseFloor = shapeNoiseFloor(t, top, rng.fork(3), 20);

  // クラスタ数：ギャップ統計量は帰無参照の作り方に強く依存して k が張り付くので、
  // 採用はシルエット最大、ギャップは診断として併記する。
  const kcap = Math.min(kmax, Math.max(2, Math.floor(V.length / 3)));
  const gap = gapStatistic(V, kcap, rng.fork(4), 25);
  const sils = [];
  for (let k = 2; k <= kcap; k++) sils.push({ k, sil: silhouette(V, kmeans(V, k, rng.fork(100 + k), 16).labels) });
  const bestSil = sils.length ? sils.reduce((a, b) => (b.sil > a.sil ? b : a)) : { k: 1, sil: NaN };

  let k = bestSil.k;
  let km = kmeans(V, k, rng.fork(9), 16);
  let permAt = permTestClusters(V, km.labels, rng.fork(10), 800);
  // 島そのものが偶然と区別できないなら k=1（勝ち筋は1本）
  if (!(permAt.p < 0.05)) { k = 1; km = { labels: V.map(() => 0), centroids: [V[0].map((_, d) => mean(V.map((v) => v[d])))], inertia: 0 }; }
  const labels = km.labels;

  const wb = k > 1 ? withinBetween(V, labels) : { within: NaN, between: NaN, ratio: NaN };
  const perm = k > 1 ? permAt : { ratio: NaN, p: 1 };
  const ident = k > 1 ? identificationRate(V, labels) : { rate: NaN, chanceUniform: NaN, chanceMajority: NaN };
  const sil = k > 1 ? silhouette(V, labels) : NaN;
  const sep = k > 1 ? pairSeparation(V, labels, rng.fork(11), noiseFloor, 1500) : { pairs: [] };
  const paramWb = k > 1 ? withinBetween(X, labels) : { within: NaN, between: NaN, ratio: NaN };
  const paramPerm = k > 1 ? permTestClusters(X, labels, rng.fork(12), 800) : { ratio: NaN, p: 1 };

  const cents = new Map();
  for (let c = 0; c < k; c++) {
    const ms = V.filter((_, i) => labels[i] === c);
    if (ms.length) cents.set(c, ms[0].map((_, d) => mean(ms.map((m) => m[d]))));
  }
  // 得意不得意の起伏が測定誤差に埋もれている＝相手を選ばない「平坦型」
  const flat = new Set([...cents].filter(([, v]) => vnorm(v) / Math.sqrt(nOpp) <= noiseFloor).map(([c]) => c));

  // --- 統合：別の型として数えない条件 ---
  const parent = new Array(k).fill(0).map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  for (const pr of sep.pairs) {
    const cos = cosine(cents.get(pr.a), cents.get(pr.b));
    pr.cos = cos;
    const bothFlat = flat.has(pr.a) && flat.has(pr.b);
    if (pr.snr < 1.0) pr.same = '測定誤差の内側';
    else if (pr.p >= 0.05) pr.same = 'ラベルの偶然';
    else if (bothFlat) pr.same = '両方とも平坦型';
    else if (cos >= COS_SAME_SHAPE) pr.same = '同じかたちで強度違い';
    else pr.same = null;
    if (pr.same) union(pr.a, pr.b);
  }
  const comps = new Map();
  for (let c = 0; c < k; c++) {
    const r = find(c);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(c);
  }
  const nTypes = comps.size;

  const clusters = [];
  for (let c = 0; c < k; c++) {
    const members = top.filter((_, i) => labels[i] === c);
    if (!members.length) continue;
    const enc = members.map((p) => encodeActive(t.policies[p]));
    let rep = members[0], bd = Infinity;
    members.forEach((p) => { const d = distance(V[top.indexOf(p)], cents.get(c)); if (d < bd) { bd = d; rep = p; } });
    const pCent = enc[0].map((_, d) => mean(enc.map((e) => e[d])));
    clusters.push({
      c, n: members.length, members, flat: flat.has(c),
      typeOf: [...comps.keys()].indexOf(find(c)),
      repId: t.ids[rep], repPolicy: t.policies[rep],
      overall: mean(members.map((p) => t.overall(p))),
      byOpp: t.opponents.map((_, o) => mean(members.map((p) => t.zMeanByOpp(p)[o]))),
      shape: cents.get(c),
      shapeAmp: vnorm(cents.get(c)) / Math.sqrt(nOpp),
      spread: mean(enc.map((e) => distance(e, pCent))),
    });
  }

  return {
    nTop, top, k, nTypes, gap, sils, bestSil, labels, wb, perm, ident, sil,
    paramWb, paramPerm, noiseFloor, flat: [...flat],
    behavior: sep.pairs, clusters, merged: [...comps.values()], cosThreshold: COS_SAME_SHAPE,
  };
}

// ------------------------------------------------- 問3：最適は相手で変わるか

export function q3OpponentDependence(t, rng, { splits = 40 } = {}) {
  const O = t.opponents.length, P = t.ids.length, S = t.seeds.length;

  const bestFor = (o, seedIdx) => {
    let bi = 0, bv = -Infinity;
    for (let p = 0; p < P; p++) {
      const xs = seedIdx.map((s) => t.v[p][o][s]).filter(Number.isFinite);
      const m = mean(xs);
      if (m > bv) { bv = m; bi = p; }
    }
    return bi;
  };
  const allSeeds = t.seeds.map((_, i) => i);
  const best = t.opponents.map((_, o) => bestFor(o, allSeeds));

  // 相手間の距離行列（それぞれの最良方針どうしの隔たり）
  const D = best.map((a) => best.map((b) => distance(encodeActive(t.policies[a]), encodeActive(t.policies[b]))));
  const offDiag = [];
  for (let i = 0; i < O; i++) for (let j = i + 1; j < O; j++) offDiag.push(D[i][j]);

  // ノイズの床：同じ相手の中で種を2分割し、それぞれの最良どうしの距離。
  // 「相手が違うから最良が違う」のか「測るたびに最良が変わる」だけなのかを分ける。
  const withinDists = [];
  for (let r = 0; r < splits; r++) {
    const idx = rng.shuffle(allSeeds.slice());
    const A = idx.slice(0, Math.floor(S / 2)), B = idx.slice(Math.floor(S / 2));
    for (let o = 0; o < O; o++) {
      withinDists.push(distance(encodeActive(t.policies[bestFor(o, A)]), encodeActive(t.policies[bestFor(o, B)])));
    }
  }

  // 後悔行列：相手 j の戦場に「相手 i 用の最良」を持ち込んだときの取りこぼし。
  // その相手における方針間ばらつきで割って「sd何個分か」にする。
  const R = [];
  for (let i = 0; i < O; i++) {
    const row = [];
    for (let j = 0; j < O; j++) {
      const spread = sd(t.ids.map((_, p) => mean(t.v[p][j].filter(Number.isFinite))));
      const mine = mean(t.v[best[i]][j].filter(Number.isFinite));
      const theirs = mean(t.v[best[j]][j].filter(Number.isFinite));
      row.push(spread > 0 ? (theirs - mine) / spread : 0);
    }
    R.push(row);
  }
  const offRegret = [];
  for (let i = 0; i < O; i++) for (let j = 0; j < O; j++) if (i !== j) offRegret.push(R[i][j]);

  // 「1本を全相手に持ち回ったとき」の最善（＝コピー可能説の最強の形）
  let bestUniversal = 0, bestUniversalLoss = Infinity;
  for (let p = 0; p < P; p++) {
    const loss = mean(t.opponents.map((_, j) => {
      const spread = sd(t.ids.map((_, q) => mean(t.v[q][j].filter(Number.isFinite))));
      const mine = mean(t.v[p][j].filter(Number.isFinite));
      const theirs = mean(t.v[best[j]][j].filter(Number.isFinite));
      return spread > 0 ? (theirs - mine) / spread : 0;
    }));
    if (loss < bestUniversalLoss) { bestUniversalLoss = loss; bestUniversal = p; }
  }

  const betweenM = mean(offDiag), withinM = mean(withinDists);
  const distinctBest = new Set(best).size;
  // 相手依存と言えるのは、相手をまたいだ振れがノイズの床を明確に超えたとき
  const ratio = betweenM / Math.max(1e-9, withinM);
  const verdict = distinctBest <= 1 ? 'SAME_FOR_ALL'
    : ratio >= 1.3 && betweenM - withinM > 0.05 ? 'OPPONENT_DEPENDENT'
    : 'INDISTINGUISHABLE_FROM_NOISE';

  return {
    verdict, best, bestIds: best.map((p) => t.ids[p]), D, R,
    betweenMean: betweenM, withinMean: withinM, ratio, distinctBest,
    offRegretMean: mean(offRegret), offRegretP90: quantile(offRegret, 0.9),
    bestUniversalId: t.ids[bestUniversal], bestUniversalLoss,
    withinDists,
  };
}

// --------------------------------------- 問4：上手い下手の差は観測できるか

export function q4SkillGradient(t, rng, tags) {
  const P = t.ids.length;
  const pick = (p) => t.rawAll(p).filter(Number.isFinite);

  const bestP = t.order[0];
  const medP = t.order[Math.floor(t.order.length / 2)];
  const worstP = t.order[t.order.length - 1];
  const randIdx = t.ids.map((_, p) => p).filter((p) => tags.get(t.ids[p]) === 'random');
  const randPool = randIdx.length ? randIdx.flatMap(pick) : pick(medP);

  const bestV = pick(bestP), medV = pick(medP), worstV = pick(worstP);

  const d = cohenD(bestV, randPool);
  const pSup = probSuperior(bestV, randPool);
  // 二標本で有意差（α=.05片側, 検出力.8）に要る1群あたりの試合数
  const nNeeded = d !== 0 ? Math.ceil(15.7 / d ** 2) : Infinity;

  const ladder = [
    { name: '最良',       p: bestP, xs: bestV },
    { name: '上位25%',    p: t.order[Math.floor(P * 0.25)], xs: pick(t.order[Math.floor(P * 0.25)]) },
    { name: '中央',       p: medP, xs: medV },
    { name: '下位25%',    p: t.order[Math.floor(P * 0.75)], xs: pick(t.order[Math.floor(P * 0.75)]) },
    { name: '最悪',       p: worstP, xs: worstV },
  ].map((r) => ({ ...r, id: t.ids[r.p], mean: mean(r.xs), ci: bootstrapMeanCI(r.xs, rng, 1200) }));

  const verdict = d >= 0.8 && pSup >= 0.65 ? 'CLEAR'
    : d >= 0.4 && pSup >= 0.58 ? 'WEAK'
    : 'NOT_OBSERVABLE';

  // ばらつきの出どころを3つに分ける。混ぜると信号/雑音が読めなくなる。
  //   種      … 方針も相手も固定して、種だけ振ったときのブレ（＝運）
  //   相手    … 方針を固定して、相手を変えたときのブレ（＝相性）
  //   方針    … 方針を変えたときのブレ（＝腕前。これが信号）
  const seedNoise = mean(t.ids.flatMap((_, p) =>
    t.opponents.map((_, o) => sd(t.v[p][o].filter(Number.isFinite)))));
  const oppSpread = mean(t.ids.map((_, p) => sd(t.meanByOpp(p).filter(Number.isFinite))));
  const policySpread = sd(t.ids.map((_, p) => t.overallRaw(p)));

  return {
    verdict, ladder,
    best: { id: t.ids[bestP], mean: mean(bestV), ci: bootstrapMeanCI(bestV, rng, 1200) },
    median: { id: t.ids[medP], mean: mean(medV), ci: bootstrapMeanCI(medV, rng, 1200) },
    random: { n: randIdx.length, mean: mean(randPool), ci: bootstrapMeanCI(randPool, rng, 1200) },
    d, pSup, nNeeded, seedNoise, oppSpread, policySpread,
  };
}
