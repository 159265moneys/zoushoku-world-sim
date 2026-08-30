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
  DEATH_COUNT, DEATH_HUNGER, DEATH_BIRTH, titleStep, KIN_NAMES, SECT_NONE, KIN_WAR,
} from './people.js';
import { Houses } from './house.js';
import {
  Villages, WHERE_FRONTIER, HOUSES_PER_VILLAGE,
  assignWork, produceAndEat, syncHouses, AREA_HOME, AREA_FIELD, EAT_ADULT,
  drawHarvest, HARVEST_HARSH, HARVEST_POOR,
} from './village.js';
import { growMonth, seedEffortForAge } from './grow.js';
import { widow, marryMonth, conceiveMonth, birthDay, nursingMonth } from './marry.js';
import { foundGenome, targetsFrom } from './genetics.js';
import * as COND from './condition.js';   // 状態12個（第7部 §1）
import * as DESIRE from './desire.js';    // 欲7つ（#3）
import * as REP from './reputation.js';   // 評判（#6-A）
import * as DIS from './discontent.js';   // 不満6本・恨み6本（第7部 §2・#4）
import * as OFF from './office.js';       // 身分・爵位・役職（#10）
import { Ties, W as TIE_W, T_BLOOD, T_LAND } from './ties.js';
import * as TIES from './ties.js';   // しがらみ（正典3-2）
import * as DIS9 from './disaster.js';   // 厄災（#9・正典3-7）
import * as SECT from './sect.js';       // 宗派（正典3-6・#6-C・#8）
import * as WAR from './war.js';         // 戦争（O-27）
import * as HER from './heresy.js';      // 異端狩り（#7）
import * as FAC from './faction.js';     // 派閥（正典3-3）
import * as NEAR from './near.js';       // 近い順3村（#11-D・#11-F）
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
    this._dirTmp = new Float64Array(6);      // 配分の受け皿（毎月10万人ぶん回るので確保しない）
    this.harvest = 1.0;                      // その年の作柄（正典3-7。年の頭に引き直す）
    this._tieN = new Int32Array(opts.cap ?? 256);   // つながりの数の受け皿（使い回す）
    this.cal = new DIS9.Calamity(8);                // 厄災の台帳（#9-D の族・#9-E の r）
    this.sects = new SECT.Sects(16);                // 宗派の台帳（正典3-6・#6-C）
    this.script = new DIS9.Script();                // 確定イベント（9-B）の進行
    this.inq = new HER.Inquisition();               // 異端審問会（#7）
    this.foreignSect = 0;                           // 異国の宗派（捕虜が入る日に1つだけ作る）
    this.near = null;                               // 近い順3村（分村のたびに数え直す）
    this.marryPressure = 0;                         // 婚姻圧カード（民生局・既定0）
    // 0番（地形）は mapgen が自前で立てるので、ここでは番号を予約しているだけ
    this.tick = 0;
    this.people = new People(opts.cap ?? 256);
    this.houses = new Houses(64);
    this.villages = new Villages(4);
    // ★ しがらみは別の配列（0-3e）。1人あたり上位20本だけ持つ
    this.ties = new Ties(opts.cap ?? 256);
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
      seated: 0,                            // 席に座った回数（#10）
      pressure: 0,                          // 日常の基底圧の合計（#3 の ΣX）
      // ---- 厄災（#9）----
      storms: 0, plagues: 0, fires: 0, beasts: 0,
      shock: 0,                             // 厄災の X の合計（⑤の溜め池の入口）
      // ---- 宗派（#8）----
      sectsFounded: 0, sectsDissolved: 0, converted: 0,
      // ---- 戦争（O-27）----
      wars: 0, warDead: 0, warKills: 0, warFled: 0, warWon: 0,
      // ---- 異端狩り（#7）----
      warned: 0, exiled: 0, burned: 0, misfired: 0,
      captives: 0, refused: 0,
      warByStat: 0, warByLuck: 0, ennobled: 0,
      zealots: 0, resigned: 0, apostates: 0,
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
    const t = this.tick, P = this.people;
    P.tickNow = t;                // 妊娠・産後の「段」を出すのに要る（第7部 §1）
    const b = birthDay(this.people, this.houses, this.villages, t,
                       this.R[STREAM.BIRTH], this.R[STREAM.GIFT]);
    if (b.born) {
      this.counters.born += b.born;
      if (this.once('birth')) this.note('初めての子', `${b.born}人`);
    }
    // 血縁の線（正典3-3 の派閥の線の1位）。生まれた子と、親・きょうだい
    // ★ きょうだいは母の20枠から引く（全走査しない。#15）
    for (const c of b.babies) {
      const A = P.a, m = A.mother[c], f = A.father[c];
      if (m >= 0) this.ties.linkBoth(c, m, TIE_W.親子, T_BLOOD, C.monthOf(t));
      if (f >= 0) this.ties.linkBoth(c, f, TIE_W.親子, T_BLOOD, C.monthOf(t));
      if (m >= 0) {
        const TA = this.ties.a;
        for (let k = 0; k < 20; k++) {
          const j = TA.to[k][m];
          if (j < 0 || j === c || !A.alive[j]) continue;
          if (A.mother[j] === m) this.ties.linkBoth(c, j, TIE_W.きょうだい, T_BLOOD, C.monthOf(t));
        }
      }
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

    // ★ 近い順3村（#11-D・#11-F・#11-G の土台）。村は動かないので、
    //   村数が変わったときだけ数え直す。結婚も疫病の伝播もここを読む
    if (!this.near || this.near.n !== V.a.len) {
      this.near = { ...NEAR.nearest(V, this.land), n: V.a.len };
    }

    const d = agingAndDeath(P, t, this.R[STREAM.DEATH]);
    this.counters.died += d.died;
    // 喪（一時12）。★ 乱数を1つも引かない。死んだ者の近親をなめるだけ
    this.counters.mourned += COND.mourn(P, d.dead);
    for (let k = 0; k < d.byCause.length; k++) this.counters.byCause[k] += d.byCause[k];
    if (d.byCause[DEATH_HUNGER] > 0 && this.once('hunger-death')) this.note('最初の餓死', '永久に戻らない');

    // ---- 厄災（#9・正典3-7）。★ ①の直後・②の前。厄災の死者も「喪」の入力になる ----
    //   嵐は**年の収穫係数に一切触れない**（#9-A）。殴るのは蔵と家であって、流れではない
    this.cal.grow(V.a.len);
    // ---- #11-F 疫病の村間伝播。★ 距離を締める（exp(−d/1.5)）----
    //   線の数 ＝ その2村のあいだの**村をまたぐ婚姻の本数**（生きている夫婦のみ）。
    //   ★ 線の数が0の村へは飛ばない ── 「広く薄く散らばった国は届きにくい／
    //     密集して婚姻の線が濃い国は速い」が距離で初めて分かれる
    const sickV = new Int32Array(V.a.len);
    for (let i = 0; i < P.a.len; i++) {
      if (P.a.alive[i] && P.a.sickStage[i] >= DIS9.PLAGUE_STAGE) {
        const vv = P.a.village[i];
        if (vv < V.a.len) sickV[vv]++;
      }
    }
    const cross = this._crossLines(P, V);
    const dz = DIS9.disasterMonth(P, V, H, t, this.R[STREAM.DISASTER],
      (i, X, set) => this.shock(i, X, set),
      (v) => {
        let p = 0;
        for (let k = 0; k < NEAR.NEAR; k++) {
          const a = this.near.near[v * NEAR.NEAR + k];
          if (a < 0 || !sickV[a]) continue;
          p += NEAR.spreadP(this.near.dist[v * NEAR.NEAR + k], cross[v * NEAR.NEAR + k]);
        }
        return p;
      });
    if (dz.dead > 0) {
      this.counters.died += dz.dead;
      this.counters.byCause[DIS9.DEATH_ACCIDENT] += dz.dead;
    }
    this.counters.storms += dz.storms; this.counters.plagues += dz.plagues;
    this.counters.fires += dz.fires;   this.counters.beasts += dz.beasts;
    if (dz.storms && this.once('storm')) this.note('嵐', '蔵が3割持っていかれた');
    if (dz.plagues && this.once('plague')) this.note('疫病', '村の4分の1が伏せた');

    // 死因を**村ごと**に数える（正典 9-D の残作業「byCause を村ごとに持つ」）
    for (const i of d.dead) this.cal.count(P.a.village[i], P.a.deathCause[i]);
    for (const i of dz.deadList) this.cal.count(P.a.village[i], P.a.deathCause[i]);
    this.counters.mourned += COND.mourn(P, dz.deadList);

    widow(P);
    H.recount(P, t);
    const newHeads = H.succeed(P, H.index(P));
    for (const { heir, from } of newHeads) {
      REP.award(P, heir, REP.REP_EVENT.家督を継いだ);           // 評判 +8（#6-A）
      DIS.relieveSelf(P, heir, DIS.SELF_RELIEF.家督);           // 不満④ −12（#5 §4）
      OFF.inherit(P, heir, from, t);   // 身分の世襲（#10-F）。役職は世襲しない
    }
    syncHouses(V, H);
    assignWork(P, V, t);

    // 席の生成と任命（#10-D ＋ B-15）。★ 軒数が確定してから。乱数を1回も引かない
    const off = OFF.officeMonth(P, V, H, t);
    this.counters.seated += off.seated;
    this.counters.ennobled += off.ennobled;
    if (off.seated > 0 && this.once('headman')) this.note('最初の村長', '10軒目が建った');

    if (this.land) this.land.fogMonth(V.len);
    const food = produceAndEat(P, V, t, this.land, this.harvest);
    for (const r of food) {
      if (r && r.shortage > 0 && this.once('hunger')) this.note('最初の飢え', '作る量が食べる量に届かない');
    }

    // ---- 族の判定（#9-D）。★ ⑤の直後。蔵と飢えが確定してから。1月1族 ----
    //   ここで村ごとの死者率 r（#9-E）も確定する。宗派（#8）が入る日にそのまま読む
    this.cal.close(V, t, C.monthOf(t));

    // ---- 戦争（O-27）。★ 厄災の直後・族の判定の前。戦死も族「兵」の入力になる ----
    //   正典3155「敵からの宣戦は来る」。ヘッドレスでも戦は向こうから来る
    const wr = WAR.warMonth(P, this.population(), t, this.R[STREAM.BATTLE], (i) => {
      // 家族が戦死（正典3-2 の出来事表 X=25／10）。★ 恨みではなく不満へ
      const m = P.a.mother[i], f = P.a.father[i], sp = P.a.spouse[i];
      for (const k of [m, f, sp]) {
        if (k >= 0 && k < P.a.len && P.a.alive[k]) this.shock(k, 25, DIS9.S_GOD_RULE);
      }
    });
    if (wr.fought) {
      this.counters.wars++; this.counters.warDead += wr.dead;
      this.counters.warKills += wr.kills; this.counters.warFled += wr.fled;
      this.counters.warWon += wr.won;
      this.counters.warByStat += wr.byStat; this.counters.warByLuck += wr.byLuck;
      this.counters.byCause[8] += wr.dead;
      // ★ 数えるのは**戦死した者だけ**。生きている全員を数えると村の台帳が壊れる
      for (const i of wr.deadList) if (P.a.village[i] !== 0xFFFF) this.cal.count(P.a.village[i], 8);
      this.counters.mourned += COND.mourn(P, wr.deadList);   // 戦死も「喪」の入力になる

      // ---- 捕虜（正典 4-5・4-6）。★ 勝ったときだけ。負ければこちらが取られる ----
      //   **外から血は入らない。入るのは捕虜だけ。**
      if (wr.won) {
        if (!this.foreignSect) {
          // 異国の宗派を1つだけ作る（自国に存在しない宗派は全部これ1つに畳む・#8 §9）
          const d = new Float64Array(SECT.AXES.length).fill(50);
          this.foreignSect = this.sects.create(KIN_WAR, 0, -1, t, d);
        }
        // 置き先は国境の村（辺境）。無ければ人口が最小の村
        const frontier = [];
        let small = -1, smallN = Infinity;
        for (let v = 0; v < V.a.len; v++) {
          if (!V.a.alive[v]) continue;
          if (V.a.where[v] === WHERE_FRONTIER) frontier.push(v);
          if (V.a.pop[v] < smallN) { smallN = V.a.pop[v]; small = v; }
        }
        let fi = 0;
        const cp = WAR.takeCaptives(
          P, Math.floor(wr.kills * WAR.CAPTIVE_SHARE), t, this.R[STREAM.BATTLE],
          () => P.spawn(t),
          () => (frontier.length ? frontier[fi++ % frontier.length] : small),
          (v) => {
            // その村で信者が最も多い宗派の排他性
            const cnt = new Map();
            for (let i = 0; i < P.a.len; i++) {
              if (!P.a.alive[i] || P.a.village[i] !== v || !P.a.sect[i]) continue;
              cnt.set(P.a.sect[i], (cnt.get(P.a.sect[i]) ?? 0) + 1);
            }
            let bs = 0, bn = 0;
            for (const [sx, nn] of cnt) if (nn > bn) { bn = nn; bs = sx; }
            return bs ? this.sects.ax(bs, '排他性') : 0;
          },
          this.inq.alive, this.foreignSect);
        this.counters.captives += cp.taken;
        this.counters.refused += cp.refused;
        if (cp.taken && this.once('captive')) this.note('最初のよそ者', '血。混ざる');
      }
      if (this.once('war')) this.note('最初の戦', `団結が折れる。戦死は戻らない（${wr.won ? '勝ち' : '負け'}・戦死${wr.dead}）`);
    }

    // ---- 確定イベント（9-B）。★ 族は台帳で決め打ちなので 9-D の上書きになる ----
    //   これが無いと宗教が一度も起きない（平常の門 T_i=35 に未叙爵の村長 33.3 が届かない）
    const sc = DIS9.scriptedEvent(P, V, H, this.population(), t, this.script,
      this.R[STREAM.DISASTER], (i, X, set) => this.shock(i, X, set));
    if (sc.kind === 1) this.note('導入の嵐', '死者は出ない。厄災という種類のものがある、とだけ教える');
    if (sc.kind === 2) this.note('フェーズ2の疫病', '人口100人。ここで最初の宗教が起きる');


    // ---- 宗教（#6-C）。★ 族と死者率が確定した直後。乱数は宗教のストリーム（8番）----
    //   正典3-6「信心が高い × 影響力がある × 大きな災いの直後」かつ
    //   「なぜ起きたのかに誰も答えられていない状態で、答えを出せる者が現れる」
    const fnd = SECT.foundMonth(P, V, this.sects, this.cal, t, this.R[STREAM.RELIGION],
      (v) => this.script.kinAt(v, t));
    if (fnd.founded) {
      this.counters.sectsFounded += fnd.founded;
      if (this.once('sect')) {
        const id = fnd.ids[0], SA = this.sects.a;
        this.note('最初の宗教', `起源＝${KIN_NAMES[SA.origin[id]]}・村${SA.village[id]}`);
      }
    }
    this.counters.sectsDissolved += SECT.sectMonth(P, this.sects).dissolved;

    // ---- 信仰の月次（#8 §4・§6・§7）。faith → ⑤の出口 → 伝播 の順 ----
    //   ★ 祭祀局長はまだ居ないので後押しは無い（局が入る日に chiefSect を渡す）
    const bl = SECT.beliefMonth(P, V, this.sects, this.ties, t, this.R[STREAM.RELIGION]);
    this.counters.zealots += bl.zealots; this.counters.resigned += bl.resigned;
    this.counters.apostates += bl.apostates; this.counters.converted += bl.converted + bl.joined;
    if (bl.zealots && this.once('zealot')) this.note('最初の狂信者', '⑤は③へ返らず①へ向かう');
    if (bl.apostates && this.once('apostate')) this.note('最初の棄教', '⑤の4割が恨み③へ移った');
    // 継承（#8 §5）。★ 7歳の誕生月に1回だけ。信仰は血ではなく育ちで伝わる
    SECT.inheritMonth(P, this.R[STREAM.RELIGION]);

    // ---- 異端狩り（#7）。★ 信仰が確定した直後。乱数は犯罪のストリーム（9番）----
    //   祭祀局と刑務局が両方座り、正統宗派の信仰性≥75・硬さ≥50 が24ヶ月続いて初めて生える
    const hz = HER.heresyMonth(P, this.sects, this.inq, t, this.R[STREAM.CRIME]);
    if (hz.warned || hz.exiled || hz.burned) {
      this.counters.warned += hz.warned; this.counters.exiled += hz.exiled;
      this.counters.burned += hz.burned; this.counters.misfired += hz.misfired;
      this.counters.byCause[9] += hz.burned;
      if (hz.burned && this.once('burn')) this.note('最初の焚刑', '焼く教団は、焼かれた者から生まれる');
      if (this.once('inquisition')) this.note('異端審問会', `正統＝宗派${hz.star}・厳格さ${hz.hs.toFixed(0)}・激しさ${hz.hv.toFixed(0)}`);
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

    // ④の出口（#5 §4）。いま供給源が在るのは 初就労・子が1歳・60歳以降 の3つ
    //（役職 −25×ΔQ・叙爵 −10×ΔP・戦功 −8 は、その仕組みが入る日に生きる）
    for (let i = 0; i < P.a.len; i++) {
      if (!P.a.alive[i]) continue;
      if (P.a.job[i] !== AREA_HOME && !(P.a.disOnce[i] & DIS.ONCE_FIRST_JOB)) {
        P.a.disOnce[i] |= DIS.ONCE_FIRST_JOB;
        DIS.relieveSelf(P, i, DIS.SELF_RELIEF.初就労);          // 一生に1度
      }
      const am = P.a.ageMonths[i];
      if (am === 12) {                                          // その子が1歳を越えた
        for (const p of [P.a.mother[i], P.a.father[i]]) {
          if (p >= 0 && p < P.a.len && P.a.alive[p]) DIS.relieveSelf(P, p, DIS.SELF_RELIEF.子が1歳);
        }
      }
      if (am % 12 === 0 && am / 12 >= DIS.RELIEF_OLD_AGE) {
        DIS.relieveSelf(P, i, DIS.SELF_RELIEF.長寿);            // 60歳の誕生月から毎年
      }
    }

    // 地縁（正典3-2「同じ村で育った／同じエリアで働いた ＝ 年数に比例して小さく＋」）。
    // ★ 毎年・**既に線がある相手だけ**（#8 §8 と同じ形）。全員に張ると O(n²) になる
    if (C.monthOf(t) % C.MONTHS_PER_YEAR === 0) {
      if (this.land) this.land.fogYear();      // 霧の経過年数を1つ進める（#17 §6-6）
      // ★ その年の作柄を引く（正典3-7）。厄災のストリーム（6番）なので他の11本は動かない
      this.harvest = drawHarvest(this.R[STREAM.DISASTER]);
      // 等級 g と 平民の段（村内の財の五分位）。#10-B・#10-C。乱数を引かない
      const qv = new Map();
      {
        const byV = new Map();
        for (let i = 0; i < P.a.len; i++) {
          if (!P.a.alive[i]) continue;
          const v = P.a.village[i];
          if (v === 0xFFFF) continue;
          (byV.get(v) ?? byV.set(v, []).get(v)).push(i);
        }
        for (const [, list] of byV) {
          list.sort((a, b) => P.a.wealth[a] - P.a.wealth[b] || a - b);
          for (let k = 0; k < list.length; k++) {
            qv.set(list[k], Math.min(4, Math.floor(k * 5 / Math.max(1, list.length))));
          }
        }
      }
      OFF.officeYear(P, t, (i) => qv.get(i) ?? 0);
      // ★ 厳冬 X=8 S={⑤}／凶作 X=5 S={⑤,③}（正典 2384-2385）。⑤の生涯到達値の主柱
      DIS9.harvestX(P, this.harvest, (i, X, set) => this.shock(i, X, set));
      if (this.harvest < HARVEST_HARSH && this.once('harsh')) this.note('厳冬', `作柄 ${this.harvest.toFixed(2)}`);
      else if (this.harvest < HARVEST_POOR && this.once('poor')) this.note('凶作', `作柄 ${this.harvest.toFixed(2)}`);
      const TA = this.ties.a, mon = C.monthOf(t);
      // 村ごとに、生きている12歳以上を並べる（決定的な順）
      const byV = new Array(V.a.len);
      for (let i = 0; i < P.a.len; i++) {
        if (!P.a.alive[i] || (P.a.ageMonths[i] / 12 | 0) < 12) continue;
        const v = P.a.village[i];
        if (v >= V.a.len) continue;
        (byV[v] ||= []).push(i);
      }
      for (let i = 0; i < P.a.len; i++) {
        if (!P.a.alive[i]) continue;
        this.ties.dropDead(P, i);
        const v = P.a.village[i];
        const list = v < V.a.len ? byV[v] : null;
        if (!list) continue;
        // ★ 既にある線を太らせる ＋ 空いている枠を同じ村の者で埋める。
        //   「すでに線がある相手だけ」にすると、地縁が血縁を太らせるだけになり、
        //   村の顔なじみと線が1本も張られない（＝つながりが伸びず影響力が門に届かない）
        for (const j of list) {
          if (j === i) continue;
          if (this.ties.slot(i, j) < 0) {
            let empty = false;
            for (let k = 0; k < 20; k++) if (TA.to[k][i] < 0) { empty = true; break; }
            if (!empty) continue;                    // 枠が満杯なら新しい顔なじみは作らない
          }
          this.ties.link(i, j, TIE_W.地縁, T_LAND, mon);
        }
      }
      // 信仰が好き嫌いに乗る（#8 §8）。★ 既に線がある相手だけ。40年で最大 ±20。
      //   相性（25〜50）と同じ桁になるので、**信仰が派閥の線に乗る**
      SECT.beliefYear(P, this.sects, this.ties, t);

      // 派閥（正典3-3）。★ 手で作らない。**線が密になっている塊を数え直すだけ。**
      //   信仰が線に乗った**直後**に数える（宗派が派閥の形を変えるので）
      const fa = FAC.factionYear(P, this.ties);
      this.counters.factions = fa.count;
      this.counters.biggestFaction = fa.biggest;
      if (fa.count && this.once('faction')) this.note('派閥', `${fa.count}個。最大${fa.biggest}人`);
    }

    // 評判（#6-A）。風化と、供給源が在る出来事（子を5人育てた・60歳まで生きた）
    REP.reputationMonth(P, t);

    // 影響力（#6-B）。★ 評判が確定した直後。乱数を1回も引かない
    //   つながりの数は**前向きに1周**して数える（村内総当たりだと10万人で3.8秒／月かかる）
    if (this._tieN.length < P.a.len) this._tieN = new Int32Array(P.a.len * 2);
    TIES.countIncoming(P, this.ties, this._tieN);
    for (let i = 0; i < P.a.len; i++) {
      if (!P.a.alive[i]) continue;
      const n = this._tieN[i];
      P.a.tieN[i] = n > 65535 ? 65535 : n;
      P.a.infl[i] = REP.influence(P.a.rep[i], titleStep(P.a.rank[i]), P.a.post[i], Ties.point(n));
    }

    // 不満と恨みの薄れ（#4-(c)）。生存者・12歳以上だけ。⑤は薄れない（溜め池）
    for (let i = 0; i < P.a.len; i++) {
      if (!P.a.alive[i] || (P.a.ageMonths[i] / 12 | 0) < 12) continue;
      DIS.clearDeadTargets(P, i);        // 相手が死ねば その枠だけ0（正典3-5）
      DIS.decayMonth(P, i);
    }
    // ★ 戦争の無かった年の年末に ⑥ −6点。戦争はまだ無いので毎年落ちる
    if (C.monthOf(t) % C.MONTHS_PER_YEAR === C.MONTHS_PER_YEAR - 1) {
      for (let i = 0; i < P.a.len; i++) if (P.a.alive[i]) DIS.yearEndPeace(P, i);
    }

    // 欲7つ（#3）。X_k ＝ その月の日常の基底圧。#4 の配分へ流す
    // ★ 国民力の合計は嫉妬の順位に要る。月に1度だけ引き直す
    for (let i = 0; i < P.a.len; i++) if (P.a.alive[i]) P.a.civicSum[i] = COND.civicTotal(P, i);
    const eatenRatio = [];
    for (const r of food) eatenRatio.push(r && r.demand > 0 ? r.eaten / r.demand : 1);
    DESIRE.desireMonth(P, V, t, {
      eatAdult: EAT_ADULT,
      workDaysOf: (i) => (P.a.job[i] === AREA_HOME ? 0 : 30),
      intakeOf: (i) => {
        const v = P.a.village[i];
        const need = ((P.a.ageMonths[i] / 12) | 0) >= 12 ? EAT_ADULT : 0.5;
        return need * (eatenRatio[v] ?? 1);
      },
      onX: (i, X) => { this.pressure(i, X); },
    });

    growMonth(P, V, t);

    const nearOf = (v, k) => this.near.near[v * NEAR.NEAR + k];
    const m = marryMonth(P, H, V, t, this.R[STREAM.MARRY], nearOf, this.ties, this.marryPressure);
    for (const c of m.couples ?? []) {
      DIS.relieveSelf(P, c[0], DIS.SELF_RELIEF.結婚);           // 不満④ −15（#5 §4）
      DIS.relieveSelf(P, c[1], DIS.SELF_RELIEF.結婚);
      this.ties.linkBoth(c[0], c[1], TIE_W.伴侶, T_BLOOD, C.monthOf(t));   // 伴侶の線（正典3-2）
    }
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
  /**
   * その月の日常の基底圧（#3 の X_k）を受け取る。
   * ★ #4「向きへの配分」が入るまでは、合計だけ数えて捨てている。
   *   6本の不満へ割るのは #4 の allocate の仕事（正典 第7部 §2）
   */
  pressure(i, X) {
    const P = this.people, out = this._dirTmp;
    for (let d = 0; d < DIS.DIR_COUNT; d++) out[d] = 0;
    let sum = 0;
    for (let k = 0; k < X.length; k++) {
      if (X[k] <= 0) continue;
      sum += X[k];
      // ★ 日常は t=0（相手がいない）。だから ① には1点も入らない。
      //   これが「①②⑤の定常値が0」の理由であり、全員が①で100に張り付かない唯一の防波堤
      DIS.allocate(P, i, X[k], DIS.DESIRE_S[k], 0, DIS.DESIRE_GATE[k], out);
    }
    // ★ ④だけ月0.80点で頭打ち（#5 §3）。**超えた分は捨てる。他の向きへは回さない**
    //   （他責の門はもう通過済みなので、④からあふれた分に行き先が無い）
    //   これが「独身で無役の者が100に張り付く」を構造的に止めている本体
    if (out[DIS.D_SELF] > DIS.SELF_DAILY_CAP) out[DIS.D_SELF] = DIS.SELF_DAILY_CAP;
    // ★ 日常は**不満**にしか入らない。恨みには一切入らない（#4-(b)）
    for (let d = 0; d < DIS.DIR_COUNT; d++) if (out[d] > 0) DIS.addDiscontent(P, i, d, out[d]);
    this.counters.pressure += sum;
  }

  /**
   * 厄災の圧（#9 の X 表）。★ 日常（pressure）と同じ段を通す。
   *   違うのは S を欲ではなく厄災が名指しすること（正典 6683「割り振りは項目2の配分に従う」）。
   * ★ t=0（下手人がいない）。だから火災の S={⑤,①} は allocate が①を落として⑤へ回す
   * ★ ④の月0.80の頭打ち（#5 §3）は日常ぶんと**共有しない**。
   *   厄災は「日常の基底圧」ではないので、#5 §3 の「日常の④は月0.80まで」に含めない
   */
  shock(i, X, set) {
    const P = this.people, out = this._dirTmp;
    for (let d = 0; d < DIS.DIR_COUNT; d++) out[d] = 0;
    DIS.allocate(P, i, X, set, 0, DIS.GATE_ON, out);
    for (let d = 0; d < DIS.DIR_COUNT; d++) if (out[d] > 0) DIS.addDiscontent(P, i, d, out[d]);
    this.counters.shock += X;
  }

  /**
   * 村をまたぐ婚姻の本数（#11-F の「線の数」）。★ 近い順3村ぶんだけ持てばよい ──
   * 11-D により村外婚は必ず「近い順3村」の相手なので、3枠で漏れなく数え切れる。
   */
  _crossLines(P, V) {
    const nv = V.a.len, out = new Int32Array(nv * NEAR.NEAR);
    if (!this.near) return out;
    const A = P.a;
    for (let i = 0; i < A.len; i++) {
      const sp = A.spouse[i];
      if (!A.alive[i] || sp < 0 || i > sp || !A.alive[sp]) continue;
      const a = A.village[i], b = A.village[sp];
      if (a === b || a >= nv || b >= nv) continue;
      for (let k = 0; k < NEAR.NEAR; k++) {
        if (this.near.near[a * NEAR.NEAR + k] === b) out[a * NEAR.NEAR + k]++;
        if (this.near.near[b * NEAR.NEAR + k] === a) out[b * NEAR.NEAR + k]++;
      }
    }
    return out;
  }

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
