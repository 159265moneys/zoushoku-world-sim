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
  DEATH_COUNT, DEATH_HUNGER, DEATH_BIRTH, titleStep, KIN_NAMES, SECT_NONE, KIN_WAR, BUREAUS, RANK_NAMES as PEOPLE_RANK_NAMES, TOWN_VILLAGES, POST_NAMES} from './people.js';
import { Houses } from './house.js';
import {
  Villages, WHERE_FRONTIER, HOUSES_PER_VILLAGE,
  assignWork, produceAndEat, syncHouses, AREA_HOME, AREA_FIELD, AREA_BUILD, EAT_ADULT,
  AREA_YIELD_STATS, Q_DIVISOR,
  drawHarvest, STORE_PER_HOUSE, HARVEST_HARSH, HARVEST_POOR,
  BEAR_HURT, BEAR_DEAD, MID_HURT,          // 熊と鹿猪の負傷（#17 §5-2）
  AREA_SCOUT, AREA_FOREST,                 // 斥候の職域（#17 §6-8）／森
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
import * as NEAR from './near.js';
import * as WK from './works.js';        // 工事（#17 §4-2/§4-3）
import * as SCOUT from './scout.js';     // 斥候（#17 §6-8・正典9540）
import { Chronicle, EV, NO_VILLAGE16 } from './chronicle.js';   // 年代記と因果の台座（正典3-9）
import * as NAT from './nation.js';      // 国の段（フェーズ＝喪失）と国力（正典1-5・4-3）
import { defaultRoster } from './roster.js';   // 10国のライバル・ロスター（正典1-1c）
import * as PARCEL from './parcel.js';  // 区画の役割16種（#17 §4-1）
import * as LAND from './land.js';      // 区画の定員（CAP_FIELD）       // 近い順3村（#11-D・#11-F）
import * as PLAN from './plan.js';       // 具申と差し止め（#14）
// ★ 動詞「呼ぶ」の代金（正典4084-4087）。1点も足していない
const SUMMON_INFL = 8.33, SUMMON_L = 8, SUMMON_ENVY = 0.119;
const ID_PRIDE_W = S.needId('誇り');
import * as CARD from './cards.js';      // 方針カード（つまみ・#18 §1）
// ★ 地図（#17）。**2026-08-30 から既定でオン。**
//   #11-D 結婚の範囲・#11-F 疫病の村間伝播・#11-G 備蓄の融通 は3つとも「村の距離」を読み、
//   距離は村の座標にしかない。地図が無いと3つとも黙って何もしない（死にコードになる）。
//   ★ 実測（120年・60種）：地図の有無で基準線が動かない ──
//     絶滅率 26.7% で同じ、平均人口 30.8 vs 30.4、村数 1.1 で同じ。融通だけ 0→56。
//     120年の時点では村が1.1個なので距離がまだ効かず、畑の定員が縛るのは村が育ってから。
//   → **代金ゼロで3機構が生きるので、既定にした。**`{ map: false }` で今までどおりにもできる
import { generate as genMap } from './mapgen.js';
import { pickSeat, guarantee, enrich } from './seat.js';
import { expand as expandParcels } from './parcel.js';
import { Land } from './land.js';
import { PPL } from './settle.js';

// ★ 分村が持っていく畑の枚数（B-39・2026-08-31）。
//   正典8810 は「分村が作る最初の**拠点地**区画だけは 11-B が直接書き込む」としか書いておらず、
//   **娘村の畑を決めていない。**畑ゼロで出すと定員0 ＝ 畑の産出が完全に0 になり、
//   狩りだけでは25人を養えず、世界が縮む（実測：平均人口 561 → 77）。
//   正典自身の数から導く ── 段2の標準村は **畑6枚／30軒**（正典9857）、11-C が移すのは **8軒**。
//   6 × 8/30 = 1.6 → **2枚**。「移った家がぶんの耕地を持っていく」という読み。
//   ★ 2026-08-31：`process.env` で読んでいた（掃引の名残）。**`process` は Node にしか無いので
//     ブラウザではモジュール評価の時点で落ち、画面が真っ黒になっていた。**掃引は終わって
//     2枚に決まっているので、ただの定数にする。**src に `process` を書かない。**
export const SPLIT_FIELDS = 2;
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
    // ★ #18 §1：つまみは段ごとに生え、既定は上から降りる（村 → 街 → 国）。
    //   ハードコードしていた摘みを、ここで正式なカードにした
    this.cards = new CARD.Cards();
    this.plans = new PLAN.Plans();                  // 予定の待ち行列（#14）
    this.works = new WK.Works();                    // 工事キュー（#17 §4-3・村ごと同時1件）
    this.scouts = new SCOUT.Scouts();               // 斥候（#17 §6-8）
    // ★ 年代記と因果の台座（正典3-9）。**先に作るのは UI ではなくデータ層。**
    //   追記型。何も捨てない。真の原因（cause）と公表された帰属（told）を別の欄で持つ
    this.chron = new Chronicle(256);
    // ★ 10国のライバル（ゴースト）。**走っている世界ではなく記録**（正典533）
    this.roster = defaultRoster();
    // ★ 村ごとの「直近の災いの事件ID」。産出低下と恨みの**真の原因**をここから引く
    this.lastBlow = [];
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
      storms: 0, plagues: 0, fires: 0, beasts: 0, floods: 0, fertRuined: 0,
      scoutsLost: 0, scoutsOut: 0, scoutTiles: 0,
      ownerActs: 0,          // ★ オーナーが撃った回数（動詞5つ）
      summoned: 0,           // ★ 呼んだ回数（正典4087）
      shock: 0,                             // 厄災の X の合計（⑤の溜め池の入口）
      // ---- 宗派（#8）----
      sectsFounded: 0, sectsDissolved: 0, converted: 0,
      // ---- 戦争（O-27）----
      wars: 0, warDead: 0, warKills: 0, warFled: 0, warWon: 0,
      // ---- 異端狩り（#7）----
      warned: 0, exiled: 0, burned: 0, misfired: 0,
      captives: 0, refused: 0,
      // ---- 派閥（正典3-3）／備蓄の融通（#11-G）----
      factions: 0, biggestFaction: 0, foodSent: 0, villagesFed: 0,
      // ---- 具申（#14）----
      plansRan: 0, plansSilent: 0, plansOverflow: 0, distortSum: 0,
      bears: 0, bearDead: 0,                // 熊（#17 §5-2）
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
    if (this.opts.map !== false) {
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
      // ★ 創世の村だけは 畑6枚（正典9857「段2の標準村は畑6＝定員42」）＋拠点地1枚。
      //   分村は拠点地だけ（正典8810）で、畑は開墾で作る
      this.land.seedParcels(v, 6);
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

    assignWork(P, V, this.tick, this.land);
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
      },
      // ★ #17 §7-2：開墾の代償。未開の区画が減るほど疫病と火災が増える
      this.land ? (v) => WK.densityMul(WK.wildRatio(this.land, this.map.L, v)) : null,
      // ★ 洪水（正典9564）。川区画を持つ村だけが年4%（他は0.4%）。
      //   「川に隣接する里マス」の読み：**川区画を実際に持っている村**とする ──
      //   漁・肥沃+4・水運・粉挽きの利得を受け取るのがその村だけだから、代金もその村が払う
      this.land ? (v) => (this.land.riverCap?.[v] ?? 0) > 0 : null,
      // ★ 洪水の効果：その村の人工区画の地力 −4（正典9564）。蔵の30%は disaster 側
      this.land ? (v) => {
        const L = this.map.L;
        for (const p of this.land.cells[v] ?? []) {
          const role = L.b0[p] & 15;
          if (role < PARCEL.R.FIELD || role > PARCEL.R.PADDY) continue;
          const f = Math.max(0, (L.b0[p] >> 4) - DIS9.FLOOD_FERT);
          L.b0[p] = role | (f << 4);
        }
        this.land.recap(v);
      } : null);
    if (dz.dead > 0) {
      this.counters.died += dz.dead;
      this.counters.byCause[DIS9.DEATH_ACCIDENT] += dz.dead;
    }
    this.counters.storms += dz.storms; this.counters.plagues += dz.plagues;
    this.counters.fires += dz.fires;   this.counters.beasts += dz.beasts;
    this.counters.floods += dz.floods;
    // ---- 年代記（正典3-9）。★ 厄災は「年代記を開く動機」の芯 ----
    for (const [n, k] of [[dz.plagues, EV.疫病], [dz.storms, EV.災害],
                          [dz.fires, EV.災害], [dz.floods, EV.災害]]) {
      if (n > 0) {
        const id = this.chron.add(t, k, { x: n });
        // ★ その月に族が立った村へ「直近の災い」として結ぶ。産出低下の**真の原因**になる
        for (let v = 0; v < V.a.len; v++) if (V.a.alive[v] && V.a.kin[v]) this.lastBlow[v] = id;
      }
    }
    if (dz.floods && this.once('flood')) this.note('洪水', '川が溢れ、蔵の3割と地力が流れた');
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
    assignWork(P, V, t, this.land);

    // ---- 具申（#14）。★ 役職者が予定を立て、猶予を過ぎたら**勝手に実行される** ----
    //   ヘッドレスでは誰も止めないので全部通る。それでも
    //   **歪み**（命じたとおりには一度も実行されない）と **L の段** は世界に効く
    for (let i = 0; i < P.a.len; i++) {
      if (!P.a.alive[i] || !P.a.post[i]) continue;
      if (!P.a.loyalty[i]) P.a.loyalty[i] = PLAN.baselineL(P, i);
      const perYear = PLAN.plansPerYear(P.a.post[i]);
      if (!perYear) continue;
      // 年 perYear 件 ＝ 12/perYear ヶ月に1件。★ 立案の位相を人ごとにずらす（乱数を引かない）
      const every = Math.max(1, Math.round(12 / perYear));
      if ((C.monthOf(t) + (i % every)) % every !== 0) continue;
      // 叙爵・粛清・異端の処分・国境処理だけが「重」（#14 の表）。いまは軽だけが立つ
      this.plans.add(P, i, P.a.postVillage[i], PLAN.LIGHT, t, P.a.bureau[i]);
    }
    const pl = this.plans.runDue(P, t, (i) => P.a.loyalty[i], (p, d) => {
      this.counters.distortSum += Math.abs(d);
    });
    this.counters.plansRan += pl.ran;
    this.counters.plansSilent += pl.silent;
    this.counters.plansOverflow += pl.overflowed;

    // 席の生成と任命（#10-D ＋ B-15）。★ 軒数が確定してから。乱数を1回も引かない
    const off = OFF.officeMonth(P, V, H, t);
    this.counters.seated += off.seated;
    this.counters.ennobled += off.ennobled;
    if (off.seated > 0) this.chron.add(t, EV.任命, { x: off.seated });
    if (off.ennobled > 0) this.chron.add(t, EV.叙爵, { x: off.ennobled });
    if (off.seated > 0 && this.once('headman')) this.note('最初の村長', '10軒目が建った');

    // ---- 森が育つ（#17 §4-6：植えた月に0、毎月 +0.25、60ヶ月で樹齢15）----
    if (this.land) WK.forestMonth(this.map.L, this.land, V);

    // ---- 工事（#17 §4-3）。★ 乱数を1つも引かない。**産出の前**に働き手を抜く ----
    if (this.land) this.counters.works = this.worksStep(t);

    if (this.land) this.land.fogMonth(V.len);
    // ---- 斥候（#17 §6-8・正典9540）。★ 霧が晴れる4本のうちの1本目 ----
    //   これが無いと、分村先が「未知」で弾かれて開拓が村の可視半径ぶんずつしか進まない
    //   （実測：候補地が落ちる理由の15.1%が霧）
    if (this.land) {
      const sc = SCOUT.scoutMonth(
        this.scouts, this.land.fog, this.R[STREAM.SPARE],
        Math.round(this.cards.value('斥候の数')),
        (() => { let bp = 0; for (let v = 0; v < V.a.len; v++) if (V.a.alive[v] && V.a.workers[v] > bp) bp = V.a.workers[v]; return bp; })(),
        () => {   // 出せる働き手：畑の働き手のうち、いちばん大きい村の者
          let best = -1, bestPop = -1;
          for (let i = 0; i < P.a.len; i++) {
            if (!P.a.alive[i] || P.a.job[i] !== AREA_FIELD) continue;
            if (this.scouts.who.includes(i)) continue;
            const v = P.a.village[i];
            if (v >= V.a.len || V.a.pop[v] <= bestPop) continue;
            best = i; bestPop = V.a.pop[v];
          }
          if (best >= 0) P.a.job[best] = AREA_SCOUT;   // ★ 産出に出ない（正典9540）。専用の職域
          return best;
        },
        () => {   // 出発点：いちばん人口の多い村（＝豊かな村しか探索できない）
          let bv = -1, bp = -1;
          for (let v = 0; v < V.a.len; v++) if (V.a.alive[v] && V.a.pop[v] > bp) { bp = V.a.pop[v]; bv = v; }
          if (bv < 0 || this.land.px[bv] === undefined) return null;
          return [(this.land.px[bv] / PPL) | 0, (this.land.py[bv] / PPL) | 0];
        },
        (i) => P.a.alive[i],
        (i) => {
          // ★ 2026-09-01：**喪と村の死因台帳を通す。**通さないと「誰も悲しまない死」になり、
          //   #9-D の族の判定にも入らない（第2回の精査の指摘）
          const v = P.a.village[i];
          P.kill(i, t, SCOUT.DEATH_ACCIDENT);
          this.counters.died++; this.counters.byCause[SCOUT.DEATH_ACCIDENT]++; this.counters.scoutsLost++;
          if (v !== 0xFFFF) this.cal.count(v, SCOUT.DEATH_ACCIDENT);
          this.counters.mourned += COND.mourn(P, [i]);
        },
        (i) => { if (P.a.alive[i]) P.a.job[i] = AREA_HOME; });   // ★ 帰ったら配役へ戻す
      this.counters.scoutTiles = this.scouts.tiles;
      this.counters.scoutsOut = sc.out;
    }
    // ---- #11-G 食料の村間移送。★ 産出の**前**に、先月の不足を近い村から埋める ----
    //   正典7217：RATION_YEARS は「創世から10年の時限措置」であって、
    //   村をまたいで蔵を送る機構ではない。ここが本体。
    //   ★ 到達率が距離で段になるので**遠い村は救われない** ── カードが代金を持つ
    if (this.land) {
      // ★ 正典は「**受け手 B = 産出 < 消費 の村**」。蔵は見ない ──
      //   蔵を引くと、蔵が厚いあいだは誰も受け手にならず移送が永久に起きない（実測：送った量0）
      const shortOf = (v) => {
        const d = V.a.pop[v] * 0.6 * EAT_ADULT + V.a.pop[v] * 0.4 * 0.5;
        return Math.max(0, d - V.a.produced[v]);
      };
      const distOf = (a, b) => {
        const dx = (this.land.px[a] - this.land.px[b]) / PPL;
        const dy = (this.land.py[a] - this.land.py[b]) / PPL;
        return Math.hypot(dx, dy);
      };
      const tr = NEAR.transferMonth(V, shortOf, distOf, CARD.isOn(this.cards.step('備蓄の融通')));
      this.counters.foodSent += tr.sent; this.counters.villagesFed += tr.moved;
    }

    // ★ 狩りの当たりは狩りのストリーム（7番）。畑は乱数を一切引かない（「畑は遅いが安定」）
    const food = produceAndEat(P, V, t, this.land, this.harvest, this.R[STREAM.HUNT],
      (i, crew) => {
        // 熊の出た月、その組の各人に 負傷段2 3.0%（うち0.5%を即死へ）
        const r = this.R[STREAM.HUNT].next();
        if (r < BEAR_DEAD) { P.kill(i, t, 3); this.counters.byCause[3]++; this.counters.bearDead++; }
        else if (r < BEAR_HURT && !P.a.hurtStage[i]) {
          P.a.hurtStage[i] = 2; P.a.hurtPart[i] = 2; P.a.hurtHeal[i] = COND.healMonths(P, i, 2);
        }
        this.counters.bears++;
      },
      (i) => {
        if (this.R[STREAM.HUNT].next() < MID_HURT && !P.a.hurtStage[i]) {
          P.a.hurtStage[i] = 1; P.a.hurtPart[i] = 2; P.a.hurtHeal[i] = COND.healMonths(P, i, 1);
        }
      },
      this.cards.value('蔵の上限'));   // ★ 二重定義をやめ、カードの実値を渡す（#18 §1）
    for (const r of food) {
      // ★ 引き金は `shortage`（蔵を食い尽くしてから立つ）ではなく **産出 < 消費**。
      //   正典3-9 の言葉どおり「**作る量が食べる量に届かない**」＝ 柱6 の唯一の崩壊条件そのもの。
      //   蔵があるうちは死なないが、**そこが「なぜか産出が落ちている」の始まり**
      // ★ **冬は除く。**冬は畑の季節係数が0で産出が落ちるのが当たり前（§5-3）。
      //   正典が言う「**なぜか**産出が落ちている」は、**そうでない月に落ちること**
      if (!r || r.winter || !(r.produced < r.demand)) continue;
      // ★★ 正典3-9：**産出率に出所を持たせるのは、それが唯一の崩壊条件だから（柱7）。**
      //   「なぜか産出が落ちている」は**不作為・横領・隠匿・疫病・災害が全部集まる場所**であり、
      //   **プレイヤーが年代記を開く動機の一番手**になる。
      //   → 村が「作る量 < 食べる量」に落ちた月を、**直近の災いを真の原因として**記録する。
      //     ★ 同じ村で続くあいだは1件にまとめる（追記型だが、毎月同じ行は増やさない）
      const v = r.village ?? NO_VILLAGE16;
      if (this._shortSince?.[v] !== 1) {
        (this._shortSince ??= [])[v] = 1;
        this.chron.add(t, EV.産出低下,
          { village: v, cause: this.lastBlow[v], x: r.produced - r.demand });
      }
      if (this.once('hunger')) this.note('最初の飢え', '作る量が食べる量に届かない');
    }
    // 立ち直った村の印を落とす（次に落ちたらまた1件立つ）
    for (const r of food) if (r && r.produced >= r.demand && this._shortSince) this._shortSince[r.village] = 0;

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
    }, this.cards.value('徴兵率'));   // ★ 徴兵率のカードを渡す（#18 §1・軍務局）

    if (wr.fought) {
      this.counters.wars++; this.counters.warDead += wr.dead;
      this.counters.warKills += wr.kills; this.counters.warFled += wr.fled;
      this.counters.warWon += wr.won;
      this.counters.warByStat += wr.byStat; this.counters.warByLuck += wr.byLuck;
      this.counters.byCause[8] += wr.dead;
      // ★ 戦は国の年代記。戦死はここから伸びる恨みの**真の原因**になる
      this.warEvent = this.chron.add(t, EV.戦闘,
        { x: wr.dead, cause: this.warEvent ?? undefined });
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
        if (cp.taken > 0) this.chron.add(t, EV.捕虜, { x: cp.taken, cause: this.warEvent });
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
      // ★ 宗派の発起は国の年代記。**真の原因はその村を殴った厄災**（#9-D の族）
      for (const id of fnd.ids) {
        this.chron.add(t, EV.宗教,
          { village: this.sects.a.village[id], actor: this.sects.a.founder[id], x: id });
      }
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
    SECT.inheritMonth(P, this.R[STREAM.RELIGION], this.sects);

    // ---- 異端狩り（#7）。★ 信仰が確定した直後。乱数は犯罪のストリーム（9番）----
    //   祭祀局と刑務局が両方座り、正統宗派の信仰性≥75・硬さ≥50 が24ヶ月続いて初めて生える
    const hz = HER.heresyMonth(P, this.sects, this.inq, t, this.R[STREAM.CRIME]);
    if (hz.warned || hz.exiled || hz.burned) {
      this.counters.warned += hz.warned; this.counters.exiled += hz.exiled;
      this.counters.burned += hz.burned; this.counters.misfired += hz.misfired;
      this.counters.byCause[9] += hz.burned;
      if (hz.burned + hz.exiled > 0) this.chron.add(t, EV.粛清, { x: hz.burned + hz.exiled });
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
      // ★ 2026-08-31：**予備（11番）へ移した。**負傷の治癒が厄災（6番）に相乗りし、
      //   しかも分岐で引いていたので、負傷者が1人いるだけで6番の消費が動いていた
    }, this.R[STREAM.SPARE]);
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
      // ---- #17 §4-4 輪作 ／ §4-5 地力の年次。★ 乱数を1つも引かない ----
      //   > 毎年12月に更新（人工区画のみ）。畑・水田は輪作カードの表／繊維畑 −3／
      //   > 菜園 +1／牧草地 +2／果樹園 0。**地力が0になった人工区画は荒地へ落ちる**
      //   ここが無いと土地は一度傷んだら二度と戻らず、洪水で世界が死ぬ（2026-08-31 に実測）
      if (this.land) {
        const L = this.map.L;
        this.land.capField = this.land.capField || [];
        const rotOf = (v) => {
          // ★ オーナーのカード（#18 §1）。既定は三圃。村ごとの上書きも継承で効く
          const want = Math.round(this.cards.value('輪作', v)) | 0;
          const r = WK.rotationOf(this.land, L, v, want);
          this.land.capField[v] = WK.ROTATION[r].cap;
          return r;
        };
        const fy = WK.fertYear(L, this.land, V, rotOf, C.yearOf(t));
        this.counters.fertRuined += fy.ruined;
        if (fy.ruined > 0) this.chron.add(t, EV.開墾, { x: -fy.ruined });   // 畑が荒地へ落ちた
        if (fy.ruined && this.once('ruined')) this.note('畑が死んだ', '地力が0になり荒地へ落ちた');
      }
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
    const m = marryMonth(P, H, V, t, this.R[STREAM.MARRY], nearOf, this.ties, this.cards.value('婚姻圧'));
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

  // =========================================================================
  // ★★ オーナーの動詞「置く」（正典4090-4105）★★
  //   > **就ける（席）**／**叙する**／**削ぐ**
  //   > オーナー … **誰の L も下がらない**（任免は専権・#14）
  //   ★ 撃った結果は**必ず年代記に載る**（正典3-9）。だから「自分の介入と結果の因果」が読める
  // =========================================================================
  /** 席に就ける。@returns {{ok:boolean, why?:string}} */
  place(i, post, village = -1) {
    const A = this.people.a;
    // ★★ 正典697/729：**100人を超えた瞬間、画面から「自分で配役する」ボタンが消える。**
    //   **もう手で置けないので、代理人を立てるしかない。**獲得ではなく**剥奪**として体験させる
    if (!this.canPlace) return { ok: false, why: '人口が100を超えた ── もう手では置けない（正典1-5）' };
    const v = village >= 0 ? village : (A.postVillage[i] !== 0xFFFF ? A.postVillage[i] : A.village[i]);
    const r = OFF.placeSeat(this.people, this.villages, i, post, v, this.tick);
    if (!r.ok) return r;
    this.counters.ownerActs++;
    this.chron.add(this.tick, EV.任命,
      { actor: i, target: r.ousted >= 0 ? r.ousted : undefined, village: v, x: post });
    this.note('置いた', `#${i} を ${POST_NAMES[post] ?? ('席' + post)} に`);
    return r;
  }
  /** 叙する。★ 治める土地の大きさを超えて叙せない（#10-A） */
  ennoble(i) {
    const r = OFF.ennoble(this.people, this.villages, i, this.tick,
      (k) => this.villagesRuledBy(k));
    if (!r.ok) return r;
    this.counters.ownerActs++;
    this.chron.add(this.tick, EV.叙爵, { actor: i, village: this.people.a.village[i], x: 1 });
    this.note('叙した', `#${i} が ${PEOPLE_RANK_NAMES[this.people.a.rank[i]]} に`);
    return r;
  }
  /** 削ぐ */
  strip(i) {
    const r = OFF.strip(this.people, i, this.tick);
    if (!r.ok) return r;
    this.counters.ownerActs++;
    this.chron.add(this.tick, EV.叙爵, { actor: i, village: this.people.a.village[i], x: -1 });
    this.note('削いだ', `#${i} が ${PEOPLE_RANK_NAMES[this.people.a.rank[i]]} に`);
    return r;
  }
  // ---- 動詞「呼ぶ」（正典4084-4089）------------------------------------
  //   | その村の**村長**（いなければ家長） | **L_i** | **−8×(0.5+誇り/100)**（誇り60で −8.8）|
  //   | 同じ村で順位が下がった者 | **不満④**（★③ではない）| 1人あたり定常 **+0.119点** |
  //   | **呼ばれた本人** | **影響力 I ＋8.33**。n≥16 なら宗教の発起門 T_i=35 を跨ぐ |
  //   | オーナー自身 | 1村を掃くのに 21.5秒、当たり 0.157人。**一生に1度なので積み増せない** |
  /**
   * 呼ぶ。その村を掃いて1人を引き上げる。
   * ★ 「一生に1度なので積み増せない」＝ **同じ人を二度呼べない**（`summoned` で覚える）
   */
  summon(i) {
    const A = this.people.a;
    if (!A.alive[i]) return { ok: false, why: '生きていない' };
    if ((A.summoned ??= new Set()).has(i)) return { ok: false, why: 'もう呼んだ（一生に1度）' };
    const v = A.village[i];
    if (v === 0xFFFF) return { ok: false, why: '村に居ない' };
    A.summoned.add(i);
    A.infl[i] += SUMMON_INFL;                                   // ★ 影響力 +8.33
    // その村の村長の L が下がる（誇りで重くなる）
    for (let k = 0; k < A.len; k++) {
      if (!A.alive[k] || A.postVillage[k] !== v || A.post[k] !== OFF.POST_HEADMAN) continue;
      const pride = this.people.effective(k, ID_PRIDE_W);
      A.loyalty[k] = Math.max(0, (A.loyalty[k] || PLAN.baselineL(this.people, k))
        - SUMMON_L * (0.5 + pride / 100));
      break;
    }
    // 同じ村で順位が下がった者に ④（★③ではない。嫉妬は S={①} t=0 → 全額④）
    for (let k = 0; k < A.len; k++) {
      if (!A.alive[k] || k === i || A.village[k] !== v) continue;
      if ((A.ageMonths[k] / 12 | 0) < 12) continue;
      DIS.addDiscontent(this.people, k, DIS.D_SELF, SUMMON_ENVY);
    }
    this.counters.ownerActs++; this.counters.summoned++;
    this.chron.add(this.tick, EV.任命, { actor: i, village: v, x: SUMMON_INFL });
    this.note('呼んだ', `#${i} の影響力が ${A.infl[i].toFixed(1)} に`);
    return { ok: true, infl: A.infl[i] };
  }

  // =========================================================================
  // 国の段（正典1-5）と国力（正典4-3）
  // =========================================================================
  /** いまの段。★ 正典697「**100人を超えた瞬間**」＝ `>` */
  get phase() { return NAT.phaseOf(this.population()); }
  /** その段でオーナーが**失ったもの**（正典721 の表の右端。獲得の一覧は作らない） */
  get lost() { return NAT.LOST[this.phase]; }
  /** ★ 「自分で配役する」が撃てるか（正典729「100人を超えた瞬間、ボタンが消える」） */
  get canPlace() { return NAT.canPlace(this.population()); }

  /**
   * 国力（正典4-3）。★ **蓄え（蔵の中身・財）は入れない。**
   *   混ぜ方の重みは正典に無いので5項を同じ重みで混ぜている（B-45）
   */
  nationalPower() {
    const A = this.people.a, V = this.villages.a;
    let pop = 0, skillSum = 0, skillN = 0, produced = 0, demand = 0, fieldCap = 0;
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i]) continue;
      pop++;
      const j = A.job[i];
      if (j === AREA_FIELD || j === AREA_FOREST) {
        skillSum += this.people.effectiveOf(i, AREA_YIELD_STATS[j]) / Q_DIVISOR; skillN++;
      }
    }
    for (let v = 0; v < V.len; v++) {
      if (!V.alive[v]) continue;
      produced += V.produced[v];   // ★ 月次。冬は畑ぶんが0なので下の12ヶ月平均で均す
      demand += V.pop[v] * 0.6 * EAT_ADULT + V.pop[v] * 0.4 * 0.5;
      fieldCap += this.land ? (this.land.fieldCap[v] ?? 0) : 0;
    }
    // ★ 産出は**12ヶ月ならす**。冬は畑の季節係数が0なので、その月だけ見ると
    //   国力が季節で3割振れる（正典2989「1ヶ月で動く数字は目安として使えない」の趣旨）
    (this._prod12 ??= []).push(produced);
    if (this._prod12.length > 12) this._prod12.shift();
    const prodAvg = this._prod12.reduce((a, b) => a + b, 0) / this._prod12.length;
    // 年間出産数（近似：通算 ÷ 経過年）
    const years = Math.max(1, C.yearOf(this.tick));
    return NAT.powerOf({
      pop, skill: skillN ? skillSum / skillN : 0, fieldCap,
      produced: prodAvg, demand, birthsPerYear: this.counters.born / years,
    });
  }

  // ---- 動詞「向ける」（正典3677・4169）------------------------------------
  //   | **5** | **向ける** | なし（オーナー自身が布告）| 外国 |
  //     **国力の帯を数値で指定 → 候補一覧 → 布告** | 不可逆 |
  //   ★ 生えるのは「**国力検索でマッチ候補が1件でも返った日**」（正典4169）
  //   ★ **相手選びは国力だけ。地理でマッチングしない**（正典517）
  /** 国力の帯で相手を探す。@returns 候補（**国力しか見えない**・正典562） */
  searchFoes(bandPct = 20) {
    return this.roster.search(this.nationalPower().power, bandPct);
  }
  /** 国力ランキング（正典508「全プレイヤー間の順位」） */
  ranking() { return this.roster.ranking(this.nationalPower().power); }
  /** 「向ける」が撃てるか（正典4169） */
  canAim(bandPct = 20) { return NAT.canAim(this.searchFoes(bandPct).length); }

  /** その者が治めている村の数（#10-A の爵位の上限に要る） */
  villagesRuledBy(i) {
    const A = this.people.a;
    if (A.post[i] === OFF.POST_HEADMAN) return 1;
    if (A.post[i] === OFF.POST_MAYOR) {   // 街長＝村9つ（TOWN_VILLAGES）
      let n = 0; for (let v = 0; v < this.villages.a.len; v++) if (this.villages.a.alive[v]) n++;
      return Math.min(n, TOWN_VILLAGES);
    }
    if (A.post[i] === OFF.POST_CHIEF) return TOWN_VILLAGES;
    return 0;
  }

  /**
   * 工事の1ヶ月（#17 §4-3）。**乱数を1回も引かない。**
   *
   * > 実行 … その村の働き手。工事に付けた月は畑にも森にも出ない（産出が直接落ちる）
   * >         毎月：残り人月 −= 割り当て人数 × (Σ q_i / n)
   *
   * ★ §7-3「冬の開墾は、意図して残す」── 冬は畑の産出が 0 なので、
   *   カードの割合とは別に**畑の働き手を全員**工事へ回す。ここが「実質タダ」の窓。
   */
  worksStep(t) {
    const P = this.people, A = P.a, V = this.villages, L = this.map.L, g = this.map.g;
    const nv = V.len, winter = C.isWinter(t);
    let share = this.cards.value('工事に回す働き手の割合');

    // ---- 席が実体を持つ（正典4140・#14）----
    // > 席を埋めない ⇒ **その席の担当事象が何も起きない**（#14）。
    // > **農業局が空なら開墾も備蓄も止まる。**④の出口が閉じたまま
    // ★ 局が1つも生えていないあいだ（フェーズ1・2）は村長が回すので、これは効かない。
    //   **局が生えた国で農業局だけが空のとき**だけ止まる。
    // ★ そして柱5「命令も報告も人の性格で歪む」── 農業局長が居るなら、
    //   カードの割合はその局長の**歪み**を通って実行される（#14 の distortion）。
    const AGRI = BUREAUS.indexOf('農業局') + 1;
    let anyChief = 0, agriChief = -1;
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i] || A.post[i] !== OFF.POST_CHIEF || !A.bureau[i]) continue;
      anyChief++;
      if (A.bureau[i] === AGRI) agriChief = i;
    }
    if (anyChief > 0 && agriChief < 0) return { progressed: 0, finished: 0, stalled: 1 };
    if (agriChief >= 0) {
      const d = PLAN.distortionOf(P, agriChief, A.loyalty[agriChief] || PLAN.baselineL(P, agriChief));
      share = Math.max(0, Math.min(0.40, share * (1 + d / 100)));
    }

    // その村に工事があるか（無い村の働き手は抜かない）
    const men = new Int32Array(nv), qs = new Float64Array(nv), qn = new Int32Array(nv);
    const quota = new Int32Array(nv);
    for (let v = 0; v < nv; v++) {
      if (!V.a.alive[v]) continue;
      // 次に何を作るか：畑が6枚に満たないか、畑が混んでいるあいだは畑を開く
      if (!this.works.has(v)) continue;
      quota[v] = 1;                                   // 着工済みの村だけが人を取る
    }
    // 畑の働き手を数えてから、割合ぶんだけ工事へ移す（index 順・抽選しない）
    const fieldN = new Int32Array(nv);
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i] || A.job[i] !== AREA_FIELD) continue;
      fieldN[A.village[i]]++;
    }
    for (let v = 0; v < nv; v++)
      quota[v] = quota[v] ? Math.max(1, Math.floor(fieldN[v] * (winter ? 1 : share))) : 0;

    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i]) continue;
      const v = A.village[i];
      // ★★ **先月の工事人を畑へ戻す**（2026-08-31・別セッションの精査で発見）★★
      //   `AREA_HOME` に戻すと、この直後の `!== AREA_FIELD` で弾かれて
      //   **その月は工事にも畑にも出ず、まるごと遊んでいた**（実測 遊休/工事 ＝ 0.98〜1.00）。
      //   `assignWork` は既にこの月ぶんを配り終えているので、翌月まで拾われない。
      //   工事班は畑の働き手からしか取らないので、**畑へ戻すのが元の姿**。
      //   直すと12種の合計人口 +21.4%・工事の完了 153→197
      if (A.job[i] === AREA_BUILD) A.job[i] = AREA_FIELD;
      if (A.job[i] !== AREA_FIELD || v >= nv) continue;
      if (men[v] >= quota[v]) continue;
      A.job[i] = AREA_BUILD; men[v]++;
      qs[v] += P.effectiveOf(i, AREA_YIELD_STATS[AREA_FIELD]) / Q_DIVISOR; qn[v]++;
    }
    for (let v = 0; v < nv; v++) qs[v] = qn[v] ? qs[v] / qn[v] : 0;

    // 着工の判断（村長）。★ 正典 §8「良い土地を全部取る」は**罠**と名指しされている ──
    //   「定員が硬い天井なので、区画を増やしても**働き手が増えていなければ産出は1ミリも
    //     増えない。先に人が要る**」。だから「畑を6枚まで無条件に開く」ではなく、
    //   **定員が実働に追いつかなくなる手前で1枚だけ先回りする**（余裕は1区画ぶん）。
    //   これが無いと、25人の娘村が要りもしない畑を4枚開いて働き手を工事に取られる
    //   （実測：この1行で 300年・7種の平均人口 381 → 下の測定）
    //   ★ 6枚は「取りすぎ」ではなく**標準**（§4-4「三圃は畑を6区画持たないと選べない。
    //     13区画のうち6枚が畑にならない村は連作しかできない」）。6枚までは無条件に開き、
    //     **その先は混む手前で1枚だけ先回りする**。実測（300年・7種の平均人口）:
    //       6枚まで＋先回り 下の値 ／ 6枚までのみ 381 ／ 先回りのみ 288
    const want = (v) => {
      const fields = WK.countRole(this.land, L, v, PARCEL.R.FIELD);
      // ★★ 2026-09-01：**洪水が片道だった。**（第2回の精査の指摘）
      //   治す道が四圃（+0.5/年）だけで、四圃には畑8枚が要る。届かない村は洪水2発で
      //   `fertMul(0)=0` ＝ 畑の産出が厳密に0になり、**150年走査で 9.5〜21.2% の村が
      //   「治せない村」**になっていた。正典 §4-5 は回復路をもう1本書いている ──
      //   **牧草地 +2/年**（§9-3 の抜け道1の塞ぎも「牧草地の +2/年 で地力8に戻すのに4年」）。
      //   → **8枚に届かない村は、いちばん傷んだ畑を牧草地にして治し、治ったら畑へ戻す。**
      if (fields < WK.ROTATION[WK.ROT_FOUR].need &&
          (this.land.fert?.[v] ?? LAND.FERT_BASE) < LAND.FERT_BASE * 0.5)
        return PARCEL.R.PASTURE;
      // 治り終えた牧草地は畑へ戻す（地力が基準に戻っていたら）
      if (WK.countRole(this.land, L, v, PARCEL.R.PASTURE) > 0 &&
          (this.land.fert?.[v] ?? 0) >= LAND.FERT_BASE) return PARCEL.R.FIELD;
      if (fields < 6) return PARCEL.R.FIELD;
      // ★ 土地が傷んでいるなら、**四圃を回せる8枚まで開く**（§4-4「四圃は土地を治す道具」）。
      //   四圃は +0.5/年 で、洪水の期待損 0.04×4 ＝ 0.16/年 を大きく上回る。
      //   これが無いと、既定の三圃（0/年）では地力が一方通行で落ち続けて村が死ぬ
      //   （実測：洪水を入れた直後は 300年・5種のうち3種が絶滅。2026-08-31）
      if (fields < WK.ROTATION[WK.ROT_FOUR].need &&
          (this.land.fert?.[v] ?? LAND.FERT_BASE) < LAND.FERT_BASE) return PARCEL.R.FIELD;
      return (this.land.fieldCap[v] ?? 0) < fieldN[v] + LAND.CAP_FIELD ? PARCEL.R.FIELD : -1;
    };
    return WK.worksMonth(g, L, this.works, this.land, V, t, men, qs, want);
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
        this.land.seedParcels(nv, SPLIT_FIELDS);   // 拠点地1枚＋畑（B-39）
        this.moveHouses(v, nv);
        this.counters.split++;
        this.chron.add(this.tick, EV.分村, { village: nv, x: spot.r });
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
    const H = this.houses, P = this.people, V = this.villages, HA = H.a;
    const ids = [];
    for (let h = 0; h < HA.len; h++) if (HA.alive[h] && HA.village[h] === from) ids.push(h);
    ids.sort((a, b) => b - a);                  // 家IDの大きい順＝新しい家から
    const before = Math.max(1, ids.length);
    let moved = 0;
    for (const h of ids) {
      if (moved >= n) break;
      HA.village[h] = to;
      for (let i = 0; i < P.a.len; i++)
        if (P.a.alive[i] && P.a.house[i] === h) {
          P.a.village[i] = to;
          // ★★ **職を持ったまま運ばない**（2026-08-31・精査で発見）★★
          //   親村で漁師だった者が、川の無い娘村へ漁師のまま移り、
          //   `assignWork` は「もう振ってある」ので拾わず、**永久に0産出**になっていた
          //   （村の人月の15.9%）。AREA_HOME に戻せば新しい村で配り直される
          P.a.job[i] = AREA_HOME;
        }
      moved++;
    }
    // ★★ **蔵を軒数の比で分ける**（同・精査で発見）★★
    //   8軒移すと親村の `storeCap` が 7200→5280 に縮むが中身は移らないので、
    //   翌月の `if (food > cap) food = cap` で**上限を超えた分が蒸発**していた
    //   （15種200年・56回の分村で計48,535）。正典は分村時の蔵の扱いを書いていないが、
    //   **移った軒のぶんを持っていく**のが「家ごと移る」の素直な読み（B-40）
    if (moved > 0) {
      const share = moved / before;
      const take = V.a.food[from] * share;
      V.a.food[from] -= take;
      V.a.food[to] += take;
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
