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

// 1ヶ月に積まれる努力値の基本量。伸びしろ1.0・年齢減衰1.0・才能ボーナス0.85 のとき
// 1年で 2.0 × 0.85 ＝ 1.7 積まれる。年齢減衰を通した一生ぶんの積算は
// おおよそ 22年ぶん（下の evDecay の積分）なので、主力のステで +35〜40 に落ち着く。
// 才能の散らばりが標準偏差15前後なので、「20年の稽古が素質2つ分を覆す」重さになる。
export const EV_PER_YEAR = 2.0;
export const EV_PER_MONTH = EV_PER_YEAR / C.MONTHS_PER_YEAR;

// 年齢減衰。若いほど積まれる。下げ止まりは0.25（確定事項に明記）
export const EV_DECAY_FLOOR = 0.25;
export const EV_DECAY_START = 7;    // いちばん早く働き始める歳（A-21b の貧民）
export const EV_DECAY_TAU = 22;     // 何年で 1/e に落ちるか。30歳あたりで0.35になる

// 才能ボーナス。**確定事項に明記（0.80〜0.90）**
export const TALENT_BONUS_MIN = 0.80;   // 才能0
export const TALENT_BONUS_MAX = 0.90;   // 才能100

// 仕事に直接関わらないステも、暮らしの中で少しは伸びる
export const IDLE_SHARE = 0.10;

/** 年齢減衰。7歳で1.0、30歳で0.35、37.5歳から下げ止まりの0.25 */
export function evDecay(ageYears) {
  if (ageYears < EV_DECAY_START) return 0;
  const d = Math.exp(-(ageYears - EV_DECAY_START) / EV_DECAY_TAU);
  return d < EV_DECAY_FLOOR ? EV_DECAY_FLOOR : d;
}

/** 才能による習得ボーナス。0.80〜0.90（ほぼ効かない） */
export function talentBonus(talent) {
  const t = talent < 0 ? 0 : talent > 100 ? 100 : talent;
  return TALENT_BONUS_MIN + (TALENT_BONUS_MAX - TALENT_BONUS_MIN) * (t / 100);
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
  return EV_PER_MONTH * weight * room * dec
       * talentBonus(talent)
       * S.placeMultiplier(s, where)
       * growthMul(P, i, s);          // 授かりもの（天賦・剛健・明晰）A-23
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
    talentBonus: talentBonus(talent),
    place: S.placeMultiplier(s, where),
    perMonth: evGain(P, i, s, 1, where),
  };
}
