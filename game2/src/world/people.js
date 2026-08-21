// 個体。列ごとの型付き配列（SoA）ひとつに、生きている者も死んだ者も全部入っている。
//
// 確定事項より：
//   A-2  列ごとの型付き配列。オブジェクトの配列にしない
//   A-3  先天と後天は別の種類ではない。同じ「腕っぷし」という1つの量
//   A-4  実効値 ＝（才能 ＋ 努力値）× 老い × 古傷 × 状態異常
//        才能0〜100・一生変わらない／努力値は上限なし
//   A-4  デバフは既存のステを直接下げない。倍率を掛ける（素の値が汚れない）
//   A-6  ピークは26歳固定。寿命40〜70・平均55。老衰のみ
//   B-2  デバフ倍率の下限は0.25
//   A-20 性別はステータスではなく属性。別管理。完全ランダムで1/2
//
// 掟：添字は詰めない。死んだら alive[i]=0 にするだけ。
//     詰めるとしがらみ（辺のリスト）の from/to が全部ずれる。

import * as S from '../core/stats.js';
import * as C from '../core/calendar.js';
import { make } from '../core/arrays.js';
import { LOOK_SPEC, FOUNDER_COUNT } from './looks.js';

// ---- 属性の番号 -----------------------------------------------------------
export const SEX_MALE = 0, SEX_FEMALE = 1;
export const SEX_NAMES = ['男', '女'];

// A-21b の4段（富の段は未決だが、この4段で置いている）
export const RANK_POOR = 0, RANK_COMMON = 1, RANK_RICH = 2, RANK_NOBLE = 3;
export const RANK_NAMES = ['貧民', '平民', '富裕', '貴族'];

// 就き始める年齢（A-21b）。貧民は7歳で働き始めるが、教える者がいない
export const WORK_START_AGE = [7, 10, 10, 7];

// 未所属を表す値。Uint32/Uint16 なので -1 が置けない
export const NO_HOUSE = 0xFFFFFFFF;
export const NO_VILLAGE = 0xFFFF;
export const NO_ONE = -1;

// 状態異常（A-3 の「状態」。1ヶ月単位で計算する）。u32 のビット
export const ST_PREGNANT = 1 << 0;   // 妊娠。10ヶ月
export const ST_HUNGRY   = 1 << 1;   // 飢え
export const ST_SICK     = 1 << 2;   // 病
export const ST_GRIEF    = 1 << 3;   // 喪
export const ST_NURSING  = 1 << 4;   // 産後。次の子までの間
export const STATE_NAMES = [
  [ST_PREGNANT, '妊娠'], [ST_HUNGRY, '飢え'], [ST_SICK, '病'],
  [ST_GRIEF, '喪'], [ST_NURSING, '産後'],
];

// 死因
export const DEATH_NONE = 0, DEATH_AGE = 1, DEATH_ILL = 2,
             DEATH_HUNGER = 3, DEATH_WAR = 4, DEATH_BIRTH = 5;
export const DEATH_NAMES = ['—', '老衰', '病・事故', '飢え', '戦死', 'お産'];

// ---- 死亡率（中世並・年あたり） -------------------------------------------
// 確定事項の表そのまま。老衰（寿命）はこれとは別に効く。
export const MORTALITY = [
  { from: 0,  to: 0,   rate: 0.20  },
  { from: 1,  to: 4,   rate: 0.06  },
  { from: 5,  to: 14,  rate: 0.012 },
  { from: 15, to: 39,  rate: 0.010 },
  { from: 40, to: 54,  rate: 0.020 },
  { from: 55, to: 999, rate: 0.050 },
];

/** その歳の年あたり死亡率 */
export function annualDeathRate(ageYears) {
  for (const m of MORTALITY) if (ageYears >= m.from && ageYears <= m.to) return m.rate;
  return 0.05;
}
/** 月あたりに直す。年率 p を12回に分けて同じになるように */
export function monthlyDeathRate(ageYears) {
  return 1 - Math.pow(1 - annualDeathRate(ageYears), 1 / 12);
}

// ---- 年齢曲線（A-6 の表そのものから出した） -------------------------------
//
// ピークは26歳固定。そこから「寿命までの残りをどれだけ使ったか」だけで落ちる。
//   t = (歳 - 26) / (寿命 - 26)      … 峠を越えてからの進み具合（0〜1）
//   老い = 1 - 0.85 × t^1.4
//
// 確定事項 A-6 の7点すべてに合う（仮の数値ではない。表から逆算したもの）：
//   寿命40・35歳 t=.643 → 54%   寿命55・35歳 t=.310 → 83%   寿命70・35歳 t=.205 → 91%
//   寿命55・45歳 t=.655 → 53%   寿命70・45歳 t=.432 → 74%
//   寿命55・55歳 t=1.00 → 15%   寿命70・55歳 t=.659 → 53%
export const PEAK_AGE = 26;
export const AGE_FALL = 0.85;   // 寿命に達したとき何割落ちるか
export const AGE_POW = 1.4;     // 落ち方の曲がり

// 26歳までの立ち上がり。**仮の数値**（確定事項に無い）。
// 子どもは literal に弱い、というだけの話なので からだ にしか掛けない（A-4：恒久デバフはからだのみ）。
// あたま・こころ は生まれた時から才能そのもの。だから
// 「論理90で生まれた貧民の子」は本当に90を持っていて、誰も気づかない（A-21b）。
export const RISE_POW = 0.6;

/** 年齢による からだ の倍率。0〜1 */
export function ageCurve(ageYears, lifespan) {
  if (ageYears < PEAK_AGE) {
    const r = ageYears / PEAK_AGE;
    return r <= 0 ? 0.02 : Math.pow(r, RISE_POW);
  }
  const span = Math.max(1, lifespan - PEAK_AGE);
  let t = (ageYears - PEAK_AGE) / span;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return 1 - AGE_FALL * Math.pow(t, AGE_POW);
}

// ---- デバフ ---------------------------------------------------------------
export const DEBUFF_FLOOR = 0.25;    // B-2
export const HUNGRY_MUL = 0.85;
export const SICK_MUL = 0.70;
export const PREGNANT_BODY_MUL = 0.75;
// 遺伝的荷重が死亡率をどれだけ押し上げるか。生存力0.8で死亡率1.12倍
export const LOAD_MORTALITY = 0.6;

// ---- 個体の束 -------------------------------------------------------------

// 1人ぶんの列。gene と ev は 104 本ずつ、対立遺伝子は2組。
export const SPEC = {
  // 才能（0〜100・一生変わらない）と努力値（上限なし）
  gene: `f32*${S.COUNT}`,
  ev:   `f32*${S.COUNT}`,

  // 対立遺伝子2本。u16 に ALLELE_Q 倍で入れている（0〜100 を 1/600 刻みで）
  a0: `u16*${S.COUNT}`,
  a1: `u16*${S.COUNT}`,
  // 優劣（こころ29個ぶん）のビット。0=劣性 1=顕性
  dom0: 'u32', dom1: 'u32',
  // 遺伝的荷重（こころの劣性が隠して運ぶ欠陥）。0〜255 で 0〜1
  ld0: 'u8*29', ld1: 'u8*29',
  // 可塑（交叉率を決めるメタ遺伝子。ステータスではないので104に入っていない）
  pl0: 'f32', pl1: 'f32', plast: 'f32',

  ageMonths: 'u16',      // 月齢。70年=840ヶ月なので u16 で足りる
  sex: 'u8',
  house: 'u32',
  village: 'u16',
  rank: 'u8',
  post: 'u8',
  job: 'u8',             // どのエリアで働いているか（village.js の AREA）
  wealth: 'f32',
  state: 'u32',
  alive: 'u8',
  lifespan: 'u8',        // 40〜70。寿命ステから決まる

  vitality: 'f32',       // 遺伝的荷重から出る生存力（産む・生きる・老いる に掛かる）
  scar: 'f32',           // 古傷。恒久デバフ（からだのみ）。0〜0.75

  birthTick: 'i32',
  deathTick: 'i32',
  deathCause: 'u8',
  mother: 'i32', father: 'i32', spouse: 'i32',

  pregDue: 'i32',        // 産む tick。妊娠していなければ -1
  pregFather: 'i32',
  pregCount: 'u8',       // 何人みごもっているか（双子・三つ子）
  lastBirth: 'i32',
  births: 'u8',          // これまでに産んだ数

  hungerMonths: 'u8',
  gen: 'u16',            // 何代目か（家族の単位。A-12）
  blood: 'u16',          // 創世の十匹のうち誰の血が入っているか。10ビットの旗。
                         // 子は 父の旗 | 母の旗。収束計「血統の生き残り数」がこれを数える

  // 見た目（キャラビジュアル.md §2/§3）。**ステではない。**何にも効かない血統の指紋。
  // blood（旗）は「誰の血が入ったか」の有無しか言えないので、割合は別に持つ。
  ...LOOK_SPEC,
};

export const HEART0 = S.BY_CATEGORY[S.HEART][0];        // 75
export const HEART_COUNT = S.BY_CATEGORY[S.HEART].length; // 29
export const ALLELE_Q = 600;                             // u16 に詰める倍率

export class People {
  constructor(cap = 256) {
    this.a = make(cap, SPEC);
    this.count = 0;      // 生きている数
    this.born = 0;       // これまでに生まれた総数
    this.dead = 0;
  }

  get len() { return this.a.len; }

  // 列に直接触れるための入口（sim の内側は列を直に読むこと）
  get gene() { return this.a.gene; }
  get ev() { return this.a.ev; }
  get alive() { return this.a.alive; }
  get sex() { return this.a.sex; }
  get ageMonths() { return this.a.ageMonths; }
  get house() { return this.a.house; }
  get village() { return this.a.village; }
  get rank() { return this.a.rank; }
  get post() { return this.a.post; }
  get job() { return this.a.job; }
  get state() { return this.a.state; }
  get wealth() { return this.a.wealth; }
  get lifespan() { return this.a.lifespan; }
  get spouse() { return this.a.spouse; }
  get mother() { return this.a.mother; }
  get father() { return this.a.father; }
  get blood() { return this.a.blood; }

  /** 席を1つ取って、生きた個体として立てる。中身（遺伝子）はまだ空 */
  spawn(tick) {
    const i = this.a.alloc();
    this.a.clear(i);
    const A = this.a;
    A.alive[i] = 1;
    A.house[i] = NO_HOUSE;
    A.village[i] = NO_VILLAGE;
    A.mother[i] = NO_ONE; A.father[i] = NO_ONE; A.spouse[i] = NO_ONE;
    A.pregDue[i] = -1; A.pregFather[i] = NO_ONE; A.lastBirth[i] = -1;
    A.birthTick[i] = tick; A.deathTick[i] = -1;
    A.rank[i] = RANK_COMMON;
    A.vitality[i] = 1;
    A.lifespan[i] = 55;
    A.blood[i] = 0;
    for (let f = 0; f < FOUNDER_COUNT; f++) A.bloodMix[f][i] = 0;
    this.count++; this.born++;
    return i;
  }

  kill(i, tick, cause = DEATH_ILL) {
    if (!this.a.alive[i]) return false;
    const A = this.a;
    A.alive[i] = 0;
    A.deathTick[i] = tick;
    A.deathCause[i] = cause;
    A.state[i] = 0;
    A.pregDue[i] = -1;
    this.count--; this.dead++;
    return true;
  }

  // ---- 見るだけのもの ----------------------------------------------------
  ageYears(i) { return (this.a.ageMonths[i] / C.MONTHS_PER_YEAR) | 0; }
  isAlive(i) { return this.a.alive[i] === 1; }
  isAdult(i) { return this.a.ageMonths[i] >= 18 * C.MONTHS_PER_YEAR; }
  isWorking(i) { return this.ageYears(i) >= WORK_START_AGE[this.a.rank[i]]; }
  has(i, bit) { return (this.a.state[i] & bit) !== 0; }
  set(i, bit) { this.a.state[i] |= bit; }
  unset(i, bit) { this.a.state[i] &= ~bit; }

  /** 才能。生まれつき。一生変わらない */
  talent(i, s) { return this.a.gene[s][i]; }

  /**
   * デバフの倍率（A-4）。既存のステを直接下げず、これを掛ける。
   * 老い と 古傷 は からだ のみ（A-4 に明記）。
   */
  debuff(i, s) {
    const A = this.a;
    let d = 1;
    const body = S.CATEGORY[s] === S.BODY;
    if (body) {
      d *= ageCurve(this.ageYears(i), A.lifespan[i]);
      const sc = A.scar[i];
      if (sc > 0) d *= (1 - sc);
    }
    const st = A.state[i];
    if (st & ST_HUNGRY) d *= HUNGRY_MUL;
    if (st & ST_SICK) d *= SICK_MUL;
    if (body && (st & ST_PREGNANT)) d *= PREGNANT_BODY_MUL;
    return d < DEBUFF_FLOOR ? DEBUFF_FLOOR : d;
  }

  /** 実効値 ＝（才能 ＋ 努力値）× デバフ（A-4） */
  effective(i, s) {
    return (this.a.gene[s][i] + this.a.ev[s][i]) * this.debuff(i, s);
  }

  /** 何本かのステの実効値の重み付き平均。仕事の出来を出すときに使う */
  effectiveOf(i, list) {
    let sum = 0, w = 0;
    for (let k = 0; k < list.length; k++) {
      const s = list[k][0], ww = list[k][1];
      sum += this.effective(i, s) * ww; w += ww;
    }
    return w > 0 ? sum / w : 0;
  }

  // ---- 数える ------------------------------------------------------------
  aliveCount() { return this.count; }
  *living() { const A = this.a; for (let i = 0; i < A.len; i++) if (A.alive[i]) yield i; }

  bytesPerRow() { return this.a.bytesPerRow(); }
  bytes() { return this.a.bytes(); }
}

// ---- 寿命 -----------------------------------------------------------------
// 寿命はステの1つ（45番）なので、乱数ではなく遺伝から出す。
// 才能50（集団の中央）で55年になり、0で40年、100で70年。確定事項の「40〜70・平均55」と合う。
// 老いの速さ（46番・寿命の対）と 遺伝的荷重 で削る。
export const LIFESPAN_MIN = 40, LIFESPAN_MAX = 70;
const ID_LIFESPAN = S.needId('寿命');
const ID_AGING = S.needId('老いの速さ');

/**
 * 素の寿命。遺伝だけで決まる。**40〜70・平均55**（確定事項 A-6 そのまま）。
 * 才能50（集団の中央）で55年、0で40年、100で70年。老いの速さ（寿命の対）で ±5年。
 */
export function baseLifespanOf(P, i) {
  const A = P.a;
  const base = LIFESPAN_MIN + (LIFESPAN_MAX - LIFESPAN_MIN) * (A.gene[ID_LIFESPAN][i] / 100);
  const fast = (A.gene[ID_AGING][i] - 50) / 50 * 5;   // 老いの速さが高いほど短い
  const v = Math.round(base - fast);
  return v < LIFESPAN_MIN ? LIFESPAN_MIN : v > LIFESPAN_MAX ? LIFESPAN_MAX : v;
}

/**
 * 実際の寿命。素の寿命に、遺伝的荷重（＝閉じた血統に溜まる欠陥）が乗る。
 * 荷重が無ければ素のまま。近親が続いた家系は短くなる。
 */
export function lifespanOf(P, i) {
  const base = baseLifespanOf(P, i);
  const v = Math.round(base * (0.75 + 0.25 * P.a.vitality[i]));
  return v < 20 ? 20 : v > 255 ? 255 : v;
}

// ---- 1ヶ月ぶんの加齢と死 ---------------------------------------------------
/**
 * 歳を取り、死ぬ。月に1度だけ呼ぶ。
 * @returns {{aged:number, died:number, byCause:number[]}}
 */
export function agingAndDeath(P, tick, rng) {
  const A = P.a;
  const byCause = [0, 0, 0, 0, 0, 0];
  let aged = 0, died = 0;

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    A.ageMonths[i]++;
    aged++;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;

    // 老衰。寿命に届いた者から順に落ちる（ぴったり同じ日には死なせない）
    if (y >= A.lifespan[i]) {
      // 超えた年数ぶんだけ月ごとの確率が上がる。寿命+5年で必ず死ぬ
      const over = y - A.lifespan[i];
      const p = 1 - Math.pow(1 - Math.min(1, 0.20 + over * 0.15), 1 / 12);
      if (rng.next() < p) {
        P.kill(i, tick, DEATH_AGE); died++; byCause[DEATH_AGE]++;
        continue;
      }
    }

    // 中世並の死亡率（確定事項の表）。ここが素の値。
    // 生存力（遺伝的荷重）はその上に乗る。閉じた血統は劣性ホモが溜まって死にやすくなる
    // （genetics.js の geneticLoad を参照）。表そのものを壊さないよう効きは 0.6 に抑えてある
    let p = monthlyDeathRate(y);
    const vit = A.vitality[i];
    if (vit < 1) p *= 1 + (1 - vit) * LOAD_MORTALITY;
    if (A.state[i] & ST_SICK) p *= 2.5;
    if (rng.next() < p) {
      P.kill(i, tick, DEATH_ILL); died++; byCause[DEATH_ILL]++;
      continue;
    }

    // 飢え。3ヶ月続けて食べられなかったら落ち始める
    if (A.state[i] & ST_HUNGRY) {
      if (A.hungerMonths[i] < 255) A.hungerMonths[i]++;
      if (A.hungerMonths[i] >= 3) {
        const q = 0.10 + 0.08 * (A.hungerMonths[i] - 3);
        if (rng.next() < Math.min(0.6, q)) {
          P.kill(i, tick, DEATH_HUNGER); died++; byCause[DEATH_HUNGER]++;
          continue;
        }
      }
    } else if (A.hungerMonths[i] > 0) {
      A.hungerMonths[i]--;
    }
  }
  return { aged, died, byCause };
}
