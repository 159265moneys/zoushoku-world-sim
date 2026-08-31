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
import { fertMul, FERT_BASE } from './land.js';   // 地力（#17 §5-1）
import { NO_VILLAGE, ST_HUNGRY, ST_PREGNANT, WORK_START_AGE } from './people.js';
import * as DIS from './discontent.js';   // 不満6本（#4-(h) の産出倍率）

// ---- エリア ---------------------------------------------------------------
export const AREA_HOME = 0, AREA_FIELD = 1, AREA_FOREST = 2, AREA_TRAIN = 3, AREA_FRONTIER = 4;
// ★ 工事（#17 §4-3）。**工事に付けた月は畑にも森にも出ない**ので、産出が直接落ちる。
//   produceAndEat は AREA_FIELD/AREA_FOREST しか見ないので、ここに移すだけで産出から抜ける
export const AREA_BUILD = 5;
// ★ 漁（#17 §5-2「漁（川・海湖）: u < p → z=0.55 ／ 以外 0。**負傷なし**」）。
//   狩りと同じ 7番のストリームを使う（正典8297「7 狩り・漁の当たり」）
export const AREA_FISH = 6;
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
  // 工事（開墾・築造）── 畑と同じ体力仕事
  [['持久力', 1], ['体幹', 0.9], ['最大筋力', 0.7], ['段取り', 0.6], ['観察', 0.5]],
  // 漁 ── ★ 正典は「狩り・漁」を通して1つの機構として書いている（§5-2・ストリーム7）ので、
  //        森と同じ並びを使う。**新しいステの重みを作らない**
  [['走力', 1], ['敏捷', 0.9], ['視力', 0.8], ['観察', 0.8], ['集中', 0.6], ['獣を御する力', 0.5]],
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
// ---- 漁（#17 §9-4「魚：川区画・食料1.6／人月（定員3）」・§5-3 の季節）------------
// ★ 実効の1人月（年平均）で並べると 畑 2.6×0.75 ＝ 1.95 ／ **漁 1.6×1.00 ＝ 1.60** ／
//   狩り 1.4×0.95 ＝ 1.33。**畑より下・狩りより上。**
//   そのうえ 当たりは z=0.55 の**一段だけ**（狩りの熊のような大当たりが無い ＝ 荒れない）で、
//   定員が 川3／海湖6 と小さいので**量が取れない**。
export const FISH_YIELD = 1.6;
// §5-3 の表：川の漁 春1.6（遡上）／夏1.0／秋1.2／冬0.2（結氷）── 年平均 1.00
//            海の漁 春1.2／夏1.3／秋1.1／冬0.6（時化）      ── 年平均 1.05
export const FISH_SEASON_RIVER = [1.6, 1.0, 1.2, 0.2];
export const FISH_SEASON_SEA   = [1.2, 1.3, 1.1, 0.6];
// ★ 漁の帯は1段だけなので c ＝ 1.00 × 0.55 ＝ 0.550（§5-2 の「小物のみ」と同じ）
export const C_FISH = 0.550;
export const HUNT_YIELD = 1.4;             // 森1人・1ヶ月あたり
export const WINTER_HUNT = 0.8;            // 冬の狩りの落ち
export const EAT_ADULT = 1.0;              // 12歳以上が1ヶ月に食べる量
export const EAT_CHILD = 0.5;
// ★ 蔵の大きさ（2026-08-28 校正）。溢れた分は腐る（マルサスの天井）
//   60 → 120。**正典4015行「農業局のつまみ：蔵の上限」＝ 固定の定数ではなく既定値。**
//   産出の定数（FARM_YIELD 2.6・HUNT_YIELD 1.4・FIELD_SHARE 0.7）は
//   `0.7×2.6×0.75 + 0.3×1.4×0.95 = 1.764` と 産出135.8 に固定されていて**動かせない**ので、
//   固定されていない唯一の梃子がここだった。
//   実測（60通り×120年）
//     災害ゼロのとき  蔵60→失敗20% ／ 80→17% ／ 100→12% ／ 120→10%
//     ★ 2026-08-29 に**年の収穫係数**（凶作・厳冬）を入れたら 蔵120 で **23%** に跳ねた。
//       測り直し：120→23% ／ 180→17% ／ **240→13%** ／ 300→13% ／ 400→13%
//       **240 で頭打ち。**それ以上いくら大きくしても失敗率は下がらない。
//   ★★ 目標は確定事項 M-10 の10%だが、**蔵という梃子は13%で飽和した。**
//      産出3定数（FARM_YIELD 2.6・HUNT_YIELD 1.4・FIELD_SHARE 0.7）は
//      `0.7×2.6×0.75 + 0.3×1.4×0.95 = 1.764` と 産出135.8 に固定されていて動かせない。
//   ★★ そして 240 は 1軒4人で **約6.7年ぶん** ＝ 中世の穀倉としては大きすぎる。
//      タダで大きくできてしまうのは、**正典が言う「糧は月4%腐る」が未実装**だから。
//      腐敗が入れば大きな蔵に代金が付き、この値は下がるはず。
export const STORE_PER_HOUSE = 240;
export const FIELD_SHARE = 0.7;            // 働き手のうち畑へ回す割合

// ---- 年の収穫係数（正典3-7・#17 §5-1） --------------------------------------
// **年に1本。世界に1本。**平均1.0・ばらつき0.15・0.5〜1.5で切る。
// ★ **凶作・厳冬・飢饉が全部ここから出る。**これが無いと 3-7 の自然7行のうち2行が丸ごと立たない。
//   厳冬 ＝ 0.70未満（43年に1回） ／ 凶作 ＝ 0.85未満（6年に1回）
// ★ **人工の耕地にだけ掛ける。**森林・川・海湖には掛けない（#17 §5-1）。
//   だから「畑に寄せた国ほど凶作が痛い」が構造から出る。
// ★ 嵐は収穫係数に一切触れない（#9-A）。嵐が殴るのは蔵と家であって流れではない。
//   触ると嵐の年がほぼ100%で飢の災いを兼ね、族が2つ立って宗教の照合が壊れる。
export const HARVEST_MEAN = 1.0, HARVEST_SD = 0.15;
export const HARVEST_MIN = 0.5, HARVEST_MAX = 1.5;
export const HARVEST_HARSH = 0.70;    // これ未満で厳冬
export const HARVEST_POOR = 0.85;     // これ未満で凶作

/** その年の作柄を引く。年に1度だけ。乱数は厄災のストリーム（6番） */
export function drawHarvest(rng) {
  const v = rng.normal(HARVEST_MEAN, HARVEST_SD);
  return v < HARVEST_MIN ? HARVEST_MIN : v > HARVEST_MAX ? HARVEST_MAX : v;
}

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
//
// ★★ 373 → 225 に再校正（2026-08-31・M-46〜M-49）★★
//   **373 は q̄ = 1.0 を狙った値だった。**台帳は「373 ＝ #3-(h) の運転点 q̄=1.4 そのもの」と
//   書いていたが、373 を決めた根拠の「旧コードの働き手1人あたり産出 2.24（夏）」は
//   `0.7×2.6 + 0.3×1.4 = 2.24` ＝ **q=1.0 のときの夏の値**であって、1.4 ではない。
//   さらに実測の q̄ は 1.0 にも届かず **0.844** だった（働き手の26%が16歳未満で q 0.16〜0.43。
//   正典の q̄=1.4 は 25〜40歳の畑働き手に厳密に一致するが、その層は人口の20.5%しかいない）。
//   導出：373 × (0.844 / 1.4) = **224.9 → 225**
//
//   ★ これは正典のロックした数を**動かす**変更ではない。**初めて成立させる**変更：
//        素の産出/100人  87.4 → **137.5**（正典 135.8・+1.3%）
//        分岐点          0.955 → **0.607**（正典 0.615・−1.3%）
//        素の余裕        +4.7% → **+64.7%**（正典 +62.6%）
//        定常の産出倍率  0.979 → **0.870**（正典 0.864・+0.7%）
//   ★ 校正に使っていない種7つ（13/17/19/23/31/37/41・300年）での代金：
//        絶滅 **5/7 → 1/7**／餓死 死因の 17.1% → **2.5%**／成長 −0.03%/年 → **+0.79%/年**
//   ★ 乱数の消費順は1つも変えていない（定数の値だけ）。
export const Q_DIVISOR = 225;

// ---------------------------------------------------------------------------
// 狩り・漁の当たり（#17 §5-2）。★ **量ではなく当たり率で引く**（正典3-6g「狩りは博打」）
// ---------------------------------------------------------------------------
//
// ★ **畑・水田・菜園・果樹園・繊維畑・牧草地は乱数を一切引かない ＝「畑は遅いが安定」。**
//   森林・川・海湖の食料だけが博打になる。
//
// ★ 当たり率 p = clamp(0, 1, 実効値 / (2 × Q_DIVISOR))。**ステそのもの。下駄を履かせない。**
//   正典8963：手ぶらで帰る月の割合 ＝ 1 − clamp(0,1, 実効値/746)。
//   ★★ **746 は 2×373 として引かれた値**（正典8963「旧2,100。分母を 1,050→373 に
//     直したので、**その2倍として引き直した**」）。だから Q_DIVISOR に**必ず追随する**。
//     2026-08-31：`Q_DIVISOR` を 373→225 にしたとき、ここを 746 のまま残していた（こちらの回帰）。
//     正典 §5-2 の保存則 **E[2z/c] ＝ 2p ＝ q** が破れ、畑 q̄=1.48 に対し森 2p̄=0.60 と
//     **働き手の3割（森＋漁）が食料の 9.5% しか作らない**状態になっていた（正典の内訳は22.6%）。
//     手ぶら率も 70〜74%（正典50%）。**別セッションの精査で発見。**
//   ★ **clamp を外してはいけない。**からだ50・あたま25 は才能(≤100)＋努力値(上限なし)なので
//     170前後まで伸びる。clamp が無いと p=1.6 のとき熊の帯が u<1 の外へ出て消え、
//     **名人ほど獲れなくなる**（E[z] が 1.241 → 0.561）。
//   ★ 下駄（p = 0.30 + 0.35q）は採らない。実効値0の猟師が平均の38%を獲ってしまい、
//     ステの効きが 0〜1.43倍 から 0.38〜1.27倍 へ潰れる。
export const HIT_DIVISOR = 2 * Q_DIVISOR;   // ★ 必ず追随させる（正典8963）
export const hitP = (eff) => (eff < 0 ? 0 : eff > HIT_DIVISOR ? 1 : eff / HIT_DIVISOR);

// 猟の帯（正典8954）。u ~ U[0,1)
export const GAME_SMALL = 0.55, GAME_MID = 2.00, GAME_BIG = 9.00;
export const BAND_SMALL = 0.62, BAND_MID = 0.98;      // u < 0.62p 兎鳥 ／ 0.98p まで鹿猪 ／ p まで熊
// ★ 開く段は「組の実働人月」で決まる。開いていない段は1つ下へ落ちる
export const C_ALL = 0.62 * GAME_SMALL + 0.36 * GAME_MID + 0.02 * GAME_BIG;   // 1.241
export const C_MID = 0.62 * GAME_SMALL + 0.38 * GAME_MID;                      // 1.101
export const C_SMALL = 1.00 * GAME_SMALL;                                      // 0.550
export const CREW_ALL = 4, CREW_MID = 2;              // 実働 ≥4人月で全段 ／ ≥2で中物まで
// 熊の出た月、その組の各人に 負傷段2 3.0%（うち0.5%を即死へ）／鹿猪の組に 段1 1.0%
export const BEAR_HURT = 0.030, BEAR_DEAD = 0.005, MID_HURT = 0.010;

/**
 * 猟の取れ高 z（#17 §5-2）。★ **E[2z/c] ＝ 2p ＝ q。どの組でも、どの実効値でも厳密に q。**
 *   つまり §5-1 の q_i を「2z/c」に差し替えただけ。**1.764×q ／ 産出135.8 は1文字も動かない。
 *   変わるのは分散だけ。**
 * @returns {{z, c, band}} band 0=手ぶら 1=兎鳥 2=鹿猪 3=熊
 */
export function hunt(u, p, crew) {
  const c = crew >= CREW_ALL ? C_ALL : crew >= CREW_MID ? C_MID : C_SMALL;
  if (u >= p) return { z: 0, c, band: 0 };
  if (crew < CREW_MID) return { z: GAME_SMALL, c, band: 1 };           // 全部が兎鳥へ落ちる
  if (crew < CREW_ALL) {
    return u < BAND_SMALL * p ? { z: GAME_SMALL, c, band: 1 }
                              : { z: GAME_MID, c, band: 2 };           // 熊が鹿猪へ落ちる
  }
  if (u < BAND_SMALL * p) return { z: GAME_SMALL, c, band: 1 };
  if (u < BAND_MID * p) return { z: GAME_MID, c, band: 2 };
  return { z: GAME_BIG, c, band: 3 };
}

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
  // ---- 厄災（#9-D・#9-E）------------------------------------------------
  kin: 'u8',          // その月の族（0=なし 1疫 2飢 3天 4兵 5罰 6内）。#9-D は 1月1族
  kinRate: 'f32',     // 直近12ヶ月の死者率 r ＝ 死者数 ÷ 12ヶ月前の村人口（#9-E）
  bigSince: 'i32',    // 前に「大きな災い」が発火した月。−1 なら未発火（12ヶ月あける）
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
export function assignWork(P, V, tick, land = null) {
  const A = P.a;
  const nv = V.len;
  const field = new Uint16Array(nv), forest = new Uint16Array(nv), fish = new Uint16Array(nv);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    if (A.job[i] === AREA_FIELD) field[v]++;
    else if (A.job[i] === AREA_FOREST) forest[v]++;
    else if (A.job[i] === AREA_FISH) fish[v]++;
  }
  let assigned = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
    if (y < WORK_START_AGE[A.rank[i]]) { A.job[i] = AREA_HOME; continue; }
    if (A.job[i] !== AREA_HOME) continue;             // もう振ってある
    // ★★ 漁は**森を押しのける。畑は押しのけない。**★★
    //   年平均の実効の1人月で並べると 畑 2.6×0.75 ＝ **1.95** ／
    //   川の漁 1.6×1.00 ＝ **1.60** ／ 狩り 1.4×0.95 ＝ **1.33**。
    //   だから FIELD_SHARE 0.7 は1文字も動かさず、**残りの0.3の中で漁を先に埋める。**
    //   （定員は硬い**天井**であって目標ではない ── 先に埋めると、
    //     川3区画＝定員9 の村で10人中9人が漁師になり畑が空になる）
    const fcap = land ? ((land.riverCap?.[v] ?? 0) + (land.seaCap?.[v] ?? 0)) : 0;
    const n = field[v] + forest[v] + fish[v];
    if (n === 0 || field[v] / n < FIELD_SHARE) { A.job[i] = AREA_FIELD; field[v]++; }
    else if (fish[v] < fcap) { A.job[i] = AREA_FISH; fish[v]++; }
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
/**
 * @param rngHunt 狩りのストリーム（#17 §5-2）。★ 森で働く者ひとりにつき必ず1回引く。
 *   無ければ 0.5 固定（＝乱数を引かない旧来の挙動。検査の対照に使える）
 */
export function produceAndEat(P, V, tick, land = null, harvest = 1.0, rngHunt = null, onBear = null, onMid = null) {
  const A = P.a, VA = V.a;
  const nv = V.len;
  const winter = C.isWinter(tick);
  const rationOn = tick < RATION_YEARS * C.DAYS_PER_YEAR;

  const prodF = new Float64Array(nv), prodW = new Float64Array(nv), prodH = new Float64Array(nv);
  const season = C.season(tick);
  const produced = new Float64Array(nv);
  const demand = new Float64Array(nv);
  const pop = new Uint16Array(nv), workers = new Uint16Array(nv);
  // ★ 土地の定員（#17 §2-2）。畑と森に何人月まで入るかは区画の数で決まる。
  //   定員は**硬い天井**で逓減させない（§2-1：柱6の単一の判定式を守るため）
  const fieldMen = new Float64Array(nv), forestMen = new Float64Array(nv);
  const fishMen = new Float64Array(nv);

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    pop[v]++;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;
    demand[v] += y >= 12 ? EAT_ADULT : EAT_CHILD;

    const job = A.job[i];
    // ★ 漁（#17 §5-2）。**帯は1段だけ**（u<p で z=0.55、外れは0）。負傷なし。
    //   季節は川と海で違う（§5-3）。定員は land が持つ（川3／海湖6）
    if (job === AREA_FISH) {
      workers[v]++;
      if (A.state[i] & ST_PREGNANT) continue;
      fishMen[v]++;
      const rc = land ? (land.riverCap?.[v] ?? 0) : 0, sc = land ? (land.seaCap?.[v] ?? 0) : 0;
      // 川と海の両方を持つ村は、定員の比で季節係数を混ぜる（区画ごとに人を割らない）
      const sea = (rc + sc) > 0 ? sc / (rc + sc) : 0;
      const seas = FISH_SEASON_RIVER[season] * (1 - sea) + FISH_SEASON_SEA[season] * sea;
      const eff = P.effectiveOf(i, AREA_YIELD_STATS[AREA_FISH]);
      const pHit = hitP(eff) * moraleOf(P, i);
      const u = rngHunt ? rngHunt.next() : 0.5;
      const z = u < pHit ? 0.55 : 0;
      prodH[v] += FISH_YIELD * seas * (2 * z / C_FISH);
      continue;
    }
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
        if (!winter) prodF[v] += FARM_YIELD * q * harvest;   // 冬は作物ができない。★収穫係数は畑だけ
      } else {
        // ★ 狩りは博打（#17 §5-2）。q を**当たり率 p へ移し**、末尾に 2z/c を掛ける。
        //   E[2z/c] ＝ 2p ＝ q なので**期待値は1文字も変わらない。変わるのは分散だけ。**
        //   → 「森に何人出すか」が、期待値ではなく**賭け方を選ぶ判断**になる
        const eff = P.effectiveOf(i, AREA_YIELD_STATS[job]);
        const pHit = hitP(eff) * moraleOf(P, i);
        const r = hunt(rngHunt ? rngHunt.next() : 0.5, pHit, forestMen[v]);
        prodW[v] += HUNT_YIELD * (2 * r.z / r.c) * (winter ? WINTER_HUNT : 1);
        if (r.band === 3 && onBear) onBear(i, forestMen[v]);   // 熊の出た月
        else if (r.band === 2 && onMid) onMid(i);
      }
    }
  }

  // ★ crowd ＝ 定員 / 実働（#17 §2-2）。1.00 を超えない。土地が無ければ 1.00 のまま
  const crowdF = new Float64Array(nv).fill(1), crowdW = new Float64Array(nv).fill(1);
  if (land) for (let v = 0; v < nv; v++) {
    if (fieldMen[v] > 0)  crowdF[v] = Math.min(1, (land.fieldCap[v]  ?? 0) / fieldMen[v]);
    if (forestMen[v] > 0) crowdW[v] = Math.min(1, (land.forestCap[v] ?? 0) / forestMen[v]);
  }
  // ★ 地力（#17 §5-1）。**人工の耕地にだけ掛ける。**森（狩り）には掛けない ──
  //   正典5-1「年の収穫係数は人工の耕地にだけ掛ける。森林・川・海湖・鉱脈・山・荒地・平野には掛けない」
  //   と同じ扱い。地力8 の村では厳密に 1.000 なので 135.8／分岐点 は動かない
  const fert = new Float64Array(nv).fill(1);
  if (land && land.fert) {
    for (let v = 0; v < nv; v++) fert[v] = fertMul(land.fert[v] ?? FERT_BASE);
  }
  // ★ 漁の crowd。定員（川3／海湖6）は硬い天井（§2-1）。地力は掛けない（人工の耕地だけ）
  const crowdH = new Float64Array(nv).fill(1);
  if (land) for (let v = 0; v < nv; v++) {
    if (fishMen[v] > 0)
      crowdH[v] = Math.min(1, ((land.riverCap?.[v] ?? 0) + (land.seaCap?.[v] ?? 0)) / fishMen[v]);
  }
  for (let v = 0; v < nv; v++)
    produced[v] = prodF[v] * crowdF[v] * fert[v] + prodW[v] * crowdW[v] + prodH[v] * crowdH[v];

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
