// 遺伝。**game/src/sim/genetics.js を読んで移した。書き直していない。**
//
// 旧版は 33座位／8染色体／対立遺伝子オブジェクト {v,d,load} の辞書だった。
// 中身の理屈（優劣・中間遺伝・交叉・連鎖・劣性の潜伏・対抗アーム予算・遺伝的荷重）は
// 一つも変えていない。変えたのは器だけ：
//   ・33座位 → 104ステ（docs/v3/stats_v3.csv に既に染色体と腕が書いてある）
//   ・値の幅 0〜1 → 0〜100（才能の幅に合わせた。定数は SCALE 倍して同じ意味を保つ）
//   ・辞書の入れ子 → 列ごとの型付き配列（a0/a1/dom/ld）
//
// 確定事項より：
//   A-5  からだ＝中間遺伝、あたま＝中間遺伝（A-20）、こころ＝優劣
//   A-5  連鎖群は必須。外すと60世代で全員が完璧になり世界が終わる
//        （連鎖なし：最良個体の平均99.4・101/101が80以上
//          連鎖あり：51.2・7〜13個）
//   A-18 育種そのものに代償がある。上位20%だけを親にすると狙っていないステまで落ちる
//
// 旧版からの構造的な保証（そのまま持ってきた）：
//   同じ染色体の反対の腕は「平均A＋平均B＝ARM_BUDGET」に**厳密に**正規化される。
//   上限（超えたときだけ縮める）にすると世代ごとに下方ドリフトして全員が虚弱になる。
//   等式にすると保存則になりドリフトが消える。

import * as S from '../core/stats.js';
import { breedGift, hasProsper } from './gifts.js';
import { HEART0, HEART_COUNT, ALLELE_Q } from './people.js';

// ---- 定数（旧 game/src/sim/constants.js の値。SCALE 倍しただけ） ----------
export const SCALE = 100;             // 才能の幅。旧版は 0〜1 だった
export const ARM_BUDGET = 1.0 * SCALE; // 平均A＋平均B。100 なので集団平均は50に落ち着く

export const CROSSOVER_MIN = 0.03;    // 可塑0のときの交叉率
export const CROSSOVER_MAX = 0.45;    // 可塑1のときの交叉率
export const MUT_RATE = 0.004;        // 座位あたりの突然変異率
export const MUT_DOMINANCE_FLIP = 0.30;
export const MUT_SPREAD = 0.18 * SCALE;
export const BODY_JITTER = 0.045 * SCALE;  // 中間遺伝のゆらぎ
export const FOUND_SPREAD = 0.16 * SCALE;
export const BODY_FOUND_SPREAD = 0.22 * SCALE;
export const RECESSIVE_P = 0.35;      // 創世時に劣性対立遺伝子を引く確率
export const DRIFT_PULL = 0.02;       // 制約のない座位（可塑）の中央回帰
export const LOAD_P = 0.55;           // 劣性対立遺伝子が荷重を持つ確率
export const LOAD_WEIGHT = 0.25;      // 荷重1につき生存力が何割落ちるか
export const LOAD_FLOOR = 0.35;       // どれだけ腐っても死にはしない床

// 旧版は8番（感受性・他責）を対抗アームではない独立座位として予算から外していた。
// 104ステでは14本すべてが A腕/B腕 の両方を持っている（52対52）ので、除外は空。
export const ARM_EXEMPT = new Set();

// ---- 染色体ごとの並び ------------------------------------------------------
// A腕 → B腕 の順に並べる。交叉が少ない（可塑が低い）血統では
// A と B が丸ごとセットで伝わる＝連鎖が固まる。旧版 LOCUS_ORDER と同じ考え。
export const CH_LIST = [];
for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) CH_LIST.push(c);

export const LOCUS_ORDER = [];   // LOCUS_ORDER[ch] = Int32Array
export const ARM_A_OF = [];      // ARM_A_OF[ch] = Int32Array
export const ARM_B_OF = [];
for (let c = 0; c <= S.CHROMOSOME_COUNT; c++) {
  const a = S.BY_ARM[c][0], b = S.BY_ARM[c][1];
  ARM_A_OF[c] = Int32Array.from(a);
  ARM_B_OF[c] = Int32Array.from(b);
  LOCUS_ORDER[c] = Int32Array.from([...a, ...b]);
}

const clampV = (x) => (x < 0 ? 0 : x > SCALE ? SCALE : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** こころ（優劣）か */
export function isDominantMode(s) { return S.INHERIT[s] === S.DOMINANT; }
/** こころ の何番目か。こころ でなければ -1 */
export function heartSlot(s) {
  const k = s - HEART0;
  return (k >= 0 && k < HEART_COUNT) ? k : -1;
}

// ---- 作業用の器（1回の出産ごとに使い回す。取り合いは起きない） --------------
function scratch() {
  return { v: new Float32Array(S.COUNT), d: new Uint8Array(S.COUNT), l: new Float32Array(S.COUNT), pl: 0 };
}
const GF = scratch(), GM = scratch();
const PHEN = new Float32Array(S.COUNT);

// ===========================================================================
// 正規化（旧 normalizeHap / normalizePhenotype）
// ===========================================================================

/**
 * 値の並び1本を、対抗アーム予算に合わせる。
 * mean(A) + mean(B) === ARM_BUDGET に「厳密に」揃える（上限ではなく等式）。
 */
export function normalizeArms(v, ch) {
  if (ARM_EXEMPT.has(ch)) return v;
  const A = ARM_A_OF[ch], B = ARM_B_OF[ch];
  if (!A.length || !B.length) {
    // 対抗アームがない染色体。予算がないので中央へ弱く引くだけ
    for (let k = 0; k < A.length; k++) v[A[k]] = clampV(v[A[k]] * (1 - DRIFT_PULL) + (SCALE / 2) * DRIFT_PULL);
    for (let k = 0; k < B.length; k++) v[B[k]] = clampV(v[B[k]] * (1 - DRIFT_PULL) + (SCALE / 2) * DRIFT_PULL);
    return v;
  }
  let ma = 0, mb = 0;
  for (let k = 0; k < A.length; k++) ma += v[A[k]];
  for (let k = 0; k < B.length; k++) mb += v[B[k]];
  ma /= A.length; mb /= B.length;
  const s = ma + mb;
  if (s <= 1e-6) {
    for (let k = 0; k < A.length; k++) v[A[k]] = ARM_BUDGET / 2;
    for (let k = 0; k < B.length; k++) v[B[k]] = ARM_BUDGET / 2;
    return v;
  }
  const kk = ARM_BUDGET / s;
  for (let k = 0; k < A.length; k++) v[A[k]] = clampV(v[A[k]] * kk);
  for (let k = 0; k < B.length; k++) v[B[k]] = clampV(v[B[k]] * kk);
  return v;
}

export function normalizeAll(v) {
  for (let c = 1; c <= S.CHROMOSOME_COUNT; c++) normalizeArms(v, c);
  return v;
}

// ===========================================================================
// 対立遺伝子の出し入れ（u16 と ビット と u8 に詰める）
// ===========================================================================
export function getAllele(P, i, s, h) {
  const A = P.a;
  const q = (h === 0 ? A.a0 : A.a1)[s][i];
  return q / ALLELE_Q;
}
export function getDom(P, i, s, h) {
  const k = heartSlot(s);
  if (k < 0) return true;                       // 中間遺伝に優劣は無い
  const bits = (h === 0 ? P.a.dom0 : P.a.dom1)[i];
  return ((bits >>> k) & 1) === 1;
}
export function getLoad(P, i, s, h) {
  const k = heartSlot(s);
  if (k < 0) return 0;
  return (h === 0 ? P.a.ld0 : P.a.ld1)[k][i] / 255;
}

function writeHap(P, i, h, v, d, l) {
  const A = P.a;
  const av = h === 0 ? A.a0 : A.a1;
  const ld = h === 0 ? A.ld0 : A.ld1;
  let bits = 0;
  for (let s = 0; s < S.COUNT; s++) {
    let q = Math.round(clampV(v[s]) * ALLELE_Q);
    if (q < 0) q = 0; else if (q > 65535) q = 65535;
    av[s][i] = q;
    const k = s - HEART0;
    if (k >= 0 && k < HEART_COUNT) {
      if (d[s]) bits |= (1 << k);
      let q2 = Math.round(clamp01(l[s]) * 255);
      ld[k][i] = q2;
    }
  }
  if (h === 0) A.dom0[i] = bits >>> 0; else A.dom1[i] = bits >>> 0;
}

// ===========================================================================
// 表現型（＝才能）。生涯不変
// ===========================================================================
/**
 * 2本の対立遺伝子から才能を出して gene[s][i] に書く。
 *   こころ（優劣）… 顕性が1つでもあればそれが発現し、劣性は潜伏する。
 *                   劣性ホモになった瞬間に潜伏していた値が表に出る（＝数世代後の突然発現）
 *   からだ・あたま（中間遺伝）… 2本の平均
 * そのあと表現型の側にも同じ対抗アーム予算を掛ける。
 *
 * 対立遺伝子の正規化だけでは足りない。こころは優劣（離散）なので
 * 「A側もB側も顕性の高い値」という引き当て方をすると表現型では
 * mean(A)+mean(B) > ARM_BUDGET になりうる。表現型でも等式にすると
 * 対抗アームを持つ全ての染色体で構造的に不可能になる。（旧版と同じ理由）
 */
export function refreshPhenotype(P, i) {
  const A = P.a;
  const b0 = A.dom0[i], b1 = A.dom1[i];
  for (let s = 0; s < S.COUNT; s++) {
    const a = A.a0[s][i] / ALLELE_Q, b = A.a1[s][i] / ALLELE_Q;
    const k = s - HEART0;
    if (k >= 0 && k < HEART_COUNT) {
      const da = (b0 >>> k) & 1, db = (b1 >>> k) & 1;
      if (da && db) PHEN[s] = (a + b) / 2;
      else if (da) PHEN[s] = a;
      else if (db) PHEN[s] = b;
      else PHEN[s] = (a + b) / 2;      // 劣性ホモ＝潜伏していたものが発現
    } else {
      PHEN[s] = (a + b) / 2;
    }
  }
  normalizeAll(PHEN);
  for (let s = 0; s < S.COUNT; s++) A.gene[s][i] = PHEN[s];
  A.plast[i] = clamp01((A.pl0[i] + A.pl1[i]) / 2);
  A.vitality[i] = vitalityOf(geneticLoad(P, i));
  return A.gene;
}

// ===========================================================================
// 荷重・保因・ホモ接合（旧版そのまま）
// ===========================================================================

/**
 * 遺伝的荷重。劣性対立遺伝子は「潜伏している値」だけでなく「潜伏している欠陥」も運ぶ。
 * これを入れないと近親交配のペナルティが成立しない。劣性ホモ率が上がっても
 * 出る値が高いか低いかが変わるだけで、腐りはしないからである。
 * 閉じた血統は劣性ホモが溜まる → 荷重が溜まる → 生存力が落ちる。
 * 外の血が入るとヘテロに戻って荷重が隠れる ＝ 雑種強勢。
 * A-19b の「戦争しなければ血は絶対に新しくならない」はこの経路のこと。
 */
export function geneticLoad(P, i) {
  const A = P.a;
  const b0 = A.dom0[i], b1 = A.dom1[i];
  let sum = 0;
  for (let k = 0; k < HEART_COUNT; k++) {
    if (((b0 >>> k) & 1) || ((b1 >>> k) & 1)) continue;   // 顕性が隠している間は無害
    sum += (A.ld0[k][i] / 255 + A.ld1[k][i] / 255) / 2;
  }
  return sum;
}

/** 保有荷重：接合状態に関わらず持っている欠陥の総量。子孫に伝わるのはこちら */
export function carriedLoad(P, i) {
  const A = P.a;
  let sum = 0;
  for (let k = 0; k < HEART_COUNT; k++) sum += A.ld0[k][i] / 255 + A.ld1[k][i] / 255;
  return sum;
}

/** 荷重から出る生存力。産む・生きる・老いる の全部に掛かる */
export function vitalityOf(load) {
  const v = 1 - LOAD_WEIGHT * load;
  return v < LOAD_FLOOR ? LOAD_FLOOR : v > 1 ? 1 : v;
}

/** 保因者：片方だけが劣性のこころ座位。潜伏している値を返す */
export function carriers(P, i) {
  const A = P.a, out = [];
  const b0 = A.dom0[i], b1 = A.dom1[i];
  for (let k = 0; k < HEART_COUNT; k++) {
    const da = (b0 >>> k) & 1, db = (b1 >>> k) & 1;
    if (da !== db) {
      const s = HEART0 + k;
      out.push([s, (da ? A.a1[s][i] : A.a0[s][i]) / ALLELE_Q]);
    }
  }
  return out;
}

/** 劣性ホモになっているこころ座位（＝今世代で表に出た潜伏形質） */
export function recessiveHomo(P, i) {
  const A = P.a, out = [];
  const b0 = A.dom0[i], b1 = A.dom1[i];
  for (let k = 0; k < HEART_COUNT; k++) {
    if (!((b0 >>> k) & 1) && !((b1 >>> k) & 1)) out.push(HEART0 + k);
  }
  return out;
}

/** ホモ接合率。近親交配の指標。高いほど劣性ホモが溜まっている */
export function homozygosity(P, i) {
  const A = P.a;
  const b0 = A.dom0[i], b1 = A.dom1[i];
  let same = 0;
  for (let s = 0; s < S.COUNT; s++) {
    const a = A.a0[s][i] / ALLELE_Q, b = A.a1[s][i] / ALLELE_Q;
    const k = s - HEART0;
    const da = (k >= 0 && k < HEART_COUNT) ? ((b0 >>> k) & 1) : 1;
    const db = (k >= 0 && k < HEART_COUNT) ? ((b1 >>> k) & 1) : 1;
    if (Math.abs(a - b) < 0.08 * SCALE && da === db) same++;
  }
  return same / S.COUNT;
}

// ===========================================================================
// 減数分裂と突然変異
// ===========================================================================

/** 可塑（表現型）が交叉率そのもの。旧版と同じ式 */
export function crossoverRate(plasticity) {
  return CROSSOVER_MIN + (CROSSOVER_MAX - CROSSOVER_MIN) * clamp01(plasticity);
}

/** 減数分裂。染色体ごとに A腕→B腕 の並びを歩いて、交叉率で乗り換える */
export function gamete(P, i, rng, out) {
  const A = P.a;
  // 繁栄（S・A-23）は交叉が起きない。染色体が1本まるごと、混ざらずに子へ渡る。
  // **良い個体の組み合わせをそのまま複製できる。**逆に欠陥もそのまま渡る
  const xrate = hasProsper(P, i) ? 0 : crossoverRate(A.plast[i]);
  const b0 = A.dom0[i], b1 = A.dom1[i];
  for (let ci = 0; ci < CH_LIST.length; ci++) {
    const ch = CH_LIST[ci];
    const loci = LOCUS_ORDER[ch];
    let h = rng.int(2);
    for (let n = 0; n < loci.length; n++) {
      if (n > 0 && rng.next() < xrate) h = 1 - h;
      const s = loci[n];
      out.v[s] = (h === 0 ? A.a0 : A.a1)[s][i] / ALLELE_Q;
      const k = s - HEART0;
      if (k >= 0 && k < HEART_COUNT) {
        out.d[s] = ((h === 0 ? b0 : b1) >>> k) & 1;
        out.l[s] = (h === 0 ? A.ld0 : A.ld1)[k][i] / 255;
      } else { out.d[s] = 1; out.l[s] = 0; }
    }
  }
  // 可塑は独立座位。交叉の対象ではなく、2本のどちらかがそのまま渡る
  out.pl = rng.int(2) === 0 ? A.pl0[i] : A.pl1[i];
  return out;
}

/** 突然変異と中間遺伝のゆらぎ。配偶子1本に対して掛ける */
export function mutate(g, rng) {
  for (let s = 0; s < S.COUNT; s++) {
    const dominantMode = isDominantMode(s);
    if (!dominantMode) g.v[s] = clampV(g.v[s] + rng.normal(0, BODY_JITTER));
    if (rng.next() < MUT_RATE) {
      if (dominantMode && rng.next() < MUT_DOMINANCE_FLIP) {
        g.d[s] = g.d[s] ? 0 : 1;
        // 顕性から劣性に落ちた対立遺伝子は欠陥を隠して運び始める
        if (!g.d[s] && !g.l[s]) g.l[s] = rng.next() < 0.5 ? rng.range(0.1, 0.7) : 0;
      } else {
        g.v[s] = clampV(g.v[s] + rng.normal(0, MUT_SPREAD));
      }
    }
  }
  g.pl = clamp01(g.pl + rng.normal(0, 0.03));
  return g;
}

// ===========================================================================
// 交配
// ===========================================================================
/**
 * 父母から子のゲノムを作って、child の席に書き込む。
 * @param rng     出生・遺伝のストリーム（STREAM.BIRTH）
 * @param rngGift 授かりものだけ別のストリーム（STREAM.GIFT）。省略すると rng と同じ本
 * @returns {{ceilingFired:number}} 保険が何回発火したか（通常は0）
 */
export function breed(P, child, father, mother, rng, rngGift = rng) {
  gamete(P, father, rng, GF); mutate(GF, rng);
  gamete(P, mother, rng, GM); mutate(GM, rng);
  // ハプロタイプごとに対抗アーム予算へ揃える（旧 normalizeGenome）
  normalizeAll(GF.v);
  normalizeAll(GM.v);
  writeHap(P, child, 0, GF.v, GF.d, GF.l);
  writeHap(P, child, 1, GM.v, GM.d, GM.l);
  P.a.pl0[child] = GF.pl;
  P.a.pl1[child] = GM.pl;
  refreshPhenotype(P, child);
  // 授かりもの（S以上）。106ステの交叉とは独立の1座位（A-23）
  // ★ 乱数は別ストリーム（#17 §10-3 の2番）。天井が動いても遺伝の流れが1ビットも動かない
  breedGift(P, child, father, mother, rngGift);
  const fired = enforceChromosomeCeiling(P, child, father, mother);
  return { ceilingFired: fired };
}

/**
 * 染色体単位で「全座位が親2人の両方を上回る」を禁じる（旧版の保険）。
 *
 * 対抗アームを持つ染色体は正規化で構造的に不可能になるので、通常は一度も発火しない。
 * こころの優劣まわりで理屈が通らない事故が起きたときのためだけに残してある。
 * 余裕の最も小さい1座位を親の上限まで戻すので、残りは上回ったままでよい（変異は殺さない）。
 */
export function enforceChromosomeCeiling(P, child, father, mother) {
  const A = P.a;
  let fired = 0;
  for (let ci = 0; ci < CH_LIST.length; ci++) {
    const loci = LOCUS_ORDER[CH_LIST[ci]];
    if (loci.length < 2) continue;
    let all = true;
    for (let n = 0; n < loci.length; n++) {
      const s = loci[n];
      const hi = Math.max(A.gene[s][father], A.gene[s][mother]);
      if (!(A.gene[s][child] > hi + 1e-9)) { all = false; break; }
    }
    if (!all) continue;
    let best = -1, bestMargin = Infinity;
    for (let n = 0; n < loci.length; n++) {
      const s = loci[n];
      const m = A.gene[s][child] - Math.max(A.gene[s][father], A.gene[s][mother]);
      if (m < bestMargin) { bestMargin = m; best = s; }
    }
    A.gene[best][child] = Math.max(A.gene[best][father], A.gene[best][mother]) * 0.995;
    fired++;
  }
  return fired;
}

// ===========================================================================
// 創世
// ===========================================================================
/**
 * 創世個体1体のゲノム。
 * @param targets Float32Array(104)。種族の重心（0〜100）。null なら全部50
 * @param spread  こころのばらつき（種族の重心からどれだけ散るか）
 * @param loadP   劣性が欠陥を抱えている確率
 */
export function foundGenome(P, i, rng, targets = null, spread = FOUND_SPREAD, loadP = LOAD_P) {
  const A = P.a;
  const sp = clamp(spread, 0.02 * SCALE, 0.45 * SCALE);
  for (let h = 0; h < 2; h++) {
    const g = h === 0 ? GF : GM;
    for (let s = 0; s < S.COUNT; s++) {
      const t = targets ? targets[s] : SCALE / 2;
      if (isDominantMode(s)) {
        const dominant = rng.next() >= RECESSIVE_P;
        // 劣性は極端な値を引きやすくしておく。これが数世代後の「突然発現」の弾になる
        const v = dominant
          ? clampV(t + rng.normal(0, sp))
          : (rng.bool() ? rng.range(0.72 * SCALE, SCALE) : rng.range(0, 0.28 * SCALE));
        g.v[s] = v;
        g.d[s] = dominant ? 1 : 0;
        // 劣性の半分は欠陥（荷重）も一緒に運ぶ。顕性が隠している間は無害
        g.l[s] = dominant ? 0 : (rng.next() < loadP ? rng.range(0.20, 0.95) : 0);
      } else {
        g.v[s] = clampV(t + rng.normal(0, BODY_FOUND_SPREAD));
        g.d[s] = 1; g.l[s] = 0;
      }
    }
    normalizeAll(g.v);
    writeHap(P, i, h, g.v, g.d, g.l);
    const pl = clamp01(rng.range(0.2, 0.8));
    if (h === 0) A.pl0[i] = pl; else A.pl1[i] = pl;
  }
  refreshPhenotype(P, i);
  return i;
}

/** 診断の重心（名前→0〜1）を targets（Float32Array・0〜100）に直す */
export function targetsFrom(centroid) {
  const t = new Float32Array(S.COUNT).fill(SCALE / 2);
  if (!centroid) return t;
  for (const name of Object.keys(centroid)) {
    const id = S.idOf(name);
    if (id < 0) continue;
    const v = centroid[name];
    if (Number.isFinite(v)) t[id] = clampV(v <= 1 ? v * SCALE : v);
  }
  return t;
}
