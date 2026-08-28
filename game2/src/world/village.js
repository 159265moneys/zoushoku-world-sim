// 村。エリア（住居・畑・森・訓練場・辺境）と、産出と消費。
//
// 確定事項より：
//   A-19  村＝家＋畑＋森＋訓練場＋その他の仕事場のエリア
//         誰がどこで何の仕事をしているかが、見て分かることが要件
//         村ごとの生産性をリアルタイムで計算する
//   A-19b 1村 ＝ 30世帯 ＝ 約100人。村の上限は「30軒が埋まったら」
//   A-11  冬は作物ができない
//   A-10  創世の十匹＋最初の10年は飢えが起きない配給
//         「神が最初の食料を与えた」で説明がつくので、死を止める嘘をつく必要がない
//         配給だけで飢え死にが65%→33%に半減する（実測）
//   B-12  食料の天井で人口を自己調整させる（マルサス）
//   A-21  どこに住んでいるかで努力値の伸び率が変わる（中央／辺境）
//
// 掟：座標は UI 側だけが持つ。ここは「どの村か」「どのエリアか」しか知らない。

import * as S from '../core/stats.js';
import * as C from '../core/calendar.js';
import { make } from '../core/arrays.js';
import { NO_VILLAGE, ST_HUNGRY, ST_PREGNANT, WORK_START_AGE } from './people.js';
import * as DIS from './discontent.js';   // 不満6本（#4-(h) の産出倍率）

// ---- エリア ---------------------------------------------------------------
export const AREA_HOME = 0, AREA_FIELD = 1, AREA_FOREST = 2, AREA_TRAIN = 3, AREA_FRONTIER = 4;
export const AREA_COUNT = 5;
export const AREA_NAMES = ['住居', '畑', '森', '訓練場', '辺境'];

// そのエリアで働くと何が鍛えられるか。**仮の表**
// （jobs.csv にステとの対応が無い。職とステを結ぶ表が要るという申し送りのとおり）
// こころ29個は書かない。閾値が「該当なし」なので普通の努力では積まれない（確定事項）。
const AREA_TRAIN_NAMES = [
  // 住居（家事）
  [['手先の器用さ', 1], ['段取り', 1], ['火と熱の見極め', 0.8], ['味覚', 0.5], ['観察', 0.4]],
  // 畑（耕す・蒔く・刈る）
  [['持久力', 1], ['体幹', 0.9], ['最大筋力', 0.7], ['段取り', 0.6], ['観察', 0.5]],
  // 森（狩り・伐採）
  [['走力', 1], ['敏捷', 0.9], ['視力', 0.8], ['観察', 0.8], ['集中', 0.6], ['獣を御する力', 0.5]],
  // 訓練場
  [['最大筋力', 1], ['打たれ強さ', 1], ['反射', 0.9], ['瞬発力', 0.8], ['体で覚える力', 0.7]],
  // 辺境（開拓）
  [['持久力', 1], ['寒さへの強さ', 0.8], ['道と方角の覚え', 0.7], ['最大筋力', 0.7], ['痛覚の鈍さ', 0.4]],
];

// 名前 → ステ番号に一度だけ直す（実行時に名前で引かない）
export const AREA_STATS = AREA_TRAIN_NAMES.map(list => list.map(([n, w]) => [S.needId(n), w]));

// 産出に効くステ（畑と森だけ。訓練場と辺境は食べ物を作らない）
export const AREA_YIELD_STATS = AREA_STATS;

// ---- 住んでいる場所（A-21 の中央／辺境） ---------------------------------
export const WHERE_CENTER = 0, WHERE_FRONTIER = 1;
export const WHERE_NAMES = ['中央', '辺境'];

// ---- 数（**仮の数値**。確定事項に産出量の数が無い） ------------------------
export const HOUSES_PER_VILLAGE = 30;      // A-19b。ここだけは確定
export const RATION_YEARS = 10;            // A-10。ここも確定
export const FARM_YIELD = 2.6;             // 畑1人・1ヶ月あたり（実効値50のとき）

// ---- 不満が産出に効く（#4-(h)） -------------------------------------------
// 正典3-5「民心という1本にまとめない」。**用途ごとに必要な向きを直接読む。**
// 産出は ③統治へ（怠業）と ④自分へ（働く気が失せる）の2本だけを読む。
export const MORALE_FLOOR = 0.40, MORALE_RULE = 0.30, MORALE_SELF = 0.35;
export function moraleOf(P, i) {
  const v3 = DIS.value(P, i, DIS.D_RULE), v4 = DIS.value(P, i, DIS.D_SELF);
  const m = 1 - MORALE_RULE * v3 / 100 - MORALE_SELF * v4 / 100;
  return m < MORALE_FLOOR ? MORALE_FLOOR : m > 1 ? 1 : m;
}
export const HUNT_YIELD = 1.4;             // 森1人・1ヶ月あたり
export const WINTER_HUNT = 0.8;            // 冬の狩りの落ち
export const EAT_ADULT = 1.0;              // 12歳以上が1ヶ月に食べる量
export const EAT_CHILD = 0.5;
export const STORE_PER_HOUSE = 60;         // 蔵の大きさ。溢れた分は腐る（マルサスの天井）
export const FIELD_SHARE = 0.7;            // 働き手のうち畑へ回す割合

// ★★ q の分母（2026-08-28）★★
//   結果 ＝ 基準量 × q、q ＝ 実効値 / Q_DIVISOR（正典 #3-(h)／#17 §5-1）
//   ★ 正典は 1,050 と書いていたが、**導出に2つの穴があった**（2026-08-28・実測で判明）:
//     ① 基準にしたのが **才能50・70歳**。だが食料を作っているのは25〜35歳が中心で、
//        年齢減衰の積分は 30歳16.2年ぶん／70歳28.3年ぶん ＝ **1.74倍しか違わない**
//     ② **加重平均を勘定していない。**畑は5ステの加重平均（重み1.0/0.9/0.7/0.6/0.5）で
//        測るので、満点の **78.6%** にしかならない（Σw²/Σw ＝ 2.91/3.70）
//   実測：働き手370人の実効値は1人あたり **373.0**（旧目盛りでは 68.8）。5.42倍。
//   ★ 分母は**実測で決めた**（比例計算では合わなかった）。旧コードの働き手1人あたり産出
//     2.23/2.24/2.27（種3/6/18・夏・120年）に一致する値を探した結果 **373**。
//     ただしこれだけでは足りず、**創世の十匹に年齢ぶんの努力値を積む**必要があった
//     （grow.js の seedEffortForAge）。十匹は18〜26歳で ev=0 のまま生まれるので、
//     努力値が主役になった新目盛りでは「才能だけの大人」＝旧目盛りの1/13の産出になり、
//     子が育つ前に全滅していた
export const Q_DIVISOR = 373;

const ID_HUNGER_RESIST = S.needId('飢えへの強さ');

export const VILLAGE_SPEC = {
  where: 'u8',        // 0=中央 1=辺境
  food: 'f32',
  houses: 'u16',
  pop: 'u16',
  workers: 'u16',
  produced: 'f32',    // 先月の産出
  eaten: 'f32',       // 先月の消費
  hungry: 'u16',      // 先月飢えた人数
  rationed: 'f32',    // 配給で足した量（嘘をつかずに数えるため）
  founded: 'i32',
  alive: 'u8',
};

export class Villages {
  constructor(cap = 8) { this.a = make(cap, VILLAGE_SPEC); }
  get len() { return this.a.len; }
  get food() { return this.a.food; }
  get where() { return this.a.where; }
  get pop() { return this.a.pop; }
  get houses() { return this.a.houses; }

  create(tick, where = WHERE_FRONTIER, food = 0) {
    const v = this.a.alloc();
    this.a.clear(v);
    this.a.where[v] = where;
    this.a.food[v] = food;
    this.a.founded[v] = tick;
    this.a.alive[v] = 1;
    return v;
  }

  /** その村はもう家が入らないか（A-19b：30軒が埋まったら） */
  isFull(v) { return this.a.houses[v] >= HOUSES_PER_VILLAGE; }
  freeSlots(v) { return Math.max(0, HOUSES_PER_VILLAGE - this.a.houses[v]); }
  storeCap(v) { return Math.max(1, this.a.houses[v]) * STORE_PER_HOUSE; }
}

// ---- 仕事の割り当て -------------------------------------------------------
/**
 * 働ける年になった者にエリアを振る。一度振ったら変えない（転職は A-8 の別の話）。
 * 畑と森の比を FIELD_SHARE に保つ。乱数を使わないので同じ種で同じ配置になる。
 */
export function assignWork(P, V, tick) {
  const A = P.a;
  const nv = V.len;
  const field = new Uint16Array(nv), forest = new Uint16Array(nv);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    if (A.job[i] === AREA_FIELD) field[v]++;
    else if (A.job[i] === AREA_FOREST) forest[v]++;
  }
  let assigned = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
    if (y < WORK_START_AGE[A.rank[i]]) { A.job[i] = AREA_HOME; continue; }
    if (A.job[i] !== AREA_HOME) continue;             // もう振ってある
    const n = field[v] + forest[v];
    if (n === 0 || field[v] / n < FIELD_SHARE) { A.job[i] = AREA_FIELD; field[v]++; }
    else { A.job[i] = AREA_FOREST; forest[v]++; }
    assigned++;
  }
  return assigned;
}

// ---- 1ヶ月ぶんの産出と消費 -------------------------------------------------
/**
 * 産出 → 蔵へ → 食べる → 足りなければ飢える。
 * 創世から RATION_YEARS 年のあいだは配給が足りない分を埋める（A-10）。
 * @returns 村ごとの明細
 */
export function produceAndEat(P, V, tick, land = null) {
  const A = P.a, VA = V.a;
  const nv = V.len;
  const winter = C.isWinter(tick);
  const rationOn = tick < RATION_YEARS * C.DAYS_PER_YEAR;

  const prodF = new Float64Array(nv), prodW = new Float64Array(nv);
  const produced = new Float64Array(nv);
  const demand = new Float64Array(nv);
  const pop = new Uint16Array(nv), workers = new Uint16Array(nv);
  // ★ 土地の定員（#17 §2-2）。畑と森に何人月まで入るかは区画の数で決まる。
  //   定員は**硬い天井**で逓減させない（§2-1：柱6の単一の判定式を守るため）
  const fieldMen = new Float64Array(nv), forestMen = new Float64Array(nv);

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    pop[v]++;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
    demand[v] += y >= 12 ? EAT_ADULT : EAT_CHILD;

    const job = A.job[i];
    if (job === AREA_FIELD || job === AREA_FOREST) {
      workers[v]++;
      // 身重の女は畑にも森にも出ない（家事へ回る）
      if (A.state[i] & ST_PREGNANT) continue;
      if (job === AREA_FIELD) fieldMen[v]++; else forestMen[v]++;
      // ★ 不満が産出に効く唯一の口（#4-(h)）。**読むのは ③と④だけ。**⑤は何にも乗らない
      //   個人の産出倍率 = clamp(0.40, 1.00, 1 − 0.30×V③/100 − 0.35×V④/100)
      //   ★ 怠業（③≥45）と自暴自棄（④≥65）の状態効果はこの1本に含む。二重に掛けない
      const q = P.effectiveOf(i, AREA_YIELD_STATS[job]) / Q_DIVISOR * moraleOf(P, i);
      if (job === AREA_FIELD) {
        if (!winter) prodF[v] += FARM_YIELD * q;      // 冬は作物ができない
      } else {
        prodW[v] += HUNT_YIELD * q * (winter ? WINTER_HUNT : 1);
      }
    }
  }

  // ★ crowd ＝ 定員 / 実働（#17 §2-2）。1.00 を超えない。土地が無ければ 1.00 のまま
  const crowdF = new Float64Array(nv).fill(1), crowdW = new Float64Array(nv).fill(1);
  if (land) for (let v = 0; v < nv; v++) {
    if (fieldMen[v] > 0)  crowdF[v] = Math.min(1, (land.fieldCap[v]  ?? 0) / fieldMen[v]);
    if (forestMen[v] > 0) crowdW[v] = Math.min(1, (land.forestCap[v] ?? 0) / forestMen[v]);
  }
  for (let v = 0; v < nv; v++) produced[v] = prodF[v] * crowdF[v] + prodW[v] * crowdW[v];

  const out = [];
  for (let v = 0; v < nv; v++) {
    if (!VA.alive[v]) { out.push(null); continue; }
    VA.pop[v] = pop[v];
    VA.workers[v] = workers[v];
    VA.produced[v] = produced[v];
    VA.eaten[v] = 0;
    VA.hungry[v] = 0;
    VA.rationed[v] = 0;

    let food = VA.food[v] + produced[v];
    // 配給。神が最初の食料を与えた。足りない分だけを足す（嘘をつかずに保護する）
    if (rationOn && food < demand[v]) {
      VA.rationed[v] = demand[v] - food;
      food = demand[v];
    }
    const eaten = Math.min(food, demand[v]);
    food -= eaten;
    VA.eaten[v] = eaten;

    // 蔵の天井。溢れた分は腐る（B-12：食料の天井で人口を自己調整させる）
    const cap = V.storeCap(v);
    if (food > cap) food = cap;
    VA.food[v] = food;

    out.push({
      village: v, produced: produced[v], demand: demand[v], eaten,
      food, rationed: VA.rationed[v], winter, pop: pop[v], workers: workers[v],
      shortage: Math.max(0, demand[v] - eaten),
    });
  }

  // 足りなかった村の者に飢えを付ける。子どもと年寄りから当たる
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv || !VA.alive[v]) continue;
    const r = out[v];
    if (!r || r.shortage <= 0) { A.state[i] &= ~ST_HUNGRY; continue; }
    const ratio = r.demand > 0 ? r.eaten / r.demand : 1;
    // 足りた割合を「誰が食べられたか」に均す。飢えへの強さが高い者は耐える
    const need = ((A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0) >= 12 ? EAT_ADULT : EAT_CHILD;
    const hold = P.effective(i, ID_HUNGER_RESIST) / 100;   // 0〜1くらい
    if (ratio + hold * 0.25 < 1 - (need - EAT_CHILD) * 0.1) {
      A.state[i] |= ST_HUNGRY;
      VA.hungry[v]++;
    } else {
      A.state[i] &= ~ST_HUNGRY;
    }
  }
  return out;
}

/** 家の数を村へ写す（30軒の上限を見るための数） */
export function syncHouses(V, H) {
  const VA = V.a, HA = H.a;
  for (let v = 0; v < VA.len; v++) VA.houses[v] = 0;
  for (let h = 0; h < HA.len; h++) {
    if (!HA.alive[h]) continue;
    const v = HA.village[h];
    if (v < VA.len) VA.houses[v]++;
  }
}
