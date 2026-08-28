// 欲7つ（正典 3-4 ＋ #3「満たされていない度 U の定義」）。
//
//   g_k = (元になるステの積 ÷ 100) × (0.5 + 気分の振れ幅の実効値/100)   ∈ [0, 1.5]
//   X_k = g_k × U_k × c          c = 0.30 点／月     ← 日常の基底圧。#4 の配分へ流す
//   出力_k = g_k × (1 − U_k) × ι    ι = 1.0（外発）／ 1.4（内発）
//
// ★ **U が高い＝不満が出る／U が低い＝出力が出る、が同じ1本のUの表と裏。**
//   欲を全部低く育てた国民は、不満もゼロだが出力もゼロ。
//
// ★ 入力はすべて**実効値**（正典 #3 §1）。
//   繁殖力（2B）と体重（1A）は からだ なので老いが乗る。実測の中央は 40.4／36.0 で
//   才能の50ではない。**才能で読むと Σg を12%高く見積もる。**
//
// ★ 二重掛けを外してある（#3 §0 の直し1）。
//   気分の振れ幅は g の中だけで効く。外側にも掛けると振れ幅100の者と0の者で9倍開き、
//   11番B腕が不満量を単独で支配する。

import * as S from '../core/stats.js';
import { ST_PREGNANT } from '../core/states.js';
import { NO_ONE, NO_VILLAGE } from './people.js';

// ---- 欲の番号 -------------------------------------------------------------
export const PRIDE = 0, GREED = 1, ENVY = 2, WRATH = 3,
             LUST = 4, GLUTTONY = 5, SLOTH = 6;
export const DESIRE_COUNT = 7;
export const DESIRE_NAMES = ['傲慢', '強欲', '嫉妬', '憤怒', '色欲', '暴食', '怠惰'];

// A群（参照点を持つ3つ）。ref[] の添字
export const REF_GREED = 0, REF_GLUTTONY = 1, REF_ENVY = 2;
export const REF_COUNT = 3;
export const REF_OF = [-1, REF_GREED, REF_ENVY, -1, -1, REF_GLUTTONY, -1];  // 欲 → ref 添字

export const C_SCALE = 0.30;        // 目盛り c。0.30 点／月
export const REF_INIT = 30;         // 参照点の初期値（12歳到達時）
export const REF_RATE = 0.10;       // 慣れの速さ
export const IOTA_INNATE = 1.4;     // 内発の出力の倍率

// ---- ステ番号。起動時に1度だけ引く -----------------------------------------
const ID = {
  誇り: S.needId('誇り'), 野心: S.needId('野心'), 貪欲: S.needId('貪欲'),
  嫉妬: S.needId('嫉妬'), 序列意識: S.needId('序列意識'), 他責: S.needId('他責'),
  色欲: S.needId('色欲'), 繁殖力: S.needId('繁殖力'), 体重: S.needId('体重'),
  勤勉: S.needId('勤勉'), 振れ幅: S.needId('気分の振れ幅'),
};
export { ID as STAT_ID };

/**
 * 欲の強度 g（7本）。入力はすべて実効値。
 * @param out 長さ7の配列を使い回す
 */
export function strength(P, i, out) {
  const e = (s) => P.effective(i, s);
  const mult = 0.5 + e(ID.振れ幅) / 100;          // ∈ [0.5, 1.5]
  const pair = (a, b) => (e(a) * e(b) / 100) / 100 * mult;
  const solo = (a) => e(a) / 100 * mult;
  out[PRIDE]    = pair(ID.誇り, ID.野心);
  out[GREED]    = solo(ID.貪欲);
  out[ENVY]     = pair(ID.嫉妬, ID.序列意識);
  out[WRATH]    = solo(ID.他責);
  out[LUST]     = pair(ID.色欲, ID.繁殖力);
  out[GLUTTONY] = solo(ID.体重);
  out[SLOTH]    = (100 - e(ID.勤勉)) / 100 * mult;
  for (let k = 0; k < DESIRE_COUNT; k++) if (out[k] < 0) out[k] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// 供給 S ∈ [0,100]
// ---------------------------------------------------------------------------
//
// A群だけが S を持つ。B群は U を直に引く（供給が離散なので参照点が意味を持たない）。
// source タグ：ACT ＝ 行為そのもの／GIVE ＝ 外から渡す。
// **A群の3つ（強欲・暴食・嫉妬）は3つとも GIVE**（正典 #3 §2 の表）。

export const SRC_ACT = 1, SRC_GIVE = 2;

/** 強欲。村の財の中央値との差。★ +1 でゼロ割も発散もしない */
export function supplyGreed(wealth, villageMedian) {
  const s = 50 + 50 * (wealth - villageMedian) / (villageMedian + 1);
  return s < 0 ? 0 : s > 100 ? 100 : s;
}
/** 暴食。直近3ヶ月の1人あたり実配給 ÷ 大人1人ぶん × 100 */
export function supplyGluttony(intake3, eatAdult) {
  const s = intake3 / eatAdult * 100;
  return s < 0 ? 0 : s > 100 ? 100 : s;
}
/** 嫉妬。村内で国民力が自分より上の者の割合を引く。★ 同値は上に数えない */
export function supplyEnvy(aboveRatio) {
  const s = 100 - aboveRatio * 100;
  return s < 0 ? 0 : s > 100 ? 100 : s;
}

/**
 * A群の毎月。参照点を動かし、U を返す。
 * 　外発： R ← R + 0.10 × (S − R)      内発： R = 30 で固定（慣れない）
 * 　要求 = 30 + 0.70 × R  ∈ [30,100]   ★下駄30なのでゼロ割は構造的に起きない
 */
export function unmetA(P, i, refIdx, s, innate) {
  const A = P.a;
  let R = A.ref[refIdx][i];
  if (!innate) { R += REF_RATE * (s - R); A.ref[refIdx][i] = R; }
  else { R = REF_INIT; A.ref[refIdx][i] = R; }
  const want = 30 + 0.70 * R;
  const u = (want - s) / want;
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

// ---- B群（参照点を持たない4つ） --------------------------------------------

export const RANK_TITLE_STEP = 10;   // 爵位1段ぶん（0..5）
export const RANK_POST_STEP = 15;    // 役職1段ぶん（0..3）
export const STANDING_MAX = 95;      // 立場の上限 ＝ 5×10 + 3×15

/**
 * 傲慢。立場 ＝ 爵位の段×10 + 役職の段×15 ∈ [0,95]。
 * ★ max(0,·) を掛けない。**負の評判は傲慢 U を上げる**（辱められた者ほど満たされない）。
 * ★ 内発なら爵位も評判も効かず、役職の段だけが残る。
 */
export function unmetPride(titleStep, postStep, rep, innate) {
  if (innate) {
    const v = postStep / 3;
    return 1 - (v < 0 ? 0 : v > 1 ? 1 : v);
  }
  const standing = titleStep * RANK_TITLE_STEP + postStep * RANK_POST_STEP;
  const v = (standing + 0.5 * rep) / STANDING_MAX;
  return 1 - (v < 0 ? 0 : v > 1 ? 1 : v);
}

/**
 * 憤怒。直近12ヶ月。★ 狩り由来は30で頭打ち ＝ 狩りだけでは絶対に満充足に届かない。
 * ★ #4 の grudge1 に V≥60 の相手が生きて残っていれば U ← max(U, 0.60)
 */
export function unmetWrath(warMonths, duelWins, executions, hunts, liveGrudge) {
  const v = (30 * (warMonths + duelWins + executions) + Math.min(30, 4 * hunts)) / 100;
  let u = 1 - (v < 0 ? 0 : v > 1 ? 1 : v);
  if (liveGrudge && u < 0.60) u = 0.60;
  return u;
}

/** 色欲 */
export function unmetLust(hasSpouse, boreOrConceived12) {
  return 1 - (0.70 * (hasSpouse ? 1 : 0) + 0.30 * (boreOrConceived12 ? 1 : 0));
}

/** 怠惰。★ 働くほど満たされない。満たす＝産出が落ちる */
export function unmetSloth(workDays) {
  const v = workDays / 30;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// 内発／外発（正典3-4「幼いころにその欲が何で満たされたかで決まる」の機構化）
// ---------------------------------------------------------------------------
//
// 13歳の誕生月に、欲ごとに1度だけ判定して固定する。
//   内発 ⟺ 6〜12歳の84ヶ月に累積した S のうち ACT 由来が60%以上 かつ ACT の月数が24以上
// ★ 暴食・怠惰・色欲は判定せず**常に外発**（ACT の出どころが無い生理欲求）。
// ★ A群3つ（強欲・暴食・嫉妬）の供給は3つとも GIVE なので、
//   **いま内発になりうるのは 傲慢（指揮）と 憤怒（戦・狩り）の2つだけ。**
//   どちらも供給源がまだ無いので、現状は全員が外発になる。器は在る。

export const JUDGED = [PRIDE, WRATH];          // 内発判定をする欲
export const CHILD_FROM = 6, CHILD_TO = 13;    // 6歳から13歳の誕生月まで
export const INNATE_SHARE = 0.60, INNATE_MONTHS = 24;

export const isInnate = (P, i, k) => ((P.a.innate[i] >>> k) & 1) === 1;

/** 6〜12歳のあいだ、供給を ACT／全体 に積む。judged な欲だけ */
export function logChildSupply(P, i, k, s, src) {
  const j = JUDGED.indexOf(k);
  if (j < 0 || s <= 0) return;
  const A = P.a;
  A.childAll[j][i] += s;
  if (src === SRC_ACT) {
    A.childAct[j][i] += s;
    if (A.childActMonths[j][i] < 255) A.childActMonths[j][i]++;
  }
}

/** 13歳の誕生月に1度だけ。以後は動かない */
export function fixInnate(P, i) {
  const A = P.a;
  let bits = 0;
  for (let j = 0; j < JUDGED.length; j++) {
    const all = A.childAll[j][i], act = A.childAct[j][i];
    if (all > 0 && act / all >= INNATE_SHARE && A.childActMonths[j][i] >= INNATE_MONTHS) {
      bits |= 1 << JUDGED[j];
    }
  }
  A.innate[i] = bits;
  return bits;
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
/** 出力_k = g_k × (1 − U_k) × ι     ∈ [0, 2.1] */
export function outputOf(g, u, innate) {
  return g * (1 - u) * (innate ? IOTA_INNATE : 1.0);
}

// 出力の接続先（正典 #3 §4）。**stats_v3.csv に実在するものだけ**
export const OUT_ID = {
  人をまとめる素質: S.needId('人をまとめる素質'),   // 傲慢 ＋0.30×出力（N-22 で実在）
  見て盗む力: S.needId('見て盗む力'),               // 嫉妬 ＋0.40×出力
  飢えへの強さ: S.needId('飢えへの強さ'),           // 暴食 ＋0.20×出力
  体重: ID.体重,                                    // 暴食 drift ＋0.5×出力／年
};
export const OUT_COEF = { 傲慢: 0.30, 嫉妬: 0.40, 暴食: 0.20, 強欲: 0.15, 色欲: 0.30 };
export const GLUTTONY_WEIGHT_PER_YEAR = 0.5, GLUTTONY_WEIGHT_CAP = 15;
export const SLOTH_FATIGUE_PER_MONTH = 2.0, SLOTH_LIFE_PER_YEAR = 0.5, SLOTH_LIFE_CAP = 8;

// ---------------------------------------------------------------------------
// 月次
// ---------------------------------------------------------------------------
/**
 * 欲の月次。村ごとに「財の中央値」と「国民力の順位」が要るので、村単位でまとめて回す。
 *
 * @param workDaysOf (i) → その月の労働日数。村と暦が知っていることなので呼ぶ側が決める
 * @param eatAdult   大人1人が1ヶ月に食べる量（village.js の EAT_ADULT）
 * @param intakeOf   (i) → その月に実際に食べられた量
 * @param onX        (i, X[7]) → その月の日常の基底圧。#4 の配分へ流す
 */
export function desireMonth(P, V, tick, opts) {
  const A = P.a;
  const { workDaysOf, eatAdult, intakeOf, onX } = opts;
  const nv = V.a.len;

  // ---- 村ごとの下ごしらえ（財の中央値と、国民力の並び） ----
  const byVillage = new Array(nv).fill(null);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    if (!byVillage[v]) byVillage[v] = [];
    byVillage[v].push(i);
  }
  const medianWealth = new Float64Array(nv);
  const civicSorted = new Array(nv).fill(null);
  for (let v = 0; v < nv; v++) {
    const list = byVillage[v];
    if (!list || !list.length) continue;
    const w = list.map(i => A.wealth[i]).sort((a, b) => a - b);
    medianWealth[v] = w[(w.length / 2) | 0];
    civicSorted[v] = list.map(i => A.civicSum[i]).sort((a, b) => a - b);
  }

  const g = new Float64Array(DESIRE_COUNT), u = new Float64Array(DESIRE_COUNT);
  const X = new Float64Array(DESIRE_COUNT);
  let counted = 0;

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv || !civicSorted[v]) continue;
    const y = (A.ageMonths[i] / 12) | 0;

    // 12歳で参照点を置く
    if (y >= 12 && A.ref[REF_GREED][i] === 0) {
      for (let r = 0; r < REF_COUNT; r++) A.ref[r][i] = REF_INIT;
    }
    // 13歳の誕生月に内発を1度だけ固定する
    if (y === CHILD_TO && A.ageMonths[i] % 12 === 0) fixInnate(P, i);
    if (y < 12) continue;                 // 子どもはまだ欲を持たない

    strength(P, i, g);

    // ---- A群（参照点つき。3つとも供給は GIVE） ----
    const sGreed = supplyGreed(A.wealth[i], medianWealth[v]);
    A.intake[2][i] = A.intake[1][i]; A.intake[1][i] = A.intake[0][i];
    A.intake[0][i] = Math.max(0, Math.min(255, Math.round(intakeOf(i) / eatAdult * 100)));
    const intake3 = (A.intake[0][i] + A.intake[1][i] + A.intake[2][i]) / 3 / 100 * eatAdult;
    const sGlut = supplyGluttony(intake3, eatAdult);
    // 国民力が自分より上の者の割合。★ 同値は上に数えない
    const arr = civicSorted[v], mine = A.civicSum[i];
    let above = 0;
    for (let k = arr.length - 1; k >= 0; k--) { if (arr[k] > mine) above++; else break; }
    const sEnvy = supplyEnvy(arr.length ? above / arr.length : 0);

    u[GREED]    = unmetA(P, i, REF_GREED,    sGreed, isInnate(P, i, GREED));
    u[GLUTTONY] = unmetA(P, i, REF_GLUTTONY, sGlut,  false);   // 暴食は常に外発
    u[ENVY]     = unmetA(P, i, REF_ENVY,     sEnvy,  isInnate(P, i, ENVY));

    // ---- B群 ----
    // ★ 立場（爵位・役職）はまだ存在しないので 0。**正典の検算と同じ「無役の平民」の姿**
    u[PRIDE] = unmetPride(0, 0, A.rep[i], isInnate(P, i, PRIDE));
    // ★ 戦・私闘・処刑・狩りの仕留めは供給源がまだ無い。全員 U=1.000（正典の検算と同じ）
    u[WRATH] = unmetWrath(0, 0, 0, 0, false);
    const bore12 = A.lastBirth[i] >= 0 && tick - A.lastBirth[i] < 360;
    u[LUST] = unmetLust(A.spouse[i] !== NO_ONE, bore12 || (A.state[i] & ST_PREGNANT) !== 0);
    u[SLOTH] = unmetSloth(workDaysOf(i));

    // ---- X と 出力 ----
    for (let k = 0; k < DESIRE_COUNT; k++) {
      X[k] = g[k] * u[k] * C_SCALE;
      A.desireOut[k][i] = outputOf(g[k], u[k], isInnate(P, i, k));
    }
    if (onX) onX(i, X);
    counted++;
  }
  return { counted };
}
