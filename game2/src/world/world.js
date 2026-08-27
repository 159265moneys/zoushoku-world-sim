// 世界。個体・家・村を1つに束ねて、「1日ぶん」「1ヶ月ぶん」に何が起きるかを決める。
//
// **いつ進めるかは決めない。** それは flow/run.js の仕事。
// ここは「この tick に何が起きるか」だけを知っている。
// 依存の向きは ui → flow → world → core の一方向なので、ここから上は見ない。
//
// 確定事項より：
//   A-10 創世は十匹＋最初の10年は配給
//        十匹のうち3人を、2ヶ月ずらして妊娠させておく（出産が3回起きる）
//        十匹なら女は5人
//   A-11 1日＝1tick。月単位で計算するもの：状態異常・産出・消費・成長
//   A-14 収束計。毎回走らせて前回と比較する

import * as S from '../core/stats.js';
import { seedFounder } from './gifts.js';
import { foundLook } from './looks.js';
import * as C from '../core/calendar.js';
import { makeStreams, STREAM, saveStreams, loadStreams } from '../core/rng.js';
import {
  People, SEX_MALE, SEX_FEMALE, RANK_COMMON, ST_PREGNANT, agingAndDeath, lifespanOf,
  DEATH_COUNT, DEATH_HUNGER, DEATH_BIRTH,
} from './people.js';
import { Houses } from './house.js';
import {
  Villages, WHERE_FRONTIER, HOUSES_PER_VILLAGE,
  assignWork, produceAndEat, syncHouses, AREA_HOME, AREA_FIELD,
} from './village.js';
import { growMonth, seedEffortForAge } from './grow.js';
import { widow, marryMonth, conceiveMonth, birthDay, nursingMonth } from './marry.js';
import { foundGenome, targetsFrom } from './genetics.js';
import * as COND from './condition.js';   // 状態12個（第7部 §1）
// ★ 地図（#17）。opts.map が真のときだけ生きる。偽なら今までどおり土地を見ない
import { generate as genMap } from './mapgen.js';
import { pickSeat, guarantee, enrich } from './seat.js';
import { expand as expandParcels } from './parcel.js';
import { Land } from './land.js';
import { PPL } from './settle.js';

export const GENESIS_COUNT = 10;      // 創世の十匹
export const GENESIS_WOMEN = 5;       // 十匹なら女は5人（A-10）
export const GENESIS_PREGNANT = 3;    // うち3人を2ヶ月ずらして妊娠済み
export const GENESIS_STAGGER_MONTHS = 2;

export class World {
  constructor(seed = 1, opts = {}) {
    this.seed = seed >>> 0 || 1;
    this.opts = opts;
    // ★ 乱数は機能ごとに12本（#17 §10-3）。1本のままだと機能を足すたびに
    //   基準線（M-01/M-05/M-07/M-32）が全損する。this.R[STREAM.XXX] で引く
    this.R = makeStreams(this.seed);
    // 0番（地形）は mapgen が自前で立てるので、ここでは番号を予約しているだけ
    this.tick = 0;
    this.people = new People(opts.cap ?? 256);
    this.houses = new Houses(64);
    this.villages = new Villages(4);
    this.map = null;                   // ★ 地図。opts.map で生える（#17）
    this.land = null;                  // ★ 村と区画を繋ぐ橋
    this.log = [];                     // 節目（年代記の素）
    this.firsts = new Set();           // 「これは初めてか」（A-10 の副産物）
    this.counters = {
      born: 0, died: 0, byCause: new Array(DEATH_COUNT).fill(0),
      married: 0, blocked: 0, conceived: 0, twins: 0, triplets: 0,
      ceilingFired: 0,
      split: 0, splitFailed: 0,        // ★ 分村できた／r>12里で詰まった
      mourned: 0, scarred: 0, stunted: 0,   // 状態12個（第7部 §1）
    };
  }

  // ---- 創世 --------------------------------------------------------------
  /**
   * 十匹を置く。5組の家が建ち、うち3人の妻が既に身ごもっている。
   * @param centroid 性格診断の重心（名前→0〜1）。無ければ全部50の平凡な種族
   */
  genesis(centroid = null) {
    const P = this.people, H = this.houses, V = this.villages;
    const rng = this.R[STREAM.BIRTH], rngGift = this.R[STREAM.GIFT];
    P.tickNow = this.tick;
    const targets = targetsFrom(centroid);

    // ★ 地図を作って、創世の村をその席に置く（#17 §3-4）
    if (this.opts.map) {
      const g = genMap(this.seed);
      const r = pickSeat(g);
      if (!r.ok) throw new Error('席が置けない：' + r.why);
      guarantee(g, r.seat); enrich(g, r.seat);
      const L = expandParcels(g);
      this.map = { g, L, seat: r.seat, seatX: r.x, seatY: r.y };
      this.land = new Land(g, L);
    }

    const v = V.create(this.tick, this.opts.where ?? WHERE_FRONTIER, 0);
    if (this.land) {
      this.land.place(v, this.map.seatX * PPL + 2, this.map.seatY * PPL + 2);
      this.land.fogMonth(1);
    }

    const men = [], women = [];
    for (let k = 0; k < GENESIS_COUNT; k++) {
      const i = P.spawn(this.tick);
      foundGenome(P, i, rng, targets);
      // 性別は属性。十匹だけは神が置くので 5/5（A-10 が「十匹なら女は5人」と数えている）
      P.a.sex[i] = k < GENESIS_WOMEN ? SEX_FEMALE : SEX_MALE;
      P.a.ageMonths[i] = C.yearsToMonths(18 + rng.int(9));   // 18〜26歳
      // 生まれた日は tick 0 より前。月齢と食い違わせない
      P.a.birthTick[i] = -P.a.ageMonths[i] * C.DAYS_PER_MONTH;
      P.a.rank[i] = RANK_COMMON;
      P.a.blood[i] = 1 << k;   // 十匹それぞれに1本の旗を立てる
      foundLook(P, i, k, rng);
      seedFounder(P, i, k, rngGift);     // 授かりものの種を1本ずつ隠して持たせる（A-23）  // 見た目も十匹それぞれ違う（キャラビジュアル.md §3）
      P.a.gen[i] = 0;
      P.a.lifespan[i] = lifespanOf(P, i);
      P.a.job[i] = AREA_HOME;
      // ★ 十匹は18〜26歳で生まれる。**その歳までに積まれたはずの努力値**を持たせる。
      //   これが無いと「才能だけの大人」になり、旧目盛りの1/13しか産出しない（2026-08-28）
      seedEffortForAge(P, i, AREA_FIELD);
      (P.a.sex[i] === SEX_FEMALE ? women : men).push(i);
    }

    // 5組にする。家が5軒建つ
    for (let k = 0; k < GENESIS_WOMEN; k++) {
      const w = women[k], m = men[k];
      P.a.spouse[w] = m; P.a.spouse[m] = w;
      H.found(P, v, m, w, this.tick, k, 0);
    }
    syncHouses(V, H);

    // 3人を2ヶ月ずらして妊娠済みにする。産み月は 6・8・10ヶ月後
    for (let k = 0; k < GENESIS_PREGNANT; k++) {
      const w = women[k];
      const monthsLeft = 6 + k * GENESIS_STAGGER_MONTHS;
      P.a.state[w] |= ST_PREGNANT;
      P.a.pregDue[w] = this.tick + monthsLeft * C.DAYS_PER_MONTH;
      P.a.pregFather[w] = P.a.spouse[w];
      P.a.pregCount[w] = 1;
    }

    assignWork(P, V, this.tick);
    this.note('創世', `十匹が立った。家が${H.count}軒` +
      (this.land ? `。席は (${this.map.seatX},${this.map.seatY})・畑の定員${this.land.fieldCap[0]}人月` : ''));
    return this;
  }

  // ---- 進める ------------------------------------------------------------
  /** 1日。日ごとに起きるのは出産だけ（妊娠10ヶ月がちょうどで終わるため） */
  stepDay() {
    const t = this.tick;
    this.people.tickNow = t;      // 妊娠・産後の「段」を出すのに要る（第7部 §1）
    const b = birthDay(this.people, this.houses, this.villages, t,
                       this.R[STREAM.BIRTH], this.R[STREAM.GIFT]);
    if (b.born) {
      this.counters.born += b.born;
      if (this.once('birth')) this.note('初めての子', `${b.born}人`);
    }
    if (b.mothersLost) {
      this.counters.died += b.mothersLost;
      this.counters.byCause[DEATH_BIRTH] += b.mothersLost;
      this.counters.mourned += COND.mourn(this.people, b.motherDead);
    }
    if (C.isMonthStart(t)) this.stepMonth();
    this.tick = t + 1;
    return b;
  }

  /** 1ヶ月。状態異常・産出・消費・成長・結婚・受胎はここ（骨組み 3） */
  stepMonth() {
    const t = this.tick, P = this.people, H = this.houses, V = this.villages;

    const d = agingAndDeath(P, t, this.R[STREAM.DEATH]);
    this.counters.died += d.died;
    // 喪（一時12）。★ 乱数を1つも引かない。死んだ者の近親をなめるだけ
    this.counters.mourned += COND.mourn(P, d.dead);
    for (let k = 0; k < d.byCause.length; k++) this.counters.byCause[k] += d.byCause[k];
    if (d.byCause[DEATH_HUNGER] > 0 && this.once('hunger-death')) this.note('最初の餓死', '永久に戻らない');

    widow(P);
    H.recount(P, t);
    H.succeed(P, H.index(P));
    syncHouses(V, H);
    assignWork(P, V, t);

    if (this.land) this.land.fogMonth(V.len);
    const food = produceAndEat(P, V, t, this.land);
    for (const r of food) {
      if (r && r.shortage > 0 && this.once('hunger')) this.note('最初の飢え', '作る量が食べる量に届かない');
    }

    // 状態の月次（第7部 §1）。疲労・発育不全・喪の減衰・負傷の治癒。
    // ★ 負荷は村と暦が知っていることなので、ここで決めて condition.js に渡す
    //   （condition.js が village.js を読むと循環する）
    const harvest = C.season(t) === 2;                 // 秋の3ヶ月＝収穫期
    const cm = COND.conditionMonth(P, t, (i) => {
      const job = P.a.job[i];
      if (job === AREA_HOME) return COND.LOAD_IDLE;    // 非番
      if (job === AREA_FIELD && harvest) return COND.LOAD_HARVEST;
      return COND.LOAD_NORMAL;                         // 平時の畑・森・辺境・訓練
    }, this.R[STREAM.DISASTER]);
    this.counters.scarred += cm.scarred;
    this.counters.stunted += cm.stunted;
    if (cm.stunted > 0 && this.once('stunt')) this.note('育ちきらない子', '飢えが16歳までに18ヶ月を超えた');

    growMonth(P, V, t);

    const m = marryMonth(P, H, V, t, this.R[STREAM.MARRY]);
    this.counters.married += m.married; this.counters.blocked += m.blocked;
    if (m.blocked > 0 && this.once('village-full')) {
      this.note('村が溢れた', `${HOUSES_PER_VILLAGE}軒が埋まった`);
    }
    // ★ 正典1-4「30軒が埋まると自動で隣に新しい村ができる」── ここが今まで無かった
    if (m.blocked > 0) this.splitVillages();
    syncHouses(V, H);

    const c = conceiveMonth(P, V, t, this.R[STREAM.BIRTH]);
    this.counters.conceived += c.conceived;
    this.counters.twins += c.twins; this.counters.triplets += c.triplets;
    nursingMonth(P, t);

    return { death: d, food, marry: m, conceive: c };
  }

  /**
   * 分村（正典11-B ＋ #17 §6-5）。30軒が埋まっている村から順に、1ヶ月に1つだけ出す。
   * ★ 地図が無いとき（opts.map なし）は、座標を持たない村をただ足す（旧来の挙動）
   */
  splitVillages() {
    const V = this.villages, H = this.houses, P = this.people;
    let stuck = 0;
    for (let v = 0; v < V.len; v++) {
      if (!V.a.alive[v] || V.a.houses[v] < HOUSES_PER_VILLAGE) continue;
      if (this.land) {
        const spot = this.land.findSplit(v, V.len, () => this.R[STREAM.SPLIT].next());
        if (!spot) { stuck++; continue; }              // r>12里 ＝ 溢れたまま
        const nv = V.create(this.tick, this.opts.where ?? WHERE_FRONTIER, 0);
        this.land.fogSplit(this.land.px[v], this.land.py[v], spot.px, spot.py);
        this.land.place(nv, spot.px, spot.py);
        this.moveHouses(v, nv);
        this.counters.split++;
        this.note('分村', `${spot.r.toFixed(1)}里 先に村ができた（畑の定員${this.land.fieldCap[nv]}人月）`);
      } else {
        const nv = V.create(this.tick, this.opts.where ?? WHERE_FRONTIER, 0);
        this.moveHouses(v, nv);
        this.counters.split++;
      }
      return;                                   // 1ヶ月に1村だけ
    }
    // ★ ここへ来たのは「30軒が埋まった村が1つも分村できなかった」月。
    //   その月に詰まっていた村の数を数える（試行回数ではない）
    if (stuck > 0) {
      this.counters.splitFailed = Math.max(this.counters.splitFailed, stuck);
      if (this.once('split-stuck')) this.note('分村が詰まった', `${stuck}村が r>12里 で出られない`);
    }
  }

  /** 正典11-C：8軒を移す。いまは「新しい家から」だけを見る（点数の全式は未実装） */
  moveHouses(from, to, n = 8) {
    const H = this.houses, P = this.people, HA = H.a;
    const ids = [];
    for (let h = 0; h < HA.len; h++) if (HA.alive[h] && HA.village[h] === from) ids.push(h);
    ids.sort((a, b) => b - a);                  // 家IDの大きい順＝新しい家から
    let moved = 0;
    for (const h of ids) {
      if (moved >= n) break;
      HA.village[h] = to;
      for (let i = 0; i < P.a.len; i++)
        if (P.a.alive[i] && P.a.house[i] === h) P.a.village[i] = to;
      moved++;
    }
    syncHouses(this.villages, H);
    return moved;
  }

  /** n 日ぶん進める */
  run(days) { for (let k = 0; k < days; k++) this.stepDay(); return this; }
  runYears(y) { return this.run(y * C.DAYS_PER_YEAR); }

  // ---- 節目 --------------------------------------------------------------
  /** 「これは初めてか」。そのまま年代記の初出フラグになる（A-10） */
  once(key) { if (this.firsts.has(key)) return false; this.firsts.add(key); return true; }
  note(what, detail = '') { this.log.push({ tick: this.tick, what, detail }); }

  // ---- 乱数の続き（セーブ用・#17 §10-4） ---------------------------------
  // ★ 12本ある。1本だけ保存すると、読み直した世界は続きから走らない。
  //   保存するときは必ずこの2つを通すこと（this.R を直に触らない）
  saveRandom() { return saveStreams(this.R); }
  loadRandom(states) { loadStreams(this.R, states); return this; }

  // ---- 見るためのもの ----------------------------------------------------
  population() { return this.people.aliveCount(); }
  houseCount() { return this.houses.count; }
  foodOf(v = 0) { return this.villages.a.food[v]; }
  date() { return C.dateOf(this.tick); }

  /** 世界の要約。検査台と収束計が読む */
  summary() {
    const P = this.people;
    let adults = 0, children = 0, women = 0, pregnant = 0, sumAge = 0;
    for (const i of P.living()) {
      const y = P.ageYears(i);
      sumAge += y;
      if (y >= 18) adults++; else children++;
      if (P.a.sex[i] === SEX_FEMALE) women++;
      if (P.a.state[i] & ST_PREGNANT) pregnant++;
    }
    const n = P.aliveCount();
    return {
      tick: this.tick, date: C.formatDate(this.tick),
      pop: n, adults, children, women, pregnant,
      meanAge: n ? sumAge / n : 0,
      houses: this.houses.count,
      food: this.villages.len ? this.villages.a.food[0] : 0,
      born: this.counters.born, died: this.counters.died,
      byCause: this.counters.byCause.slice(),
      lines: this.houses.livingLines().size,
    };
  }
}

// ===========================================================================
// 収束計（A-14）。毎回走らせて前回と比較して記録する
// ===========================================================================

/** ステの分散。集団のばらつきが下がり続けていないか。連鎖群が効いていれば49前後で止まる */
export function spread(P) {
  const A = P.a;
  const idx = [];
  for (let i = 0; i < A.len; i++) if (A.alive[i]) idx.push(i);
  if (idx.length < 2) return { mean: 0, sd: 0, n: idx.length };
  let sumMean = 0, sumSd = 0;
  for (let s = 0; s < S.COUNT; s++) {
    let m = 0;
    for (const i of idx) m += A.gene[s][i];
    m /= idx.length;
    let vsum = 0;
    for (const i of idx) { const d = A.gene[s][i] - m; vsum += d * d; }
    sumMean += m;
    sumSd += Math.sqrt(vsum / idx.length);
  }
  return { mean: sumMean / S.COUNT, sd: sumSd / S.COUNT, n: idx.length };
}

/**
 * 全ステ最強への接近。最良個体で80を超えるステの数。
 * 7〜13個で止まる。増え続けたら連鎖群が壊れている（A-14）
 */
export function bestIndividual(P, threshold = 80) {
  const A = P.a;
  let best = -1, bestN = -1, bestMean = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    let n = 0, sum = 0;
    for (let s = 0; s < S.COUNT; s++) { const g = A.gene[s][i]; sum += g; if (g >= threshold) n++; }
    if (n > bestN) { bestN = n; best = i; bestMean = sum / S.COUNT; }
  }
  return { i: best, above: bestN, mean: bestMean };
}

/**
 * 血統の生き残り数。創世の十匹のうち、いま生きている誰かに血が残っているのは何匹ぶんか。
 * 1家系に収束したら血を集める最適解が見つかっている（A-14）。
 */
export function lineages(P) {
  const A = P.a;
  let mask = 0;
  for (let i = 0; i < A.len; i++) if (A.alive[i]) mask |= A.blood[i];
  let n = 0;
  for (let k = 0; k < 16; k++) if ((mask >>> k) & 1) n++;
  return { mask, size: n };
}

/** 収束計をまとめて1回 */
export function converge(w) {
  const P = w.people;
  const sp = spread(P), bi = bestIndividual(P);
  return {
    tick: w.tick, pop: P.aliveCount(),
    meanOfStats: sp.mean, sdOfStats: sp.sd,
    bestAbove80: bi.above, bestMean: bi.mean,
    lineages: lineages(P).size,
    houses: w.houses.count,
  };
}
