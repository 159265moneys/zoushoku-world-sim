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
import * as NEAR from './near.js';        // 近い順3村と h(i,j)（#11-D）
import { affinity } from './ties.js';     // 相性（h の第3項）

const ID_SOCIAL = S.needId('社交');
const ID_CURIO = S.needId('好奇心');
import { breedLook } from './looks.js';
import * as C from '../core/calendar.js';
import {
  SEX_MALE, SEX_FEMALE, NO_HOUSE, NO_VILLAGE, NO_ONE,
  ST_PREGNANT, ST_NURSING, ST_HUNGRY, ST_BARREN, DEATH_BIRTH, DEATH_INFANT, lifespanOf,
} from './people.js';
import { breed } from './genetics.js';
import { bandNorm } from '../core/bands.js';   // レア度の帯（正典2-4）
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
/**
 * @param nearOf (v, k) → k番目に近い村（無ければ −1）。#11-D の「近い順3村」
 * @param ties   相性を引くため（h(i,j) の第3項）
 * @param pressure 婚姻圧カード（民生局・既定0）
 */
export function marryMonth(P, houses, V, tick, rng, nearOf = null, ties = null, pressure = 0) {
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
  if (!men.length || !women.length) return { married: 0, blocked: 0, couples: [] };

  rng.shuffle(women);
  rng.shuffle(men);
  const taken = new Uint8Array(A.len);
  const couples = [];        // 結婚した組（不満④ −15 の入口。#5 §4）
  let married = 0, blocked = 0;

  for (const w of women) {
    if (taken[w]) continue;
    if (!rng.bool(MARRY_CHANCE)) continue;
    const v = A.village[w];
    // ---- #11-D 結婚の範囲。★ 半径ではなく**村数**で切る ----
    //   半径で切ると、村が疎らな国では相手が0人になり血のプールが村1つに閉じる。
    //   村数で切れば 97.2%の村が12里以内に3村を持つので、上位3村は常に埋まる。
    const social = P.effective(w, ID_SOCIAL), curio = P.effective(w, ID_CURIO);
    const N = nearOf ? NEAR.rangeN(social, curio, pressure) : 0;
    const w0 = NEAR.outWeight(social, curio, pressure);
    // 候補の村と、その村の重み（自村 1.00 ／ k番目に近い村 w0 × 0.5^(k−1)）
    const pool = [], wt = [];
    for (let k = 0; k <= N; k++) {
      const vv = k === 0 ? v : nearOf(v, k - 1);
      if (vv < 0 || vv >= nv) continue;
      const base = k === 0 ? 1.0 : w0 * NEAR.NEAR_DECAY ** (k - 1);
      for (const m of men) {
        if (taken[m] || A.village[m] !== vv) continue;
        if (tooClose(P, w, m)) continue;         // 血が近すぎる相手だけ避ける（そのまま通す）
        // ★ h(i,j)：身分・富・相性。**0 にしない ── 身分違いの婚姻を禁じない**
        const aff = ties ? affinity(P, w, m) : 37;
        const h = NEAR.matchH(A.rank[w], A.rank[m], A.commonTier[w], A.commonTier[m], aff, pressure);
        pool.push(m); wt.push(base * h);
      }
    }
    // ★★ 掟：**候補が何人でも引くのは1回。0人でも引く。**★★
    //   2026-08-31（別セッションの精査で発見）：`if (!pool.length) continue;` を
    //   抽選の**前**に置いていたので、**門を通った女の約34%が乱数を1回も引かずに抜けて**いた
    //   ＝ 分岐で消費が変わる。引いてから捨てる。
    let total = 0; for (const x of wt) total += x;
    const rPick = rng.next();
    if (!pool.length) continue;
    let r = rPick * total, m = pool[pool.length - 1];
    for (let k = 0; k < pool.length; k++) { r -= wt[k]; if (r <= 0) { m = pool[k]; break; } }

    // 家が要る。30軒が埋まっていたら結べない（村が溢れている）
    const hv = A.village[m];
    if (V.isFull(hv)) { blocked++; continue; }

    A.spouse[w] = m; A.spouse[m] = w;
    taken[w] = 1; taken[m] = 1;
    if (A.village[m] !== v) A.village[w] = A.village[m];   // 村外婚：移った側が夫の村へ
    couples.push([w, m]);
    const line = lineOf(P, houses, m);
    const gen = genOf(P, houses, m) + 1;
    const h = houses.found(P, hv, m, w, tick, line, gen);
    V.a.houses[hv]++;
    married++;
  }
  return { married, blocked, couples };
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
    // ★ 錨を帯へ（2026-08-31）。繁殖力はレア度B（帯 15〜53・中心34）なので、
    //   `才能/50` のままだと帯を入れた瞬間に受胎率が **32%** 落ちる。
    //   `bandNorm×2` は帯の中心で 1.00 ＝ 旧式の「才能50で1.00」と同じ意味になる
    let p = CONCEIVE_CHANCE * (bandNorm(ID_FERTILITY, A.gene[ID_FERTILITY][i]) * 2) * A.vitality[i];
    // 40に近づくほど落ちる
    const late = (y - 30) / (BIRTH_MAX_AGE - 30);
    if (late > 0) p *= (1 - 0.7 * late);
    if (p <= 0 || !rng.bool(Math.min(0.5, p))) continue;

    let count = 1;
    const tw = TWIN_P * (A.gene[ID_TWINS][i] / 50);
    const tr = TRIPLET_P * (A.gene[ID_TWINS][i] / 50);
    // ★ 掟：**分岐で回数を変えない。**2026-08-31（精査で発見）：`if/else if` だと
    //   三つ子の月だけ消費が1回少なかった（同じファイルの `birthDay` はわざわざ守っている）。
    //   2回とも先に引いてから決める
    const r3 = rng.next(), r2 = rng.next();
    if (r3 < tr) { count = 3; triplets++; }
    else if (r2 < tw) { count = 2; twins++; }

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
  let mothersLost = 0, hardAfter = 0, stillborn = 0;
  const len = A.len;                    // 産まれた子を数えないよう、先に長さを取る

  for (let i = 0; i < len; i++) {
    if (!A.alive[i]) continue;
    if (!(A.state[i] & ST_PREGNANT)) continue;
    if (A.pregDue[i] > tick) continue;

    const mother = i;
    const born0 = babies.length;      // このお産で生まれた子の始まり（流れたときに戻す）
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
    // 難産のあと。お産の軽さの素値<25 が難産。
    // ★ B-13 裁定（2026-08-28）：**不妊にはしない。そのお産が流れるだけ。**次はまた産める
    //   12% でそのお産が流れる ／ 25% で母に古傷（欠損）
    //   ★ 母が死んでいても同じ回数だけ引く（ストリーム内で消費順を分岐で変えない）
    const after = afterHardBirth(P, mother, rng);
    if (after & 1) {
      // 流れた。このお産で生まれた子は育たない（#9-D の 7 乳幼児。族を持たないので宗教の起源にならない）
      for (let k = born0; k < babies.length; k++) P.kill(babies[k], tick, DEATH_INFANT);
      babies.length = born0;
      stillborn++;
    }
    if (!lost && after) hardAfter++;
  }
  return { born: babies.length, mothersLost, babies, motherDead, hardAfter, stillborn };
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
