// 成長。**努力値だけを扱う。** 才能は生まれつきで一生変わらない（A-4）。
//
// 確定事項より：
//   A-4  実効値 ＝（才能 ＋ 努力値）× デバフ
//        努力値は上限なし。年齢減衰で自然に飽和する
//        才能 < 閾値 なら、何年やっても積まれない
//        **上限を才能に紐づけない。**「上限＝(才能−閾値)×係数」は掛け算の復活だった。
//        閾値は入口だけを守る
//   A-5  レア度は閾値ひとつで表せる（0=100% 15=87.5% 50=14.8% 80=0.71% 95=0.10%）
//   A-9  閾値「非常に高い」8個＝生まれつき持たない者は一生伸びない
//   A-21 どこに住んでいるかで伸び率が変わる。**枠ごとに向きが逆**
//        全部が都会有利だと辺境に置く理由が消えて選択がなくなる
//   A-21b 貧富は伸び率の係数ではない。**働き始める年齢に効く**
//        貧民7歳／平民10歳／貴族7歳。早く積み始めるが教育は受けられない
//   A-6  年齢減衰で努力値がほとんど積まれないので、長生きしても素の力は増えない
//
// 「才能ボーナスは 0.80〜0.90（ほぼ効かない）」は、A-4 の加算への言い換え。
// 才能100の者が才能0の者の1.125倍しか速く覚えない。20年の稽古が素質を覆せる。
//
// 年齢の曲線は2つあって別物：
//   ・老い（people.js の ageCurve）… 実効値に掛かるデバフ。ピーク26歳（A-6）
//   ・年齢減衰（この下の evDecay）… 努力値が積まれる速さ。7歳が最速

import * as S from '../core/stats.js';
import { growthMul } from './gifts.js';
import * as C from '../core/calendar.js';
import { NO_VILLAGE, WORK_START_AGE } from './people.js';
import { AREA_STATS, AREA_HOME, WHERE_CENTER } from './village.js';

// ===========================================================================
// 仮の数値。**確定事項に数が無いもの。ここだけ直せば全部変わる。**
// （stats.js の GROWTH_ROOM / PLACE_MULTIPLIER と合わせて読むこと）
// ===========================================================================

// ★★ 2026-08-28：正典の式に合わせた（O-34 のオーナー原文）★★
//   **1年に積まれる努力値 ＝ 才能 × 年齢減衰 × 伸びしろ × 場所**
//   ★ **才能が基準そのもの。**才能10なら1年で基準10。
//   ★ 旧実装は `2.0 × 才能ボーナス0.85` を基準に置いて才能を倍率にしていたので
//     **50倍縮んでいた**（正典は 2026-08-26 に訂正済みだったが、コードに入っていなかった）
//   7→70歳の積分 ＝ **実効 28.3年ぶん** → 才能50 で +1,413（実効値 1,463）
export const EV_PER_MONTH_PER_TALENT = 1 / C.MONTHS_PER_YEAR;

// 年齢減衰 ＝ max(0.25, exp(−(歳 − 7) / 31))
//   7歳 1.00 ／ 20歳 0.66 ／ 25歳 0.56 ／ 30歳 0.48 ／ 40歳 0.34 ／ **50歳 0.25 で下げ止まり**
export const EV_DECAY_FLOOR = 0.25;
export const EV_DECAY_START = 7;    // いちばん早く働き始める歳（A-21b の貧民）
export const EV_DECAY_TAU = 31;     // ★ 旧22。50歳ちょうどで floor に着く値

// 仕事に直接関わらないステも、暮らしの中で少しは伸びる
export const IDLE_SHARE = 0.10;

/** 年齢減衰。7歳で1.0、30歳で0.48、**50歳**から下げ止まりの0.25 */
export function evDecay(ageYears) {
  if (ageYears < EV_DECAY_START) return 0;
  const d = Math.exp(-(ageYears - EV_DECAY_START) / EV_DECAY_TAU);
  return d < EV_DECAY_FLOOR ? EV_DECAY_FLOOR : d;
}

/**
 * このステに、この才能の者は努力値を積めるか（A-4 の閾値）。
 * こころ29個は閾値が「該当なし」なので、普通の努力では一生積まれない。
 */
export function canTrain(s, talent) { return S.canTrain(s, talent); }

/**
 * 1ヶ月ぶんの努力値。仕事に就いている者だけが積む。
 * @param where 0=中央 1=辺境（A-21）
 */
export function evGain(P, i, s, weight, where) {
  const A = P.a;
  const talent = A.gene[s][i];
  if (!S.canTrain(s, talent)) return 0;             // 閾値。入口で弾く
  const room = S.growthRoomOf(s);
  if (room <= 0) return 0;
  const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
  const dec = evDecay(y);
  if (dec <= 0) return 0;
  // ★ 才能が基準そのもの（正典 O-34）
  return EV_PER_MONTH_PER_TALENT * talent * weight * room * dec
       * S.placeMultiplier(s, where)
       * growthMul(P, i, s);          // 授かりもの（天賦・剛健・明晰）A-23
}

/**
 * ★ 2026-08-28：**7歳からその歳までに積まれたはずの努力値**を、まとめて積む。
 *   創世の十匹（18〜26歳）は ev=0 で生まれるが、努力値が主役になった新しい目盛りでは
 *   それは「才能だけの子供」と同じ産出しか出さない（実測 実効値43・産出0.28/月。
 *   旧目盛りの 3.6/月 の1/13）。**創世の大人が飢えて、子が育つ前に国が滅びる。**
 *   年齢減衰の積分をそのまま使うので、新しい定数は1つも要らない。
 * @param job どの仕事に就いていたことにするか（AREA_* の番号）
 */
export function seedEffortForAge(P, i, job) {
  const A = P.a;
  const y = A.ageMonths[i] / C.MONTHS_PER_YEAR;
  if (y <= EV_DECAY_START) return 0;
  // 7歳→いまの歳 の積分（年齢減衰の実効年数）
  let years = 0;
  for (let a = EV_DECAY_START; a < y; a += 0.05) years += evDecay(a) * 0.05;
  const list = AREA_STATS[job] || AREA_STATS[AREA_HOME];
  let total = 0;
  for (const [s, w] of list) {
    const talent = A.gene[s][i];
    if (!S.canTrain(s, talent)) continue;
    const room = S.growthRoomOf(s);
    if (room <= 0) continue;
    const g = talent * years * w * room;
    A.ev[s][i] += g; total += g;
  }
  return total;
}

/**
 * 村じゅうの1ヶ月ぶんの成長。月に1度だけ呼ぶ。
 * @returns {{grew:number, gained:number}}
 */
export function growMonth(P, V, tick) {
  const A = P.a;
  const nv = V.len;
  let grew = 0, gained = 0;

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
    if (y < WORK_START_AGE[A.rank[i]]) continue;    // まだ働いていない
    const v = A.village[i];
    const where = (v !== NO_VILLAGE && v < nv) ? V.a.where[v] : WHERE_CENTER;
    const list = AREA_STATS[A.job[i]] || AREA_STATS[AREA_HOME];
    let any = 0;
    for (let k = 0; k < list.length; k++) {
      const s = list[k][0], w = list[k][1];
      const g = evGain(P, i, s, w, where);
      if (g > 0) { A.ev[s][i] += g; gained += g; any = 1; }
    }
    grew += any;
  }
  return { grew, gained };
}

/**
 * ある個体の、あるステの伸びしろの内訳。UI とデバッグ用。
 * 「なぜ伸びないのか」を数で見せられるようにしておく（A-7：オーナーは全部見える）
 */
export function explain(P, i, s, where = WHERE_CENTER) {
  const talent = P.a.gene[s][i];
  const y = (P.a.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
  const th = S.thresholdOf(s);
  return {
    stat: S.NAME[s],
    talent,
    ev: P.a.ev[s][i],
    threshold: th,
    passesThreshold: S.canTrain(s, talent),
    reason: th === S.THRESHOLD_NONE ? 'こころは普通の努力では積まれない'
          : talent < th ? `才能${talent.toFixed(1)} が閾値${th}に届いていない`
          : null,
    room: S.growthRoomOf(s),
    decay: evDecay(y),
    place: S.placeMultiplier(s, where),
    perMonth: evGain(P, i, s, 1, where),
  };
}
