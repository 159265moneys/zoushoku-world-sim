// 進行。**世界をいつ進めるかを、ここだけが知っている。**
//
// 依存の向きは ui → flow → world → core の一方向。
// **UI は world を直接呼ばない。**上帯も地図も個体票も、ここが返す形だけを見る。
// だから world の列（型付き配列）は、ここから外へ一歩も出ない。
//
// 確定事項より：
//   A-11  1日＝1tick。1倍＝1日1分。本番の上限60倍。デバッグ500倍（本番に出さない）
//   A-10  「これは初めてか」＝逐次チュートリアルと年代記の初出フラグ
//   A-19  誰がどこで何をしているかが、見て分かること
//   A-4/A-5  大きさ＋年輪＝年齢／細胞の数＝熟練／色相＝血統
//   A-7   オーナーは全部見える。数値ではっきりと
//
// 掟：**ここに Date.now() を書かない。**壁時計を測るのは ui/main.js だけで、
//     ここは「何ミリ秒ぶん経ったか」を渡されて tick の整数に直すだけ。
//     requestAnimationFrame も持たない（旧版は戦闘だけ rAF で、裏タブで止まった）。

import * as C from '../core/calendar.js';
import * as S from '../core/stats.js';
import { World, converge as convergeOf } from '../world/world.js';
import {
  SEX_NAMES, RANK_NAMES, DEATH_NAMES, STATE_NAMES,
  NO_HOUSE, NO_VILLAGE, NO_ONE,
  ST_PREGNANT, ST_HUNGRY, ST_SICK, ST_NURSING,
  WORK_START_AGE, baseLifespanOf,
} from '../world/people.js';
import {
  AREA_NAMES, AREA_COUNT, AREA_HOME, AREA_FIELD, AREA_FOREST, AREA_TRAIN, AREA_FRONTIER,
  AREA_STATS, HOUSES_PER_VILLAGE, RATION_YEARS, WHERE_NAMES,
} from '../world/village.js';
import { explain } from '../world/grow.js';

// ---- UI へ渡す名前（UI が world を import しなくて済むように、ここで中継する） ----
export {
  AREA_NAMES, AREA_COUNT, AREA_HOME, AREA_FIELD, AREA_FOREST, AREA_TRAIN, AREA_FRONTIER,
  HOUSES_PER_VILLAGE, RATION_YEARS, WHERE_NAMES,
  SEX_NAMES, RANK_NAMES, DEATH_NAMES,
};
export const SEASON_NAMES = C.SEASON_NAMES;
export const STAT_COUNT = S.COUNT;

// ---- レア度の段（オーナー確定・2026-08-21） --------------------------------
// 「全員持っているのは N〜A まで。S・SS・SSS・G はゼロがあるので、そもそも持っていない」
//
// **いまは効かない。**レア度は初期値の割り振りに一度も使われていないので、
// 全レア度が平均50で配られている（実測：SS の創意も N の普通のステも同じ釣り鐘型）。
// レア度→初期値は 確定事項 B-1 が承認待ちのまま止まっていて、設計班へ申し送り済み。
// ここは「遺伝が変わった日にそのまま効く」ようにだけしてある。
//
// AA（利き手・両利き／容姿／学習速度）がどちら側かはオーナー未回答。
// 容姿は全員持っていそうなので AA までを「全員持つ」に置いた。**変えるならこの1行。**
export const RARITY_ALWAYS = S.RARITY_LEVELS.indexOf('AA');

/** そのステを、この個体が「持っている」か。持っていなければ画面に出さない */
export function possesses(rarityRank, talent) {
  return rarityRank <= RARITY_ALWAYS || talent > 0;
}

// ---- 伸びやすさ（A-21：どこに住んでいるかで伸び率が変わる） -----------------
// 総合 ＝ いまの仕事がそのステを使う重み × 住んでいる場所の補正
//   重み  … village.js の AREA_STATS。**表に無いステは 0（＝その仕事では触りもしない）**
//   補正  … stats.js の PLACE_MULTIPLIER。中央1.10／辺境0.90 など
//
// **切れ目は仮。**A-21 の「補正の大きさ」自体がまだ未決なので、
// 設計班が決めたらこの1本を引き直す。
export const GROW_FAST = 0.95;

// ---- 速さ（A-11） ---------------------------------------------------------
// 1倍＝1日1分。60倍で1ヶ月30秒・1年6分。
export const SPEEDS = [1, 2, 5, 15, 60];               // 本番。上限は60（確定）
export const SPEED_DEBUG = C.SPEED_MAX_DEBUG;          // 500。開発用UIに隔離する
export const SPEED_MAX_RELEASE = C.SPEED_MAX_RELEASE;  // 60

// 1回の pump で進める上限。タブが裏に回っていた時間ぶんを一気に流し込まない。
// 世代をまたぐ時間は倍速ではなくオフライン進行で飛ばす（A-11）ので、ここは捨ててよい。
export const MAX_DT_MS = 250;
export const MAX_TICKS_PER_PUMP = 120;

// 最近の出来事を地図に残す日数（生まれた印・弔いの印）
export const FADE_DAYS = 15;

// 個体を1つずつ描くのをやめる人口。これを超えたら箱だけになる（A-19：降りたら中が見える）
export const MAX_FOLK = 3000;

// 十匹それぞれの色相。**色相は血統だけ。色に意味を載せない**（A-4/A-5）
export const FOUNDER_HUE = [];
for (let k = 0; k < 10; k++) FOUNDER_HUE.push((k * 36 + 12) % 360);

// ===========================================================================
// 色相＝血統
// ===========================================================================
/**
 * 血の旗（創世の十匹の10ビット）から色相を出す。
 * 混ざるほど彩度が落ちる。**混血は色が均される**——これは意味ではなく血そのもの。
 */
export function hueOfBlood(blood) {
  let x = 0, y = 0, n = 0;
  for (let k = 0; k < 10; k++) {
    if (!((blood >>> k) & 1)) continue;
    const a = FOUNDER_HUE[k] * Math.PI / 180;
    x += Math.cos(a); y += Math.sin(a); n++;
  }
  if (n === 0) return { hue: 40, pure: 0, lines: 0 };
  const pure = Math.hypot(x, y) / n;         // 1なら1家系のまま。0なら混ざりきっている
  let h = Math.atan2(y, x) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { hue: h, pure, lines: n };
}

// ===========================================================================
// 熟練（細胞の数）
// ===========================================================================
/** いま就いているエリアで積んだ努力値の重み付き平均。0〜40くらい */
function masteryOf(P, i) {
  const list = AREA_STATS[P.a.job[i]] || AREA_STATS[AREA_HOME];
  let sum = 0, w = 0;
  for (let k = 0; k < list.length; k++) {
    sum += P.a.ev[list[k][0]][i] * list[k][1];
    w += list[k][1];
  }
  return w > 0 ? sum / w : 0;
}
/** 熟練 → 細胞の数（0〜9）。増えるものが常に画面にあるように（A-10：細胞が増える） */
export function cellsOf(mastery) {
  const n = Math.round(mastery / 3.5);
  return n < 0 ? 0 : n > 9 ? 9 : n;
}
/** 年齢 → 年輪の数（0〜5） */
export function ringsOf(ageYears) {
  const n = Math.floor(ageYears / 12);
  return n < 0 ? 0 : n > 5 ? 5 : n;
}

// ===========================================================================
// 進行
// ===========================================================================

export class Run {
  /**
   * @param {object} opts {seed, dev, centroid, cap, where}
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.dev = !!opts.dev;
    this.seed = (opts.seed >>> 0) || 1;

    this.world = null;
    this.playing = false;
    this.speed = 1;
    this.acc = 0;              // 溜まったミリ秒。tick に足りない端数
    this.stepsTaken = 0;       // これまでに進めた日数（デバッグの目安）

    this.listeners = new Map();
    this.notices = [];         // 年代記（world.log をそのまま写す）
    this._logSeen = 0;
    this.selected = -1;
    this.selectedHouse = -1;

    this._snap = null;
    this.slotOf = new Map();   // 家 → 住居エリアのどの枠か（畳まれるまで動かさない）
    this.slotUsed = new Map(); // 村 → 使っている枠

    this.reset(this.seed);
  }

  // ---- 世界を立てる ------------------------------------------------------
  reset(seed = this.seed) {
    this.seed = (seed >>> 0) || 1;
    this.world = new World(this.seed, this.opts).genesis(this.opts.centroid ?? null);
    this.acc = 0;
    this.stepsTaken = 0;
    this._snap = null;
    this._logSeen = 0;
    this.notices = [];
    this.selected = -1;
    this.selectedHouse = -1;
    this.slotOf.clear();
    this.slotUsed.clear();
    this._drainLog();
    this.emit('reset', { seed: this.seed });
    return this;
  }

  // ---- 出来事 ------------------------------------------------------------
  on(name, fn) {
    let l = this.listeners.get(name);
    if (!l) { l = []; this.listeners.set(name, l); }
    l.push(fn);
    return this;
  }
  emit(name, payload) {
    const l = this.listeners.get(name);
    if (!l) return;
    for (const fn of l) fn(payload);
  }

  // ---- 時計 --------------------------------------------------------------
  play() { this.playing = true; this.emit('speed', this.status()); return this; }
  pause() { this.playing = false; this.emit('speed', this.status()); return this; }
  toggle() { return this.playing ? this.pause() : this.play(); }

  /** 速さを変える。本番は60まで。500は ?dev=1 のときだけ通す（A-11） */
  setSpeed(x) {
    const max = this.dev ? SPEED_DEBUG : SPEED_MAX_RELEASE;
    let v = Number(x) || 1;
    if (v < 1) v = 1;
    if (v > max) v = max;
    this.speed = v;
    this.acc = 0;
    this.emit('speed', this.status());
    return this;
  }
  /** いま選べる速さ。デバッグの500はここにしか出てこない */
  speedChoices() { return this.dev ? SPEEDS.concat([SPEED_DEBUG]) : SPEEDS.slice(); }
  msPerTick() { return C.msPerTick(this.speed); }

  /**
   * 壁時計で dtMs ぶん経った。tick の整数に直して、そのぶん世界を進める。
   * **ここが唯一の入口。**世界の中身は tick の整数しか見ない。
   * @returns 進めた日数
   */
  pump(dtMs) {
    if (!this.playing) return 0;
    let dt = dtMs;
    if (!(dt > 0)) return 0;
    if (dt > MAX_DT_MS) dt = MAX_DT_MS;    // 裏タブで溜まったぶんは捨てる
    this.acc += dt;
    const per = this.msPerTick();
    let n = Math.floor(this.acc / per);
    if (n <= 0) return 0;
    if (n > MAX_TICKS_PER_PUMP) { n = MAX_TICKS_PER_PUMP; this.acc = 0; }
    else this.acc -= n * per;
    return this.advance(n);
  }

  /** n 日進める。倍速も早送りも、結局ここを通る（同じ種なら同じ歴史） */
  advance(days) {
    const w = this.world;
    let born = 0;
    for (let k = 0; k < days; k++) {
      const wasMonth = C.monthOf(w.tick);
      const b = w.stepDay();
      born += b.born;
      this.stepsTaken++;
      if (C.monthOf(w.tick) !== wasMonth) this.emit('month', null);
      if (b.born) this.emit('birth', { born: b.born, babies: b.babies });
    }
    this._snap = null;
    this._drainLog();
    if (days > 0) this.emit('tick', { days, born });
    return days;
  }

  /** 何日ぶんかを一息で飛ばす。デバッグ用（500倍でも数百年は待てない） */
  fastForward(days) { return this.advance(days | 0); }
  fastForwardYears(y) { return this.advance((y | 0) * C.DAYS_PER_YEAR); }

  /** 1日だけ。止まっているときに一歩ずつ見るため */
  stepDay() { return this.advance(1); }
  stepMonth() { return this.advance(C.DAYS_PER_MONTH); }
  stepYear() { return this.advance(C.DAYS_PER_YEAR); }

  _drainLog() {
    const log = this.world.log;
    for (let k = this._logSeen; k < log.length; k++) {
      const e = log[k];
      const n = { tick: e.tick, date: C.formatDate(e.tick), what: e.what, detail: e.detail };
      this.notices.push(n);
      this.emit('notice', n);
    }
    this._logSeen = log.length;
  }

  // ---- 選ぶ --------------------------------------------------------------
  select(i) {
    this.selected = (i === undefined || i === null) ? -1 : i;
    this.selectedHouse = -1;
    this.emit('select', this.selected);
    return this;
  }
  selectHouse(h) {
    this.selectedHouse = (h === undefined || h === null) ? -1 : h;
    this.selected = -1;
    this.emit('select', -1);
    return this;
  }

  // ---- 上帯 --------------------------------------------------------------
  status() {
    return {
      playing: this.playing, speed: this.speed, dev: this.dev, seed: this.seed,
      choices: this.speedChoices(),
      msPerTick: this.msPerTick(),
      secondsPerMonth: C.realSecondsPerMonth(this.speed),
    };
  }

  /** 上帯に出す数。年月日・季節・人口・食べもの（毎フレーム読まれる） */
  view() {
    const s = this.snapshot();
    return s.bar;
  }

  // ---- 地図が読む形 ------------------------------------------------------
  /**
   * いまの世界の姿。**tick が同じあいだは作り直さない**（毎フレーム呼んでよい）。
   * 型付き配列はここから外へ出さない。UI が触るのは、ここで作った素の値だけ。
   */
  snapshot() {
    const w = this.world;
    if (this._snap && this._snap.tick === w.tick) return this._snap;

    const P = w.people, A = P.a;
    const H = w.houses, HA = H.a;
    const V = w.villages, VA = V.a;
    const tick = w.tick;
    const d = C.dateOf(tick);

    // ---- 村 ----
    const villages = [];
    const vIndex = new Map();
    for (let v = 0; v < V.len; v++) {
      if (!VA.alive[v]) continue;
      vIndex.set(v, villages.length);
      villages.push({
        v,
        where: VA.where[v], whereName: WHERE_NAMES[VA.where[v]],
        houses: VA.houses[v], slots: HOUSES_PER_VILLAGE,
        full: VA.houses[v] >= HOUSES_PER_VILLAGE,
        pop: VA.pop[v], workers: VA.workers[v],
        food: VA.food[v], foodCap: V.storeCap(v),
        produced: VA.produced[v], eaten: VA.eaten[v],
        hungry: VA.hungry[v], rationed: VA.rationed[v],
        founded: VA.founded[v],
        byArea: new Array(AREA_COUNT).fill(0),   // **いま実際にいる場所**（地図に描くのと同じ数）
        byJob: new Array(AREA_COUNT).fill(0),    // 割り当てられている仕事
      });
    }

    // ---- 家（枠は畳まれるまで動かさない。箱が飛び回ると誰の家か分からなくなる） ----
    const homes = [];
    const homeIndex = new Map();
    const stillHere = new Set();
    for (let h = 0; h < HA.len; h++) {
      if (!HA.alive[h]) continue;
      stillHere.add(h);
      const v = HA.village[h];
      const slot = this._slot(h, v);
      homeIndex.set(h, homes.length);
      homes.push({
        h, v, slot,
        size: HA.size[h], head: HA.head[h], mate: HA.mate[h],
        line: HA.line[h], gen: HA.gen[h], founded: HA.founded[h],
        members: [],
      });
    }
    for (const h of [...this.slotOf.keys()]) if (!stillHere.has(h)) this._freeSlot(h);

    // ---- 個体 ----
    const folk = [];
    const gone = [];
    const pop = P.aliveCount();
    const tooMany = pop > MAX_FOLK;
    let adults = 0, children = 0, women = 0, pregnant = 0, hungry = 0, sumAge = 0;

    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i]) {
        // 弔い。**死は永久に戻らない**（A-10）ので、少しのあいだ跡を残す
        const dt = A.deathTick[i];
        if (dt >= 0 && tick - dt <= FADE_DAYS && !tooMany) {
          gone.push({
            i, h: A.house[i] === NO_HOUSE ? -1 : A.house[i],
            v: A.village[i] === NO_VILLAGE ? -1 : A.village[i],
            at: A.job[i], age: (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0,
            cause: A.deathCause[i], causeName: DEATH_NAMES[A.deathCause[i]],
            fade: 1 - (tick - dt) / FADE_DAYS,
          });
        }
        continue;
      }

      const months = A.ageMonths[i];
      const age = (months / C.MONTHS_PER_YEAR) | 0;
      sumAge += age;
      if (age >= 18) adults++; else children++;
      if (A.sex[i] === 1) women++;
      const st = A.state[i];
      if (st & ST_PREGNANT) pregnant++;
      if (st & ST_HUNGRY) hungry++;

      const v = A.village[i];
      const vi = vIndex.get(v);
      const job = A.job[i];
      // **身重の女は畑にも森にも出ない**（village.js がそう計算している）。
      // 画面が嘘をつかないよう、居場所も家に寄せる
      const at = (job !== AREA_HOME && (st & ST_PREGNANT)) ? AREA_HOME : job;
      // 名札は「いま何人そこに立っているか」を出す。描いた数と札の数が食い違うと、
      // 見て分かるという要件（A-19）がその場で嘘になる
      if (vi !== undefined) { villages[vi].byArea[at]++; villages[vi].byJob[job]++; }

      if (tooMany) continue;

      const h = A.house[i] === NO_HOUSE ? -1 : A.house[i];
      const hi = homeIndex.get(h);
      const blood = hueOfBlood(A.blood[i]);
      const mastery = masteryOf(P, i);
      const p = {
        i, h, v: v === NO_VILLAGE ? -1 : v,
        slot: hi !== undefined ? homes[hi].slot : -1,
        job, at, jobName: AREA_NAMES[job],
        sex: A.sex[i], age, months,
        hue: blood.hue, pure: blood.pure, lines: blood.lines,
        mastery, cells: cellsOf(mastery), rings: ringsOf(age),
        grow: Math.min(1, months / (26 * C.MONTHS_PER_YEAR)),   // 大きさ＝年齢（ピーク26歳）
        pregnant: !!(st & ST_PREGNANT),
        hungry: !!(st & ST_HUNGRY),
        sick: !!(st & ST_SICK),
        nursing: !!(st & ST_NURSING),
        newborn: tick - A.birthTick[i] <= FADE_DAYS,
        head: hi !== undefined && homes[hi].head === i,
        working: age >= WORK_START_AGE[A.rank[i]],
      };
      folk.push(p);
      if (hi !== undefined) homes[hi].members.push(folk.length - 1);
    }

    const v0 = villages[0] || null;
    const rationOn = tick < RATION_YEARS * C.DAYS_PER_YEAR;
    const bar = {
      tick,
      year: d.year, month: d.month, day: d.day,
      season: d.season, seasonName: d.seasonName, winter: d.winter,
      dateText: `${d.year}年${d.month}月${d.day}日`,
      pop, adults, children, women, pregnant, hungry,
      meanAge: pop ? sumAge / pop : 0,
      houses: w.houses.count, slots: HOUSES_PER_VILLAGE * Math.max(1, villages.length),
      food: v0 ? v0.food : 0,
      foodCap: v0 ? v0.foodCap : 0,
      produced: v0 ? v0.produced : 0,
      eaten: v0 ? v0.eaten : 0,
      ration: rationOn,
      rationLeftYears: Math.max(0, RATION_YEARS - C.yearOf(tick)),
      born: w.counters.born, died: w.counters.died,
      byCause: w.counters.byCause.slice(),
      blocked: w.counters.blocked,
      extinct: pop === 0,
    };

    this._snap = { tick, date: d, bar, villages, homes, folk, gone, tooMany };
    return this._snap;
  }

  _slot(h, v) {
    const rec = this.slotOf.get(h);
    if (rec && rec.v === v) return rec.slot;
    if (rec) this._freeSlot(h);
    let used = this.slotUsed.get(v);
    if (!used) { used = new Set(); this.slotUsed.set(v, used); }
    let s = 0;
    while (used.has(s)) s++;
    used.add(s);
    this.slotOf.set(h, { v, slot: s });
    return s;
  }
  _freeSlot(h) {
    const rec = this.slotOf.get(h);
    if (!rec) return;
    const used = this.slotUsed.get(rec.v);
    if (used) used.delete(rec.slot);
    this.slotOf.delete(h);
  }

  // ---- 個体票（A-7：オーナーは全部見える。数値ではっきりと） --------------
  /**
   * 一体ぶんの全部。104ステの 才能＋努力値＝実効値 と、伸びない理由まで返す。
   * クリックしたときだけ呼ぶ（104本ぶん作るので毎フレームは呼ばない）。
   */
  person(i) {
    const w = this.world, P = w.people, A = P.a, H = w.houses, HA = H.a, V = w.villages;
    if (i === undefined || i === null || i < 0 || i >= A.len) return null;

    const months = A.ageMonths[i];
    const age = (months / C.MONTHS_PER_YEAR) | 0;
    const h = A.house[i] === NO_HOUSE ? -1 : A.house[i];
    const v = A.village[i] === NO_VILLAGE ? -1 : A.village[i];
    const where = (v >= 0 && v < V.len) ? V.a.where[v] : 0;
    const blood = hueOfBlood(A.blood[i]);

    const states = [];
    for (const [bit, name] of STATE_NAMES) if (A.state[i] & bit) states.push(name);

    // **仕事と、いま立っている場所は別**。身重の女は畑にも森にも出ない
    const job = A.job[i];
    const at = (job !== AREA_HOME && (A.state[i] & ST_PREGNANT)) ? AREA_HOME : job;

    // 家族
    const children = [];
    for (let k = 0; k < A.len; k++) {
      if (A.mother[k] === i || A.father[k] === i) {
        children.push({ i: k, alive: !!A.alive[k], age: (A.ageMonths[k] / C.MONTHS_PER_YEAR) | 0 });
      }
    }

    // いまの仕事が、どのステをどれだけ使うか。表に無いステは 0（触りもしない）
    const jobArea = A.job[i];
    const jobW = new Float32Array(S.COUNT);
    for (const [s, w] of (AREA_STATS[jobArea] || AREA_STATS[AREA_HOME])) jobW[s] = w;
    const jobName = AREA_NAMES[jobArea];
    const whereName = WHERE_NAMES[where];
    const working = age >= WORK_START_AGE[A.rank[i]];

    // 104ステ。全部返す（オーナーは全部見える）
    const stats = [];
    for (let s = 0; s < S.COUNT; s++) {
      const talent = A.gene[s][i];
      const ev = A.ev[s][i];
      const deb = P.debuff(i, s);
      const ex = explain(P, i, s, where);
      const rarityRank = S.RARITY[s];

      // 伸びやすさ。総合 ＝ 仕事の重み × 場所の補正
      const w = jobW[s];
      const total = w * ex.place;
      // perMonth は閾値・伸びしろ・年齢減衰を通した「重み1のときの実際の伸び」。
      // これが0なら、仕事が何であろうと積まれない
      const growing = working && w > 0 && ex.perMonth > 0;
      const growth = !growing ? 'none' : (total >= GROW_FAST ? 'fast' : 'slow');

      // なぜそうなのかを、必ず言葉で添える（A-1：数字を出すなら意味を添える）
      let why;
      if (growth === 'none') {
        why = !working ? `まだ働く歳ではない（${WORK_START_AGE[A.rank[i]]}歳から）`
            : w <= 0 ? `${jobName}の仕事では、これを使わない`
            : ex.reason || 'このステは努力では積まれない';
      } else {
        // 判定を先に言う。総合が0.55なのに「追い風」だけ読ませると矛盾して見える
        const use = w >= 0.9 ? `${jobName}がよく使う` : w >= 0.6 ? `${jobName}がそこそこ使う` : `${jobName}は軽くしか使わない`;
        const dir = ex.place > 1 ? `${whereName}は追い風` : ex.place < 1 ? `${whereName}は向かい風` : `${whereName}は関係なし`;
        why = `${growth === 'fast' ? 'よく伸びる' : '伸びにくい'}（${total.toFixed(2)}）　`
            + `${use}（重み${w.toFixed(1)}）× ${dir}（${ex.place.toFixed(2)}）`;
      }

      stats.push({
        s, name: S.NAME[s],
        cat: S.CATEGORY[s], catName: S.CATEGORIES[S.CATEGORY[s]],
        sub: S.SUBCATEGORIES[S.SUB[s]],
        rarity: S.RARITY_LEVELS[rarityRank], rarityRank,
        has: possesses(rarityRank, talent),
        chromosome: S.CHROMOSOME[s], arm: S.armOf(s),
        talent, ev, debuff: deb, eff: (talent + ev) * deb,
        threshold: ex.threshold, canTrain: ex.passesThreshold,
        reason: ex.reason, perMonth: ex.perMonth * w,
        jobWeight: w, place: ex.place, growTotal: total, growth, why,
      });
    }
    const shown = stats.filter(s => s.has);
    const top = shown.slice().sort((a, b) => b.eff - a.eff).slice(0, 8);

    const mastery = masteryOf(P, i);
    return {
      i,
      alive: !!A.alive[i],
      deathTick: A.deathTick[i],
      deathCause: A.deathCause[i], deathCauseName: DEATH_NAMES[A.deathCause[i]],
      age, months,
      sex: A.sex[i], sexName: SEX_NAMES[A.sex[i]],
      rank: A.rank[i], rankName: RANK_NAMES[A.rank[i]],
      job, jobName: AREA_NAMES[job],
      at, atName: AREA_NAMES[at],
      village: v, whereName: WHERE_NAMES[where],
      house: h, isHead: h >= 0 && HA.head[h] === i,
      houseSize: h >= 0 ? HA.size[h] : 0,
      houseGen: h >= 0 ? HA.gen[h] : 0,
      lifespan: A.lifespan[i],
      baseLifespan: baseLifespanOf(P, i),
      vitality: A.vitality[i],
      scar: A.scar[i],
      generation: A.gen[i],
      blood: A.blood[i], hue: blood.hue, pure: blood.pure, lines: blood.lines,
      states,
      spouse: A.spouse[i] === NO_ONE ? -1 : A.spouse[i],
      mother: A.mother[i] === NO_ONE ? -1 : A.mother[i],
      father: A.father[i] === NO_ONE ? -1 : A.father[i],
      births: A.births[i],
      children,
      mastery, cells: cellsOf(mastery), rings: ringsOf(age),
      stats, top, statsHidden: stats.length - shown.length,
      jobWeights: jobW,
      bodyDebuff: P.debuff(i, 0),
    };
  }

  /** 家1軒ぶん */
  house(h) {
    const w = this.world, H = w.houses, HA = H.a, P = w.people, A = P.a;
    if (h === undefined || h === null || h < 0 || h >= HA.len || !HA.alive[h]) return null;
    const members = [];
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i] || A.house[i] !== h) continue;
      members.push({
        i, age: (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0,
        sex: A.sex[i], sexName: SEX_NAMES[A.sex[i]],
        job: A.job[i], jobName: AREA_NAMES[A.job[i]],
        head: HA.head[h] === i,
      });
    }
    members.sort((a, b) => b.age - a.age);
    return {
      h, v: HA.village[h], slot: this.slotOf.get(h)?.slot ?? -1,
      size: HA.size[h], gen: HA.gen[h], line: HA.line[h],
      founded: HA.founded[h], foundedText: C.formatDate(HA.founded[h]),
      head: HA.head[h], mate: HA.mate[h],
      members,
    };
  }

  // ---- 収束計（A-14。開発用UIに隔離する） --------------------------------
  converge() { return convergeOf(this.world); }
  memory() {
    const b = this.world.people.bytesPerRow();
    return { bytesPerRow: b, mbAt100k: b * 1e5 / 1e6, rows: this.world.people.len };
  }
  /** 「これは初めてか」の一覧。逐次チュートリアルの合図（A-10） */
  firsts() { return [...this.world.firsts]; }
}

export function start(opts = {}) { return new Run(opts); }
