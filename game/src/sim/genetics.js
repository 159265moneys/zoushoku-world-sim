// 遺伝：33座位／8染色体＋独立1本。
//
//  ・個体は染色体ごとに2本のハプロタイプ（hap[ch][0], hap[ch][1]）を持つ
//  ・対立遺伝子 allele = { v: 0..1, d: 優性か }
//  ・心系は離散の優劣。優性が1つでもあればそれが発現し、劣性は潜伏する。
//    劣性ホモになった瞬間に潜伏していた値が表に出る（＝数世代後の突然発現）
//  ・体系は中間遺伝。2本の平均＋ゆらぎ
//  ・可塑（ch0）が減数分裂の交叉率そのもの
//  ・同じ染色体の対抗アームは「平均A＋平均B＝ARM_BUDGET」に厳密正規化される。
//    これが「全ステが親2人を上回る子が出ない」の構造的な保証になる（下の証明を参照）

import { GENES, GENE_NAMES, CHROMOSOMES, KIND, ARM_BUDGET, MIND_GENES } from '../core/genes.js';
import * as C from './constants.js';

export const CH_LIST = Object.keys(CHROMOSOMES).map(Number).sort((a, b) => a - b);

// 染色体内の座位の並び。A アーム → B アームの順に並べることで、
// 交叉が少ない（可塑が低い）血統では A と B が丸ごとセットで伝わる＝連鎖が固まる。
export const LOCUS_ORDER = (() => {
  const m = {};
  for (const ch of CH_LIST) m[ch] = [...CHROMOSOMES[ch].A, ...CHROMOSOMES[ch].B];
  return m;
})();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * ハプロタイプ1本を対抗アーム予算に合わせる。
 * mean(A) + mean(B) === ARM_BUDGET に「厳密に」揃える（上限ではなく等式）。
 *
 * 上限（>のときだけ縮める）にすると世代を重ねるごとに値が下方ドリフトして
 * 1000世代で全員が虚弱になる。等式にすると保存則になりドリフトが消える。
 */
export function normalizeHap(hapCh, ch) {
  if (C.ARM_EXEMPT.has(ch)) return hapCh;
  const A = CHROMOSOMES[ch].A, B = CHROMOSOMES[ch].B;
  if (!A.length || !B.length) {
    // 対抗アームがない染色体（可塑）。予算がないので中央へ弱く引くだけ。
    for (const n of [...A, ...B]) {
      hapCh[n].v = clamp01(hapCh[n].v * (1 - C.DRIFT_PULL) + 0.5 * C.DRIFT_PULL);
    }
    return hapCh;
  }
  const ma = mean(A.map((n) => hapCh[n].v));
  const mb = mean(B.map((n) => hapCh[n].v));
  const s = ma + mb;
  if (s <= 1e-6) {
    for (const n of [...A, ...B]) hapCh[n].v = ARM_BUDGET / 2;
    return hapCh;
  }
  const k = ARM_BUDGET / s;
  for (const n of [...A, ...B]) hapCh[n].v = clamp01(hapCh[n].v * k);
  return hapCh;
}

export function normalizeGenome(hap) {
  for (const ch of CH_LIST) {
    normalizeHap(hap[ch][0], ch);
    normalizeHap(hap[ch][1], ch);
  }
  return hap;
}

/**
 * 表現型（＝素質）の側にも同じ対抗アーム予算を掛ける。
 *
 * 対立遺伝子の正規化だけでは足りない。心系は優劣（離散）なので、
 * 「A側は優性の高い値・B側も優性の高い値」というドミナンスの引き当て方をすると
 * 表現型では mean(A)+mean(B) > 1.0 になりうる。実測で「染色体単位で親2人の
 * 両方を上回る子」が出たのはここが抜けていたため。表現型でも等式にすると、
 * 対抗アームを持つ全ての染色体で構造的に不可能になる。
 */
export function normalizePhenotype(g) {
  for (const ch of CH_LIST) {
    if (C.ARM_EXEMPT.has(ch)) continue;
    const A = CHROMOSOMES[ch].A, B = CHROMOSOMES[ch].B;
    if (!A.length || !B.length) continue;
    const s = mean(A.map((n) => g[n])) + mean(B.map((n) => g[n]));
    if (s <= 1e-6) {
      for (const n of [...A, ...B]) g[n] = ARM_BUDGET / 2;
      continue;
    }
    const k = ARM_BUDGET / s;
    for (const n of [...A, ...B]) g[n] = clamp01(g[n] * k);
  }
  return g;
}

/** 2本のハプロタイプから素質（表現型）を出す。生涯不変。 */
export function phenotype(hap) {
  const g = {};
  for (const name of GENE_NAMES) {
    const ch = GENES[name].ch;
    const a = hap[ch][0][name], b = hap[ch][1][name];
    if (GENES[name].kind === KIND.MIND) {
      // 優性が1つでもあれば劣性は隠れる
      if (a.d && b.d) g[name] = (a.v + b.v) / 2;
      else if (a.d) g[name] = a.v;
      else if (b.d) g[name] = b.v;
      else g[name] = (a.v + b.v) / 2; // 劣性ホモ＝潜伏していたものが発現
    } else {
      g[name] = (a.v + b.v) / 2;
    }
  }
  return normalizePhenotype(g);
}

/** 保因者：片方だけが劣性の心系座位。潜伏している値を返す（v2ではUIに出さない）。 */
export function carriers(hap) {
  const out = {};
  for (const name of MIND_GENES) {
    const ch = GENES[name].ch;
    const a = hap[ch][0][name], b = hap[ch][1][name];
    if (a.d !== b.d) out[name] = a.d ? b.v : a.v;
  }
  return out;
}

/**
 * 遺伝的荷重。劣性対立遺伝子は「潜伏している値」だけでなく「潜伏している欠陥」も運ぶ。
 *
 * これを入れないと近親交配のペナルティが成立しない。劣性ホモ率が上がっても
 * 出る値が高いか低いかが変わるだけで、腐りはしないからである。
 * 閉じた血統は劣性ホモが溜まる → 荷重が溜まる → 生存力が落ちる。
 * 外の血が入るとヘテロに戻って荷重が隠れる ＝ 雑種強勢。
 * 「戦争に恒久的な経済理由ができた」というのはこの経路のこと。
 */
export function geneticLoad(hap) {
  let sum = 0;
  for (const name of MIND_GENES) {
    const ch = GENES[name].ch;
    const a = hap[ch][0][name], b = hap[ch][1][name];
    if (a.d || b.d) continue;                    // 優性が隠している間は無害
    sum += ((a.load || 0) + (b.load || 0)) / 2;
  }
  return sum;
}

/** 保有荷重：接合状態に関わらず持っている欠陥の総量。子孫に伝わるのはこちら。 */
export function carriedLoad(hap) {
  let sum = 0;
  for (const name of MIND_GENES) {
    const ch = GENES[name].ch;
    sum += (hap[ch][0][name].load || 0) + (hap[ch][1][name].load || 0);
  }
  return sum;
}

/** 荷重から出る生存力。産出・繁殖・戦闘・寿命の全部に掛かる。 */
export function vitalityOf(load) {
  const v = 1 - C.LOAD_WEIGHT * load;
  return v < C.LOAD_FLOOR ? C.LOAD_FLOOR : v > 1 ? 1 : v;
}

/** 劣性ホモになっている心系座位（＝今世代で表に出た潜伏形質） */
export function recessiveHomo(hap) {
  const out = [];
  for (const name of MIND_GENES) {
    const ch = GENES[name].ch;
    if (!hap[ch][0][name].d && !hap[ch][1][name].d) out.push(name);
  }
  return out;
}

/** ホモ接合率。近親交配の指標。高いほど劣性ホモが溜まっている。 */
export function homozygosity(hap) {
  let same = 0, n = 0;
  for (const name of GENE_NAMES) {
    const ch = GENES[name].ch;
    const a = hap[ch][0][name], b = hap[ch][1][name];
    n++;
    if (Math.abs(a.v - b.v) < 0.08 && a.d === b.d) same++;
  }
  return n ? same / n : 0;
}

/** 減数分裂。可塑（表現型）が交叉率そのもの。 */
export function gamete(hap, plasticity, rng) {
  const xrate = C.CROSSOVER_MIN + (C.CROSSOVER_MAX - C.CROSSOVER_MIN) * clamp01(plasticity);
  const out = {};
  for (const ch of CH_LIST) {
    const loci = LOCUS_ORDER[ch];
    let h = rng.int(2);
    const g = {};
    for (let i = 0; i < loci.length; i++) {
      if (i > 0 && rng.next() < xrate) h = 1 - h;
      const src = hap[ch][h][loci[i]];
      g[loci[i]] = { v: src.v, d: src.d, load: src.load || 0 };
    }
    out[ch] = g;
  }
  return out;
}

/** 突然変異と体系のゆらぎ。配偶子1本に対して掛ける。 */
export function mutate(gam, rng) {
  for (const ch of CH_LIST) {
    for (const name of LOCUS_ORDER[ch]) {
      const al = gam[ch][name];
      if (GENES[name].kind === KIND.BODY) {
        al.v = clamp01(al.v + rng.normal(0, C.BODY_JITTER));
      }
      if (rng.next() < C.MUT_RATE) {
        if (GENES[name].kind === KIND.MIND && rng.next() < C.MUT_DOMINANCE_FLIP) {
          al.d = !al.d;
          // 優性から劣性に落ちた対立遺伝子は欠陥を隠して運び始める
          if (!al.d && !al.load) al.load = rng.next() < 0.5 ? rng.range(0.1, 0.7) : 0;
        } else {
          al.v = clamp01(al.v + rng.normal(0, 0.18));
        }
      }
    }
  }
  return gam;
}

/** 父母のハプロタイプから子のゲノムを作る。 */
export function breedGenome(fatherHap, motherHap, fPlast, mPlast, rng) {
  const gf = mutate(gamete(fatherHap, fPlast, rng), rng);
  const gm = mutate(gamete(motherHap, mPlast, rng), rng);
  const hap = {};
  for (const ch of CH_LIST) hap[ch] = [gf[ch], gm[ch]];
  return normalizeGenome(hap);
}

/**
 * 「全ステが親2人を上回る子」を出さない最終保証。
 *
 * 構造的な証明：1番染色体は4座位すべてが体系＝中間遺伝なので、
 * 表現型の平均は2本のハプロタイプ平均の平均に等しい。正規化により
 * どのハプロタイプでも mean(A)+mean(B) = 1.0 なので、表現型でも
 * mean(A)+mean(B) = 1.0 が厳密に成立する。もし1番の4座位すべてが
 * 両親を上回れば mean(A)+mean(B) > 1.0 になり矛盾する。よって不可能。
 *
 * 下の関数は心系のドミナンス周りで理屈が通らない事故が起きたときの
 * 保険であり、通常は一度も発火しない（テストで発火回数を数えてよい）。
 */
export function enforceNoUniversalSuperiority(childGenes, fGenes, mGenes) {
  let all = true;
  for (const n of GENE_NAMES) {
    if (!(childGenes[n] > Math.max(fGenes[n], mGenes[n]) + 1e-9)) { all = false; break; }
  }
  if (!all) return false;
  // 発火した場合：最も余裕の小さい座位を親の最大値まで引き戻す
  let best = null, bestMargin = Infinity;
  for (const n of GENE_NAMES) {
    const m = childGenes[n] - Math.max(fGenes[n], mGenes[n]);
    if (m < bestMargin) { bestMargin = m; best = n; }
  }
  childGenes[best] = Math.max(fGenes[best], mGenes[best]) * 0.98;
  return true;
}

/**
 * 染色体単位でも「全座位が親2人の両方を上回る」を禁じる。
 *
 * 対抗アームを持つ染色体は normalizePhenotype で構造的に不可能になるが、
 * 8番（予算の対象外＝感受性と他責は対抗ではなく独立座位）だけは抜ける。
 * そこだけは予算ではなく明示の規則で塞ぐ。余裕の最も小さい1座位を
 * 親の上限まで戻すので、残りの座位は上回ったままでよい（変異は殺さない）。
 */
export function enforceChromosomeCeiling(childGenes, fGenes, mGenes) {
  let fired = 0;
  for (const ch of CH_LIST) {
    const loci = LOCUS_ORDER[ch];
    if (loci.length < 2) continue;               // 可塑は独立座位なので対象外
    let all = true;
    for (const n of loci) {
      if (!(childGenes[n] > Math.max(fGenes[n], mGenes[n]) + 1e-9)) { all = false; break; }
    }
    if (!all) continue;
    let best = null, bestMargin = Infinity;
    for (const n of loci) {
      const m = childGenes[n] - Math.max(fGenes[n], mGenes[n]);
      if (m < bestMargin) { bestMargin = m; best = n; }
    }
    childGenes[best] = Math.max(fGenes[best], mGenes[best]) * 0.995;
    fired++;
  }
  return fired;
}

/** 創世個体のゲノム。心系は answers（性格診断）で狙い値を与え、劣性は自由に振る。 */
/**
 * 創世個体1体のゲノム。
 * @param spread 心系のばらつき（＝種族の重心からどれだけ散るか）。
 *   体系は診断の対象外なので、この値には連動させず固定幅で振る（設計どおり「別枠」）。
 * @param loadP  劣性が欠陥を抱えている確率。
 *   創世（無から2体を作る）と、既に何世代も走っている国から個体を引くのとでは
 *   前提が違う。後者は突然変異と淘汰が釣り合った水準にいるので低い値を渡す。
 */
export function foundingGenome(targets, rng, spread = C.FOUND_SPREAD, loadP = C.LOAD_P) {
  const hap = {};
  for (const ch of CH_LIST) {
    hap[ch] = [{}, {}];
    for (const name of LOCUS_ORDER[ch]) {
      const isMind = GENES[name].kind === KIND.MIND;
      const t = targets[name] ?? 0.5;
      for (let h = 0; h < 2; h++) {
        if (isMind) {
          const dominant = rng.next() >= C.RECESSIVE_P;
          // 劣性は極端な値を引きやすくしておく。これが数世代後の「突然発現」の弾になる
          const v = dominant
            ? clamp01(t + rng.normal(0, spread))
            : (rng.bool() ? rng.range(0.72, 1.0) : rng.range(0.0, 0.28));
          // 劣性の半分は欠陥（荷重）も一緒に運ぶ。優性が隠している間は無害
          const load = dominant ? 0 : (rng.next() < loadP ? rng.range(0.20, 0.95) : 0);
          hap[ch][h][name] = { v, d: dominant, load };
        } else {
          hap[ch][h][name] = { v: clamp01(t + rng.normal(0, C.BODY_FOUND_SPREAD)), d: true, load: 0 };
        }
      }
    }
  }
  return normalizeGenome(hap);
}

/** 性格診断の回答配列 → 心系遺伝子の狙い値。数値なら何が来ても0..1に均す。 */
/**
 * オープニングの入力を「創世の狙い値」に変換する。
 *
 * 作るのは個体ではなく**種族**である。回答は種族の重心で、
 * アダムとイザナミはそこから独立に引いた2つのサンプルにすぎない。
 *
 * 受け付ける形は3つ（tools/ と ui/ の切り替え時期がずれるので後方互換を保つ）：
 *   1. { centroid: {心系遺伝子: 0..1}, spread }  … 本格診断（50〜60問）
 *   2. [0.8, 0.2, ...]                          … 旧・回答の配列
 *   3. null / {} / その他                        … すべて0.5の平凡な種族
 *
 * centroid は心系のみ。体系（代謝・頑健・攻撃素質…）は従来どおり別枠で振る。
 */
export function specToTargets(spec) {
  if (spec && !Array.isArray(spec) && typeof spec === 'object' && spec.centroid) {
    const t = {};
    for (const g of MIND_GENES) {
      const v = spec.centroid[g];
      t[g] = Number.isFinite(v) ? clamp01(v) : 0.5;
    }
    const s = Number.isFinite(spec.spread) ? clamp(spec.spread, 0.02, 0.45) : C.FOUND_SPREAD;
    return { targets: t, spread: s, mode: 'centroid' };
  }
  return {
    targets: answersToTargets(spec),
    spread: C.FOUND_SPREAD,
    mode: Array.isArray(spec) && spec.length ? 'answers' : 'default',
  };
}

/**
 * 要求された重心のうち、実際に成立する分を返す。
 *
 * 対抗アームの予算（mean(A)+mean(B)=1.0）は構造的な制約なので、
 * 「誇りも序列意識も高い種族」（5番の両アーム）は要求しても作れない。
 * 診断の結果をそのまま表示すると嘘になるので、UIはこちらを見せること。
 */
export function projectCentroid(centroid) {
  const g = {};
  for (const n of GENE_NAMES) {
    const v = centroid ? centroid[n] : undefined;
    g[n] = Number.isFinite(v) ? clamp01(v) : 0.5;
  }
  normalizePhenotype(g);
  const out = {};
  for (const n of MIND_GENES) out[n] = g[n];
  return out;
}

export function answersToTargets(answers) {
  const t = {};
  const arr = Array.isArray(answers) ? answers : [];
  const nums = arr.map((a) => {
    if (typeof a === 'number') return a;
    if (a && typeof a === 'object' && typeof a.value === 'number') return a.value;
    return 0.5;
  }).filter((x) => Number.isFinite(x));
  let norm = nums;
  if (nums.length) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    if (lo < 0 || hi > 1) {
      const span = hi - lo || 1;
      norm = nums.map((x) => (x - lo) / span);
    }
  }
  for (let i = 0; i < MIND_GENES.length; i++) {
    t[MIND_GENES[i]] = norm.length ? clamp01(norm[i % norm.length]) : 0.5;
  }
  return t;
}
