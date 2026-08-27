// 結婚と出産。
//
// 確定事項より：
//   A-12  結婚は出会う範囲の中でランダム。原則1対1
//   A-12  妊娠は10ヶ月。状態異常「妊娠」を母に付与する
//   A-12  双子5%／三つ子0.1%／四つ子以上なし
//   A-12  出産は18〜40歳のあいだ
//   A-19  家と家の距離が、出会う範囲そのもの
//         → P1 は村がひとつなので「同じ村の中でランダム」がそのまま出会う範囲
//   A-19b 村の上限は30軒。埋まっていると新しい家が建たない
//         （溢れたら開拓か移住。それは村長が決める＝flow の仕事なので、ここは数えるだけ）
//   B-11  出生率は1組6人。中世並の死亡率をそのまま使う
//   B-12  食料の天井で人口を自己調整させる（マルサス）

import * as S from '../core/stats.js';
import { breedLook } from './looks.js';
import * as C from '../core/calendar.js';
import {
  SEX_MALE, SEX_FEMALE, NO_HOUSE, NO_VILLAGE, NO_ONE,
  ST_PREGNANT, ST_NURSING, ST_HUNGRY, ST_BARREN, DEATH_BIRTH, lifespanOf,
} from './people.js';
import { breed } from './genetics.js';
import { rollDefect, afterHardBirth } from './condition.js';
import { deathless } from './gifts.js';

// ---- 確定している数 -------------------------------------------------------
export const MARRY_MIN_AGE = 18;
export const BIRTH_MIN_AGE = 18, BIRTH_MAX_AGE = 40;   // A-12
export const PREGNANCY_DAYS = 10 * C.DAYS_PER_MONTH;   // 妊娠10ヶ月＝300日
export const TWIN_P = 0.05;                            // A-12
export const TRIPLET_P = 0.001;                        // A-12

// ---- 仮の数値 -------------------------------------------------------------
// 1ヶ月あたり縁がまとまる確率。18歳になった年に全員がいっせいに結婚しないための散らし
export const MARRY_CHANCE = 0.16;
export const MARRY_MAX_AGE_WOMAN = 45;
// 1ヶ月あたり身ごもる確率。産む間隔（10ヶ月＋産後6ヶ月）と合わせて
// 18〜40歳のあいだに1組6人（B-11）になるよう合わせ込んだ。
// 実測（40通り・200年・1,835人の産み終えた女）で 1組6.01人。
// このとき 120年後の絶滅率が 7.5%・平均人口 54.4 になり、
// 確定事項 A-10 の実測（絶滅率10%・120年後56人）とも同時に合う
export const CONCEIVE_CHANCE = 0.09;
export const NURSING_MONTHS = 6;                       // 産後、次の子までの間
export const BIRTH_DEATH_P = 0.015;                    // お産で母が死ぬ確率の素

const ID_FERTILITY = S.needId('繁殖力');
const ID_TWINS = S.needId('双子の生まれやすさ');
const ID_EASY_BIRTH = S.needId('お産の軽さ');

const ageY = (P, i) => (P.a.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;

/** 近すぎる血か。親子・きょうだい・半きょうだいを弾く */
export function tooClose(P, a, b) {
  const A = P.a;
  if (a === b) return true;
  if (A.mother[a] === b || A.father[a] === b) return true;
  if (A.mother[b] === a || A.father[b] === a) return true;
  const ma = A.mother[a], fa = A.father[a], mb = A.mother[b], fb = A.father[b];
  if (ma !== NO_ONE && (ma === mb || ma === fb)) return true;
  if (fa !== NO_ONE && (fa === mb || fa === fb)) return true;
  return false;
}

// ===========================================================================
// 連れ合いを亡くした者を独りに戻す（再婚できるように）
// ===========================================================================
export function widow(P) {
  const A = P.a;
  let n = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const sp = A.spouse[i];
    if (sp === NO_ONE) continue;
    if (!A.alive[sp]) { A.spouse[i] = NO_ONE; n++; }
  }
  return n;
}

// ===========================================================================
// 結婚（月に1度）
// ===========================================================================
/**
 * 同じ村の中でランダムに1対1で結ぶ。新しい家を1軒建てる。
 * 30軒が埋まっている村では結べない（＝溢れ。分村の合図）。
 * @returns {{married:number, blocked:number}}
 */
export function marryMonth(P, houses, V, tick, rng) {
  const A = P.a;
  const nv = V.len;
  const men = [], women = [];
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || A.spouse[i] !== NO_ONE) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    const y = ageY(P, i);
    if (y < MARRY_MIN_AGE) continue;
    if (A.sex[i] === SEX_MALE) men.push(i);
    else if (y <= MARRY_MAX_AGE_WOMAN) women.push(i);
  }
  if (!men.length || !women.length) return { married: 0, blocked: 0 };

  rng.shuffle(women);
  rng.shuffle(men);
  const taken = new Uint8Array(A.len);
  let married = 0, blocked = 0;

  for (const w of women) {
    if (taken[w]) continue;
    if (!rng.bool(MARRY_CHANCE)) continue;
    const v = A.village[w];
    // 同じ村の中でランダム（A-12）。血が近すぎる相手だけ避ける
    const pool = [];
    for (const m of men) {
      if (taken[m] || A.village[m] !== v) continue;
      if (tooClose(P, w, m)) continue;
      pool.push(m);
    }
    if (!pool.length) continue;
    const m = pool[rng.int(pool.length)];

    // 家が要る。30軒が埋まっていたら結べない（村が溢れている）
    if (V.isFull(v)) { blocked++; continue; }

    A.spouse[w] = m; A.spouse[m] = w;
    taken[w] = 1; taken[m] = 1;
    const line = lineOf(P, houses, m);
    const gen = genOf(P, houses, m) + 1;
    const h = houses.found(P, v, m, w, tick, line, gen);
    V.a.houses[v]++;
    married++;
  }
  return { married, blocked };
}

function lineOf(P, houses, i) {
  const h = P.a.house[i];
  if (h !== NO_HOUSE && h < houses.a.len) return houses.a.line[h];
  return 0xFFFF;
}
function genOf(P, houses, i) {
  const h = P.a.house[i];
  if (h !== NO_HOUSE && h < houses.a.len) return houses.a.gen[h];
  return 0;
}

// ===========================================================================
// 身ごもる（月に1度）
// ===========================================================================
/**
 * 18〜40歳の連れ合いのいる女が身ごもる。妊娠10ヶ月。
 * 双子5%・三つ子0.1%（双子の生まれやすさステで前後する）。
 * 飢えている村では身ごもらない（B-12：食料の天井で人口を自己調整させる）。
 */
export function conceiveMonth(P, V, tick, rng) {
  const A = P.a;
  let n = 0, twins = 0, triplets = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || A.sex[i] !== SEX_FEMALE) continue;
    if (A.state[i] & ST_PREGNANT) continue;
    const sp = A.spouse[i];
    if (sp === NO_ONE || !A.alive[sp]) continue;
    // 18〜40歳のあいだ（A-12）。月齢で見る。40歳の誕生日を過ぎたら身ごもらないので、
    // いちばん遅い出産でも40歳10ヶ月に収まる
    const am = A.ageMonths[i];
    if (am < BIRTH_MIN_AGE * C.MONTHS_PER_YEAR || am > BIRTH_MAX_AGE * C.MONTHS_PER_YEAR) continue;
    const y = ageY(P, i);
    if (A.lastBirth[i] >= 0 && tick - A.lastBirth[i] < NURSING_MONTHS * C.DAYS_PER_MONTH) continue;
    if (A.state[i] & ST_HUNGRY) continue;                    // 飢えていると身ごもらない
    if (A.state[i] & ST_BARREN) continue;                    // 繁殖不能（第7部 §1 永続4）。受胎確率0

    // 繁殖力（ステ）と生存力（遺伝的荷重）で前後する
    let p = CONCEIVE_CHANCE * (A.gene[ID_FERTILITY][i] / 50) * A.vitality[i];
    // 40に近づくほど落ちる
    const late = (y - 30) / (BIRTH_MAX_AGE - 30);
    if (late > 0) p *= (1 - 0.7 * late);
    if (p <= 0 || !rng.bool(Math.min(0.5, p))) continue;

    let count = 1;
    const tw = TWIN_P * (A.gene[ID_TWINS][i] / 50);
    const tr = TRIPLET_P * (A.gene[ID_TWINS][i] / 50);
    if (rng.next() < tr) { count = 3; triplets++; }
    else if (rng.next() < tw) { count = 2; twins++; }

    A.state[i] |= ST_PREGNANT;
    A.pregDue[i] = tick + PREGNANCY_DAYS;
    A.pregFather[i] = sp;
    A.pregCount[i] = count;
    n++;
  }
  return { conceived: n, twins, triplets };
}

// ===========================================================================
// 産む（日ごと。妊娠10ヶ月ちょうどで終わる）
// ===========================================================================
/**
 * その日に産み月を迎えた者が産む。
 * @returns {{born:number, mothersLost:number, babies:number[]}}
 */
export function birthDay(P, houses, V, tick, rng, rngGift = rng) {
  const A = P.a;
  const babies = [];
  const motherDead = [];       // 喪の入力（お産で亡くした母）
  let mothersLost = 0, hardAfter = 0;
  const len = A.len;                    // 産まれた子を数えないよう、先に長さを取る

  for (let i = 0; i < len; i++) {
    if (!A.alive[i]) continue;
    if (!(A.state[i] & ST_PREGNANT)) continue;
    if (A.pregDue[i] > tick) continue;

    const mother = i;
    const father = A.pregFather[i];
    const count = Math.max(1, A.pregCount[i]);
    const v = A.village[mother];
    const h = A.house[mother];

    for (let k = 0; k < count; k++) {
      const c = P.spawn(tick);
      breed(P, c, father >= 0 && A.alive[father] ? father : mother, mother, rng, rngGift);
      rollDefect(P, c, rng);            // 先天障害（永続3）。ストリームは 出生（#17 §10-3 の1番）
      A.sex[c] = rng.int(2);                       // A-20：完全ランダムで1/2
      A.mother[c] = mother;
      A.father[c] = father;
      A.rank[c] = father >= 0 ? A.rank[father] : A.rank[mother];
      A.blood[c] = (father >= 0 ? A.blood[father] : 0) | A.blood[mother];
      breedLook(P, c, father >= 0 && A.alive[father] ? father : mother, mother, rng);
      A.gen[c] = (father >= 0 ? Math.max(A.gen[father], A.gen[mother]) : A.gen[mother]) + 1;
      A.lifespan[c] = lifespanOf(P, c);
      if (h !== NO_HOUSE) houses.join(P, h, c);
      else { A.village[c] = v; }
      babies.push(c);
    }

    A.state[mother] &= ~ST_PREGNANT;
    A.state[mother] |= ST_NURSING;
    A.pregDue[mother] = -1;
    A.pregFather[mother] = NO_ONE;
    A.pregCount[mother] = 0;
    A.lastBirth[mother] = tick;
    if (A.births[mother] < 255) A.births[mother]++;

    // お産。軽さが高いほど死なない。多胎ほど重い
    const easy = A.gene[ID_EASY_BIRTH][mother] / 100;
    const risk = BIRTH_DEATH_P * (1.6 - easy) * count / A.vitality[mother];
    // 奇跡（G・A-23）はお産でも死なない
    const lost = !deathless(P, mother) && rng.next() < risk;
    if (lost) { P.kill(mother, tick, DEATH_BIRTH); mothersLost++; motherDead.push(mother); }
    // 難産のあと（第7部 §1 一時11→永続の変換）。お産の軽さの素値<25 が難産。
    // 12% で繁殖不能・25% で古傷（欠損）。★ 死んでいても同じ回数だけ引く（消費順を分岐で変えない）
    const after = afterHardBirth(P, mother, rng);
    if (!lost && after) hardAfter++;
  }
  return { born: babies.length, mothersLost, babies, motherDead, hardAfter };
}

// ===========================================================================
// 産後を明ける
// ===========================================================================
export function nursingMonth(P, tick) {
  const A = P.a;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || !(A.state[i] & ST_NURSING)) continue;
    if (A.lastBirth[i] >= 0 && tick - A.lastBirth[i] >= NURSING_MONTHS * C.DAYS_PER_MONTH) {
      A.state[i] &= ~ST_NURSING;
    }
  }
}
