// 不満6本と恨み6本（正典3-5 ＋ 第7部 §2 の allocate ＋ #4 の薄れ方）。
//
// **不満を1つの数字に潰さない。向きを持つ。**
// 「不満80の男」が何をするかは決まらないが、「統治への不満80の男」と
// 「自分への不満80の男」は別の行動をする。
//
// ★ 2列にする（#4-(b)）。日常は**不満**にしか入らない。恨みは事件からしか積まない。
//     不満[k] ← #3 の欲の未充足（日常の基底圧）／ 特定度 t=0 の出来事（相手がいない）
//     恨み[k] ← 特定度 t ≥ 0.5 の出来事（下手人が個人か組織として特定できる）
//   t は出来事の属性であって向きの属性ではない。**どちらの列に書くかだけを決める。**
//
// ★ **相手のいない ① は絶対に作らない。**①は rD がほぼ0なので、日常が①に入ると
//   全員が100に張り付いて変数として死ぬ。allocate の「t=0 なら S' から①を抜く」が
//   唯一の防波堤で、それが「①②⑤ の定常値が0」の理由になっている。

import * as S from '../core/stats.js';
import { NO_ONE } from './people.js';

// ---- 向き（正典3-5 の①〜⑥） ----------------------------------------------
export const D_PERSON = 0;   // ① 特定の人へ    私闘・復讐・暗殺・讒言。相手が死ねば解ける
export const D_GROUP  = 1;   // ② 身近な集団へ  孤立・出奔。誰も殺さない
export const D_RULE   = 2;   // ③ 統治へ        謀反・暴動・亡命・怠業。これが国を倒す
export const D_SELF   = 3;   // ④ 自分へ        自暴自棄・堕落・集団自殺
export const D_GOD    = 4;   // ⑤ 神・世界へ    棄教・狂信・諦観
export const D_OUT    = 5;   // ⑥ 外へ          排外・捕虜への虐待・帰化の拒否
export const DIR_COUNT = 6;
export const DIR_NAMES = ['特定の人へ', '身近な集団へ', '統治へ', '自分へ', '神・世界へ', '外へ'];
export const DIR_MARK = ['①', '②', '③', '④', '⑤', '⑥'];

export const V_MAX = 100;
export const GRUDGE1_SLOTS = 4;      // ① の相手つき枠。5人目は最も点の低い枠を②へ全額移す

// ---- 薄れ方（#4-(c) の確定表） --------------------------------------------
// 毎月：  不満[k] ← 不満[k] × (1 − rD_k × k_i)
//         k_i = 0.5 + 図太さ現在値/100          ← #5 の式に一本化（#2 の前借りの式は採らない）
//         a_i = clamp(1.0, 1.5, 1 + 0.5×(年齢−26)/44)   ← ④だけに掛かる（諦め）
export const RD = [0.0020, 0.0060, 0.0040, 0.0100, 0, 0];   // 不満
export const RG = [0.0005, 0.0040, 0.0020, 0.0020, 0, 0];   // 恨み
// ⑥ は率で薄れない。**戦争の無かった年の年末に −6点**（恨みは −3点）
export const OUT_YEAR_END_D = 6, OUT_YEAR_END_G = 3;

export const toughMul = (tough) => 0.5 + tough / 100;
export const resignMul = (ageYears) => {
  const a = 1 + 0.5 * (ageYears - 26) / 44;
  return a < 1.0 ? 1.0 : a > 1.5 ? 1.5 : a;
};

// ---- allocate の重み（第7部 §2 段2） --------------------------------------
export const W_PERSON_T = 70;        // w① = 70 × t
export const W_GROUP_BASE = 10, W_GROUP_HOME = 0.60;     // w② = 10 + 0.60×(100−郷土愛)
export const W_RULE_BASE = 20, W_RULE_ORDER = 0.70;      // w③ = 20 + 0.70×(100−序列意識)
export const W_GOD_BASE = 8,  W_GOD_FAITH = 0.50;        // w⑤ =  8 + 0.50×信心
export const W_OUT_BASE = 6,  W_OUT_PRIDE = 0.45;        // w⑥ =  6 + 0.45×誇り

// 段0（図太さの門）と 段1（他責の門）
export const GATE0_BASE = 0.60, GATE0_SPAN = 0.40;
export const SHARE4_MAX = 0.90, SHARE4_MIN = 0.05, SHARE4_LO = 0.05, SHARE4_HI = 0.90;

const ID = {
  図太さ: S.needId('図太さ'), 他責: S.needId('他責'), 郷土愛: S.needId('郷土愛'),
  序列意識: S.needId('序列意識'), 信心: S.needId('信心'), 誇り: S.needId('誇り'),
};
export { ID as STAT_ID };

// ---- S（許される向きの集合）。正典の表をそのまま写す ------------------------
// 欲の未充足（正典3-6b「欲の未充足が流れる先」）
export const DESIRE_S = [
  [D_PERSON, D_RULE],   // 傲慢 {①,③} 門○
  [D_RULE],             // 強欲 {③}   門○
  [D_PERSON],           // 嫉妬 {①}   門○（t=0 なら S' が空 → ④へ）
  [D_PERSON, D_OUT],    // 憤怒 {①,⑥} 門×（全額 外）
  [],                   // 色欲 —      門×（全額 ④）
  [D_RULE, D_GOD],      // 暴食 {③,⑤} 門○
  [D_RULE],             // 怠惰 {③}   門○
];
// 門を通すか。憤怒と色欲だけ通さない（正典3-5「憤怒は①⑥にしか流れず④には行かない」）
export const GATE_NONE = 0, GATE_ON = 1, GATE_ALL_OUT = 2, GATE_ALL_SELF = 3;
export const DESIRE_GATE = [GATE_ON, GATE_ON, GATE_ON, GATE_ALL_OUT, GATE_ALL_SELF, GATE_ON, GATE_ON];

// ---------------------------------------------------------------------------
/**
 * 配分（第7部 §2 の allocate）。
 * @param X    入力の点
 * @param set  許される向きの集合（D_* の配列）
 * @param t    特定度 0 / 0.5 / 1.0
 * @param gate GATE_ON（門を通す）／GATE_ALL_OUT（全額 外）／GATE_ALL_SELF（全額 ④）
 * @param out  長さ6の配列。ここに足し込む（呼ぶ側が使い回す）
 * @returns 実際に配った合計（＝X'。段0のあとの量）
 */
export function allocate(P, i, X, set, t, gate, out) {
  if (X <= 0) return 0;
  const e = (s) => P.effective(i, s);

  // ---- 段0 図太さの門（入口で削る） ----
  const Xp = X * (GATE0_BASE + GATE0_SPAN * (100 - e(ID.図太さ)) / 100);

  // ---- 段1 他責の門 ----
  let in4 = 0, outer = 0;
  if (gate === GATE_ALL_SELF) { in4 = Xp; outer = 0; }
  else if (gate === GATE_ALL_OUT) { in4 = 0; outer = Xp; }
  else {
    let share = SHARE4_MAX * (100 - e(ID.他責)) / 100;
    if (share < SHARE4_LO) share = SHARE4_LO; else if (share > SHARE4_HI) share = SHARE4_HI;
    in4 = Xp * share; outer = Xp - in4;
  }

  // ---- 段2 外向きを S の中で正規化 ----
  // ★ t = 0 なら ① を抜く。**相手のいない①は絶対に作らない**
  const S2 = t > 0 ? set : set.filter(k => k !== D_PERSON);
  if (!S2.length) {
    // 嫉妬（S={①}）で相手がいないときの受け皿。★ ③にしない
    in4 += outer; outer = 0;
  } else {
    const w = new Float64Array(DIR_COUNT);
    let W = 0;
    for (const k of S2) {
      let wk = 0;
      if (k === D_PERSON) wk = W_PERSON_T * t;
      else if (k === D_GROUP) wk = W_GROUP_BASE + W_GROUP_HOME * (100 - e(ID.郷土愛));
      else if (k === D_RULE) wk = W_RULE_BASE + W_RULE_ORDER * (100 - e(ID.序列意識));
      else if (k === D_GOD) wk = W_GOD_BASE + W_GOD_FAITH * e(ID.信心);
      else if (k === D_OUT) wk = W_OUT_BASE + W_OUT_PRIDE * e(ID.誇り);
      w[k] = wk; W += wk;
    }
    if (W > 0) for (const k of S2) out[k] += outer * w[k] / W;
    else in4 += outer;                       // 構造上は起きない（W の下限は 6）
  }
  out[D_SELF] += in4;
  return Xp;
}

// ---------------------------------------------------------------------------
// 器への書き込み
// ---------------------------------------------------------------------------
/** 不満へ足す（日常と t=0 の出来事）。0〜100 で頭打ち */
export function addDiscontent(P, i, dir, pt) {
  const A = P.a;
  let v = A.dis[dir][i] + pt;
  if (v > V_MAX) v = V_MAX; else if (v < 0) v = 0;
  A.dis[dir][i] = v;
}
/** 恨みへ足す（t ≥ 0.5 の出来事） */
export function addGrudge(P, i, dir, pt) {
  const A = P.a;
  let v = A.grudge[dir][i] + pt;
  if (v > V_MAX) v = V_MAX; else if (v < 0) v = 0;
  A.grudge[dir][i] = v;
}

/**
 * ① の相手つき枠へ入れる。4枠まで。
 * 5人目が来たら**最も点の低い枠を ② へ全額移して空ける**（正典 第7部 §2 の器）。
 */
export function addGrudge1(P, i, who, pt) {
  const A = P.a;
  let empty = -1, same = -1, weakest = 0;
  for (let k = 0; k < GRUDGE1_SLOTS; k++) {
    if (A.grudge1Pt[k][i] <= 0) { if (empty < 0) empty = k; continue; }
    if (A.grudge1Who[k][i] === who && same < 0) same = k;
    if (A.grudge1Pt[k][i] < A.grudge1Pt[weakest][i]) weakest = k;
  }
  if (same >= 0) { A.grudge1Pt[same][i] = Math.min(V_MAX, A.grudge1Pt[same][i] + pt); return same; }
  if (empty >= 0) { A.grudge1Who[empty][i] = who; A.grudge1Pt[empty][i] = Math.min(V_MAX, pt); return empty; }
  // 5人目。いちばん低い枠を ② へ全額移して空ける
  addDiscontent(P, i, D_GROUP, A.grudge1Pt[weakest][i]);
  A.grudge1Who[weakest][i] = who; A.grudge1Pt[weakest][i] = Math.min(V_MAX, pt);
  return weakest;
}

/** V① ＝ 枠の最大（複数の相手を足し合わせない） */
export function value1(P, i) {
  const A = P.a;
  let m = 0;
  for (let k = 0; k < GRUDGE1_SLOTS; k++) if (A.grudge1Pt[k][i] > m) m = A.grudge1Pt[k][i];
  return m;
}

/** 相手が死んだ枠を空ける（正典3-5「相手が死ねば全部」） */
export function clearDeadTargets(P, i) {
  const A = P.a;
  let cleared = 0;
  for (let k = 0; k < GRUDGE1_SLOTS; k++) {
    const w = A.grudge1Pt[k][i] > 0 ? A.grudge1Who[k][i] : -1;
    if (w < 0 || w >= A.len) continue;
    if (!A.alive[w]) { A.grudge1Pt[k][i] = 0; A.grudge1Who[k][i] = 0; cleared++; }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
/**
 * 月次の薄れ。生存者・12歳以上だけ。
 * ★ ⑤は率で薄れない（溜め池。意図的）。⑥は年末にだけ落ちる。
 */
export function decayMonth(P, i) {
  const A = P.a;
  // ★ 正典 #4-(c) と #5 が2箇所とも「図太さ**現在値**」と書いている（実効値ではない）。
  //   こころは努力値が積まれないので、現在値 ＝ 才能 ＋ drift。
  //   drift はまだ器が無いので、いまは才能そのもの
  const k = toughMul(A.gene[ID.図太さ][i] + A.ev[ID.図太さ][i]);
  const a = resignMul((A.ageMonths[i] / 12) | 0);
  for (let d = 0; d < DIR_COUNT; d++) {
    if (d === D_GOD || d === D_OUT) continue;         // ⑤は薄れない／⑥は年末だけ
    const mulD = d === D_SELF ? RD[d] * a : RD[d];
    const mulG = d === D_SELF ? RG[d] * a : RG[d];
    A.dis[d][i] *= (1 - mulD * k);
    A.grudge[d][i] *= (1 - mulG * k);
  }
  // ① の枠も同じ率で薄れる（不満側の率を使う。相手が死ねば別途0になる）
  for (let s = 0; s < GRUDGE1_SLOTS; s++) {
    if (A.grudge1Pt[s][i] > 0) A.grudge1Pt[s][i] *= (1 - RG[D_PERSON] * k);
  }
}

/** 年末。戦争の無かった年だけ ⑥ を落とす */
export function yearEndPeace(P, i) {
  const A = P.a;
  A.dis[D_OUT][i] = Math.max(0, A.dis[D_OUT][i] - OUT_YEAR_END_D);
  A.grudge[D_OUT][i] = Math.max(0, A.grudge[D_OUT][i] - OUT_YEAR_END_G);
}

/** 用途ごとに読む値。★ 6本に割った以上、1つの数に畳み直さない（正典3-5） */
export function value(P, i, dir) {
  if (dir === D_PERSON) return Math.min(V_MAX, value1(P, i) + P.a.grudge[D_PERSON][i]);
  return Math.min(V_MAX, P.a.dis[dir][i] + P.a.grudge[dir][i]);
}

// ---------------------------------------------------------------------------
// #5　④自分へ の生成側の上限と、行動による減少
// ---------------------------------------------------------------------------
//
// ★ 月次上限が **④の張り付きを止める本体**（#5 §3）。
//   日常（欲の未充足）由来で 不満④ に入る量は 1ヶ月 0.80点 が上限。
//   **超えた分は捨てる。他の向きへは回さない**（他責の門はもう通過済みなので行き先が無い）。
//   出来事由来の 不満④・恨み④ はこの上限の外。
//
//   平衡 = min(0.80, 月次流入) ÷ rD④
//     平凡な独身・無役（流入0.08）… 図太さ48 で **8.2**
//     上限に張り付いた最悪の個体   … 図太さ48 で **81.6**／図太さ66 で 69.0
//   ★ 上限に張り付くには「他責がほぼ0」かつ「図太さが低い」が同時に要るが、
//     他責（11番B）と図太さ（11番A）は**同じ11番染色体の対抗腕**なので腕予算で両立しない。
//     だから種火は人口の1%前後にしか立たない。
export const SELF_DAILY_CAP = 0.80;

// 恨み④ の天井。不満④ が0でも恨みだけで発火することを構造的に禁じる（#5 §5）
export const GRUDGE4_CAP = 40;

// 行動による減少（#5 §4）。不満④から引き、0未満にしない
export const SELF_RELIEF = {
  役職: 25,      // −25 × Δ（役職の段）
  叙爵: 10,      // −10 × Δ（爵位の段）
  結婚: 15,      // 再婚も含め一生に何度でも
  子が1歳: 15,   // 1人につき1回。双子は出来事1件なので −15
  家督: 12,
  初就労: 10,    // 一生に1度
  戦功: 8,
  長寿: 5,       // 60歳の誕生月から毎年
};
export const RELIEF_OLD_AGE = 60;

// 一生に1度のもののビット（disOnce）
export const ONCE_FIRST_JOB = 1 << 0;

/** 不満④を減らす。0未満にはしない */
export function relieveSelf(P, i, pt) {
  const A = P.a;
  const v = A.dis[D_SELF][i] - pt;
  A.dis[D_SELF][i] = v < 0 ? 0 : v;
}

/** 恨み④ を積む。天井40 */
export function addGrudge4(P, i, pt) {
  const A = P.a;
  const v = A.grudge[D_SELF][i] + pt;
  A.grudge[D_SELF][i] = v > GRUDGE4_CAP ? GRUDGE4_CAP : v;
}
