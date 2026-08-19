// クラスタリングと、「本当に違う型か／同じ型のゆらぎか」を分ける検定。
//
// ここが問2の肝。上位方針をk-meansに掛けて「3個の島が出ました」と言うのは簡単だが、
// k-means は乱数にすら島を作る。だから3段構えで確かめる：
//
//   1. 統計的に島か      … ギャップ統計量（一様な帰無参照との比較）＋ラベル並べ替え検定
//   2. 別物か            … 島ごとの「相手別の成績プロファイル」が種のノイズを超えて違うか
//   3. 見分けられるか    … 交差検証つきの最近傍重心で識別率（設計文書が使っている物差し）
//
// 2 が要る理由：パラメータが違っても成績プロファイルが同じなら、それは
// **別の型ではなく死んだカードの違い**にすぎない。設計の主張は「型が複数ある」であって
// 「無意味なつまみが複数ある」ではない。

import { mean, sd, quantile, RNG } from './stats.js';

const dist = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
};

export function kmeans(X, k, rng, restarts = 12, iters = 60) {
  if (k >= X.length) return { labels: X.map((_, i) => i), centroids: X.map((x) => [...x]), inertia: 0 };
  let best = null;
  for (let r = 0; r < restarts; r++) {
    // k-means++ の初期化
    const cent = [X[rng.int(X.length)].slice()];
    while (cent.length < k) {
      const d2 = X.map((x) => Math.min(...cent.map((c) => dist(x, c) ** 2)));
      const tot = d2.reduce((a, b) => a + b, 0);
      if (tot <= 0) { cent.push(X[rng.int(X.length)].slice()); continue; }
      let t = rng.next() * tot, i = 0;
      while (i < d2.length - 1 && (t -= d2[i]) > 0) i++;
      cent.push(X[i].slice());
    }
    let labels = new Array(X.length).fill(0);
    for (let it = 0; it < iters; it++) {
      let moved = false;
      for (let i = 0; i < X.length; i++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const d = dist(X[i], cent[c]); if (d < bd) { bd = d; bi = c; } }
        if (labels[i] !== bi) { labels[i] = bi; moved = true; }
      }
      for (let c = 0; c < k; c++) {
        const members = X.filter((_, i) => labels[i] === c);
        if (!members.length) { cent[c] = X[rng.int(X.length)].slice(); continue; }
        cent[c] = members[0].map((_, d) => mean(members.map((m) => m[d])));
      }
      if (!moved && it > 0) break;
    }
    const inertia = X.reduce((a, x, i) => a + dist(x, cent[labels[i]]) ** 2, 0);
    if (!best || inertia < best.inertia) best = { labels: [...labels], centroids: cent.map((c) => [...c]), inertia };
  }
  return best;
}

/**
 * ギャップ統計量（Tibshirani 2001）。
 * 「帰無参照でも同じくらい inertia が下がるなら、それは島ではない」
 *
 * 帰無参照は**列ごとの入れ替え**（各特徴の周辺分布はそのまま、特徴間の結びつきだけ壊す）。
 * 原論文の外接箱一様は次元が高いと参照が散りすぎて、どんな k でもギャップが出る。
 * 33次元・十数点というこの用途では列入れ替えのほうが正しい帰無になる。
 */
export function gapStatistic(X, kmax, rng, B = 30) {
  const d = X[0].length;
  const cols = [];
  for (let j = 0; j < d; j++) cols.push(X.map((x) => x[j]));

  const rows = [];
  for (let k = 1; k <= kmax; k++) {
    const obs = Math.log(Math.max(1e-12, kmeans(X, k, rng, 8).inertia));
    const refs = [];
    for (let b = 0; b < B; b++) {
      const shuffled = cols.map((c) => rng.shuffle(c.slice()));
      const R = X.map((_, i) => shuffled.map((c) => c[i]));
      refs.push(Math.log(Math.max(1e-12, kmeans(R, k, rng, 4).inertia)));
    }
    const gap = mean(refs) - obs;
    const sk = sd(refs) * Math.sqrt(1 + 1 / B);
    rows.push({ k, gap, sk, obs });
  }
  // 標準の選び方：gap(k) >= gap(k+1) - s(k+1) を満たす最小のk
  let kStar = kmax;
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].gap >= rows[i + 1].gap - rows[i + 1].sk) { kStar = rows[i].k; break; }
  }
  return { rows, kStar };
}

/** シルエット係数。-1（誤配）〜+1（きれいに分かれている） */
export function silhouette(X, labels) {
  const ks = [...new Set(labels)];
  if (ks.length < 2) return 0;
  const s = [];
  for (let i = 0; i < X.length; i++) {
    const own = [], other = new Map();
    for (let j = 0; j < X.length; j++) {
      if (i === j) continue;
      const d = dist(X[i], X[j]);
      if (labels[j] === labels[i]) own.push(d);
      else { if (!other.has(labels[j])) other.set(labels[j], []); other.get(labels[j]).push(d); }
    }
    if (!own.length || !other.size) { s.push(0); continue; }
    const a = mean(own);
    const b = Math.min(...[...other.values()].map(mean));
    s.push((b - a) / Math.max(a, b));
  }
  return mean(s);
}

/** クラスタ内／クラスタ間の平均距離と比。設計文書が使っている物差しに合わせてある。 */
export function withinBetween(X, labels) {
  const win = [], bet = [];
  for (let i = 0; i < X.length; i++) {
    for (let j = i + 1; j < X.length; j++) {
      (labels[i] === labels[j] ? win : bet).push(dist(X[i], X[j]));
    }
  }
  return { within: mean(win), between: mean(bet), ratio: mean(bet) / Math.max(1e-9, mean(win)) };
}

/** ラベルを混ぜても同じ比が出るか。出るならその島は幻。 */
export function permTestClusters(X, labels, rng, B = 1000) {
  const obs = withinBetween(X, labels).ratio;
  const shuf = [...labels];
  let ge = 0;
  for (let b = 0; b < B; b++) {
    rng.shuffle(shuf);
    if (withinBetween(X, shuf).ratio >= obs - 1e-12) ge++;
  }
  return { ratio: obs, p: (ge + 1) / (B + 1) };
}

/** 一つ抜き最近傍重心の識別率。「どの型か言い当てられるか」 */
export function identificationRate(X, labels) {
  const ks = [...new Set(labels)];
  let ok = 0;
  for (let i = 0; i < X.length; i++) {
    let bi = null, bd = Infinity;
    for (const c of ks) {
      const members = X.filter((_, j) => labels[j] === c && j !== i);
      if (!members.length) continue;
      const cent = members[0].map((_, d) => mean(members.map((m) => m[d])));
      const dd = dist(X[i], cent);
      if (dd < bd) { bd = dd; bi = c; }
    }
    if (bi === labels[i]) ok++;
  }
  const counts = ks.map((c) => labels.filter((l) => l === c).length);
  return {
    rate: ok / X.length,
    chanceUniform: 1 / ks.length,
    chanceMajority: Math.max(...counts) / labels.length,
  };
}

/**
 * 「本当に違う型か／同じ型のゆらぎか」を分ける本命。
 *
 * クラスタ対ごとに
 *   ・重心間の距離（1次元あたりのRMSに直すので「成績いくつ分ずれているか」で読める）
 *   ・その距離がラベルの偶然で説明できるか（方針を単位にした並べ替え検定）
 *   ・その距離が**測定誤差**を超えているか（S/N = 距離 / ノイズの床）
 * を返す。
 *
 * ノイズの床は仮定せず、種を半分ずつに割って同じ方針のプロファイルを2回測り、
 * その食い違いの大きさとして**実測する**（noiseFloor 引数）。
 *
 * @param V          方針ごとのベクトル（挙動なら相手別成績、パラメータなら特徴量）
 * @param noiseFloor 同じ方針を測り直したときの食い違い（Vと同じ単位・1次元あたりRMS）
 */
export function pairSeparation(V, labels, rng, noiseFloor, B = 2000) {
  const ks = [...new Set(labels)].sort((a, b) => a - b);
  const nDim = V[0].length;
  const centroid = (vs) => vs[0].map((_, d) => mean(vs.map((v) => v[d])));
  const byC = new Map(ks.map((c) => [c, V.filter((_, i) => labels[i] === c)]));
  const cents = new Map(ks.map((c) => [c, centroid(byC.get(c))]));
  const rms = (a, b) => dist(a, b) / Math.sqrt(nDim);

  const pairs = [];
  for (let a = 0; a < ks.length; a++) {
    for (let b = a + 1; b < ks.length; b++) {
      const ca = ks[a], cb = ks[b];
      const va = byC.get(ca), vb = byC.get(cb);
      const obs = rms(cents.get(ca), cents.get(cb));
      const pool = [...va, ...vb];
      let ge = 0;
      for (let i = 0; i < B; i++) {
        rng.shuffle(pool);
        if (rms(centroid(pool.slice(0, va.length)), centroid(pool.slice(va.length))) >= obs - 1e-12) ge++;
      }
      // クラスタ内のばらつき（方針が違うことによる散らばり）
      const wobble = mean([
        ...va.map((v) => rms(v, cents.get(ca))),
        ...vb.map((v) => rms(v, cents.get(cb))),
      ]);
      pairs.push({
        a: ca, b: cb, sep: obs, p: (ge + 1) / (B + 1),
        wobble, noiseFloor, snr: obs / Math.max(1e-9, noiseFloor),
      });
    }
  }
  return { pairs, centroids: cents };
}

/**
 * 測定誤差の床。同じ方針を、種を半分ずつに割って2回測ったときの食い違い。
 * @param profileOf (policyIdx, seedIdxList) => ベクトル
 */
export function measureNoiseFloor(policyIdxs, seedIdxs, profileOf, rng, reps = 20) {
  const ds = [];
  for (let r = 0; r < reps; r++) {
    const idx = rng.shuffle(seedIdxs.slice());
    const A = idx.slice(0, Math.floor(idx.length / 2)), B = idx.slice(Math.floor(idx.length / 2));
    for (const p of policyIdxs) {
      const a = profileOf(p, A), b = profileOf(p, B);
      ds.push(dist(a, b) / Math.sqrt(a.length));
    }
  }
  // 半数ずつで測った差なので、全種で測ったときの誤差はおよそ 1/√2 になる
  return mean(ds) / Math.SQRT2;
}

export { dist };
