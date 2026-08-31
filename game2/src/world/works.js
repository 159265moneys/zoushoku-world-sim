// 工事 ── #17 §4-2（変換表）・§4-3（誰が、どうやって）・§9-3（抜け道の塞ぎ）
//
// > **1村につき同時1件だけ。**
// > 実行 … その村の働き手。工事に付けた月は畑にも森にも出ない（産出が直接落ちる）
// >         毎月：残り人月 −= 割り当て人数 × (Σ q_i / n)
// >         ≤0 になったら役割を書き換える。所有は着工時に立てる
//
// ★ **乱数を1回も引かない。**どの区画を選ぶかは村長が決める（正典4-2 の柱4）が、
//   「性格で歪む」のは #14 が持つ。ここは素の判断（いちばん安い区画）だけを持つ。
import { R, PW, roleOf, stateOf } from './parcel.js';
import { W } from './mapgen.js';
import { PPL } from './settle.js';

// ---------------------------------------------------------------------------
// §4-2 変換表　★表は「働き手10人が付いたときの月数」。**必要人月 ＝ 月数 × 10**
// ---------------------------------------------------------------------------
const X = 0;   // 表の「×」＝ 変換できない
//                       畑   菜園 果樹  牧草 繊維 水田 拠点  植林(→森林)
const TABLE = {
  [R.PLAIN]:            [  6,   3,  24,   2,   6,  24,   4,   60],
  [R.WASTE]:            [ 36,  24,   X,  12,  36,  36,  18,   90],
  [R.WOOD]:             [ 18,  12,  30,  12,  18,   X,  12,    X],
  [R.RIVER]:            [ 48,   X,   X,  48,   X,   X,  48,    X],   // 埋め立て
  [R.WATER]:            [ 96,   X,   X,  96,   X,   X,  96,    X],   // 干拓
  [R.MTN]:              [  X,   X,   X,   X,   X,   X,  36,    X],   // 段丘
  [R.ORE]:              [  X,   X,   X,   X,   X,   X,  24,    X],
};
// ★ 草原由来の荒地は表で別行（畑18・菜園12・牧草6・繊維18・拠点10・植林72）。
//   層Bに「草原由来か」のビットが無いので、**厳しいほう（荒地36）に寄せている。**
//   分けるなら byte1 bit7（予備）を使う ── 2026-08-31 時点では分けていない。
const GRASS_WASTE =     [ 18,  12,   X,   6,  18,   X,  10,   72];

// 行の並び ＝ 変換先。**この順を変えない**（TABLE の列と対応している）
export const TO = [R.FIELD, R.GARDEN, R.ORCHARD, R.PASTURE, R.FIBER, R.PADDY, R.HOME, R.WOOD];
export const TO_NAMES = ['畑', '菜園', '果樹園', '牧草地', '繊維畑', '水田', '拠点地', '植林'];

/** 変換に要る人月。0 なら「×＝できない」 */
export function costOf(fromRole, toRole) {
  const col = TO.indexOf(toRole);
  if (col < 0) return 0;
  const row = TABLE[fromRole];
  if (!row) {
    // 人工7種どうしは「1〜6ヶ月で相互に」。いちばん軽い側（1ヶ月＝10人月）は採らず、
    // 表が幅でしか書いていないので**中央の3ヶ月＝30人月**を採る（新しい数を作らない読み）
    if (fromRole >= R.FIELD && fromRole <= R.HOME && toRole >= R.FIELD && toRole <= R.HOME)
      return fromRole === toRole ? 0 : 30;
    return 0;
  }
  return row[col] * 10;
}

// ---------------------------------------------------------------------------
// §4-3 工事キュー　★村ごと同時1件
// ---------------------------------------------------------------------------
export const KIND_NONE = 0, KIND_CLEAR = 1, KIND_BUILD = 2, KIND_PLANT = 3;   // byte1 bit3-4

export class Works {
  constructor() {
    this.p = [];        // 区画ID（村ID → 区画。undefined ＝ 工事なし）
    this.to = [];       // 変換先の役割
    this.left = [];     // 残り人月
    this.since = [];    // 着工した月
    this.done = 0;      // 通算の完成件数
    this.started = 0;
  }
  has(v) { return this.p[v] !== undefined; }
  clear(v) { this.p[v] = undefined; this.to[v] = 0; this.left[v] = 0; }
}

/**
 * 村長が区画を選ぶ。**いちばん安い（人月が最小の）区画。**同点なら地力の高いほう。
 * ★ 正典「オーナーが言えるのは『どの拠点に・何を・何区画』まで。どの区画を選ぶかは村長」
 * @returns {number} 区画ID。無ければ −1
 */
export function pickParcel(land, L, v, toRole) {
  const cells = land.cells[v];
  if (!cells) return -1;
  let best = -1, bestCost = Infinity, bestFert = -1;
  for (const p of cells) {
    if (L.b1[p] & 0x18) continue;                       // すでに工事中
    const from = roleOf(L, p);
    if (from === toRole) continue;
    const c = costOf(from, toRole);
    if (!c) continue;
    // ★ 自然を潰すのは承認カードだけ（§9-3 抜け道4）。川・海湖・鉱脈・山には触れない
    if (from === R.RIVER || from === R.WATER || from === R.ORE || from === R.MTN) continue;
    const f = from === R.WOOD ? 0 : stateOf(L, p);      // 森林の状態値は樹齢であって地力ではない
    if (c < bestCost || (c === bestCost && f > bestFert)) { best = p; bestCost = c; bestFert = f; }
  }
  return best;
}

/** 着工する。所有は claim 済みなので立て直さない（§4-3「所有は着工時に立てる」＝ claim のこと） */
export function start(works, land, L, v, toRole, tick) {
  if (works.has(v)) return false;
  const p = pickParcel(land, L, v, toRole);
  if (p < 0) return false;
  const from = roleOf(L, p);
  const cost = costOf(from, toRole);
  if (!cost) return false;
  works.p[v] = p; works.to[v] = toRole; works.left[v] = cost; works.since[v] = tick;
  const kind = toRole === R.WOOD ? KIND_PLANT : (toRole === R.HOME ? KIND_BUILD : KIND_CLEAR);
  L.b1[p] = (L.b1[p] & ~0x18) | (kind << 3);
  works.started++;
  return true;
}

/**
 * 完成させる。**§9-3 抜け道1・2 の塞ぎがここに入っている。**
 *   抜け道1「荒地→牧草地→畑 が半額になる」→ **変換は地力を持ち越す**（荒地の地力は0）
 *   抜け道2「開墾直後の地力が未定義」   → 肥沃度のコピーは**自然を初めて人工化する1度だけ**
 */
export function finish(g, L, works, land, v) {
  const p = works.p[v], to = works.to[v];
  const from = roleOf(L, p);
  let state;
  if (to === R.WOOD) {
    state = 0;                                  // 植えたばかりの森は樹齢0（伐り頃は8）
  } else if (from === R.WOOD) {
    // 森林の状態値は**樹齢**であって地力ではないので、持ち越せない。
    // 「自然を初めて人工化する」ときなので、里マスの肥沃度を1度だけ写す（抜け道2の塞ぎ）
    const jx = ((p % PW) / PPL) | 0, jy = (((p / PW) | 0) / PPL) | 0;
    state = g.fert[jy * W + jx] | 0;
  } else {
    state = stateOf(L, p);                      // ★ 持ち越す（抜け道1の塞ぎ。荒地は0のまま）
  }
  if (state > 15) state = 15; if (state < 0) state = 0;
  L.b0[p] = to | (state << 4);
  L.b1[p] &= ~0x18;                             // 工事の種別を落とす
  if (from !== R.WOOD && to !== R.WOOD) L.b1[p] |= 2;   // 「元は自然だった」＝植林で戻せる
  works.clear(v);
  works.done++;
  land.recap(v);                                // ★ 定員と地力を数え直す
}

/**
 * 毎月。**乱数を引かない。**
 * @param men   村ID → その月に工事へ付いた人数
 * @param q     村ID → その村の工事班の Σq/n（正典 §4-3 の「割り当て人数 ×(Σq_i/n)」）
 * @param want  村ID → 次に何を作るか（役割）。undefined なら着工しない
 */
export function worksMonth(g, L, works, land, V, tick, men, q, want) {
  let progressed = 0, finished = 0;
  for (let v = 0; v < V.len; v++) {
    if (!V.a.alive[v]) continue;
    if (!works.has(v)) {
      const to = want(v);
      if (to !== undefined && to >= 0) start(works, land, L, v, to, tick);
      continue;
    }
    const n = men[v] | 0;
    if (n <= 0) continue;
    works.left[v] -= n * q[v];
    progressed++;
    if (works.left[v] <= 0) { finish(g, L, works, land, v); finished++; }
  }
  return { progressed, finished };
}

/** その村が畑を何枚持っているか（§4-4 の輪作が「畑6区画」を要求する） */
export function countRole(land, L, v, role) {
  let n = 0;
  for (const p of land.cells[v] ?? []) if (roleOf(L, p) === role) n++;
  return n;
}

/**
 * §7-2　**未開率 → 疫病・火災の頻度**。開墾の代償。
 * > 「密度」の分母を、その村の13区画のうち**未開のまま残っている区画数**に置き換える
 * >   未開率 f = 未開区画数 / 13
 * >   倍率 = clamp(0.6, 1.8, 1 + 0.8 × (0.231 − f) / 0.231)
 * 表：未開0→1.80／1→1.53／**3→1.00（三圃の既定）**／6→0.60
 * ★ 未開 ＝ 平野・荒地・樹齢<8の森林
 */
export const WILD_REF = 3 / 13;                 // 0.2308。表の「未開3区画で倍率1.00」がこれ
export function wildRatio(land, L, v) {
  const cells = land.cells[v] ?? [];
  if (!cells.length) return WILD_REF;
  let wild = 0;
  for (const p of cells) {
    const role = roleOf(L, p);
    if (role === R.PLAIN || role === R.WASTE) wild++;
    else if (role === R.WOOD && stateOf(L, p) < 8) wild++;
  }
  return wild / 13;                             // ★ 分母は claim の枚数ではなく 13（正典どおり）
}
export function densityMul(f) {
  const m = 1 + 0.8 * (WILD_REF - f) / WILD_REF;
  return m < 0.6 ? 0.6 : m > 1.8 ? 1.8 : m;
}

// ---------------------------------------------------------------------------
// §4-4 輪作 ／ §4-5 地力の年次　★ここが無いと土地は一度傷んだら二度と戻らない
// ---------------------------------------------------------------------------
/**
 * §4-4 の表そのまま。**産出の1人あたり（FARM_YIELD 2.6）は輪作で変えない。**
 * 変えるのは (a) 畑区画の定員 CAP[畑] と (b) 地力の年次変化 だけ
 * → 正典 #3-(h) の 1.764×q が、どの輪作を選んでも1文字も動かない
 */
export const ROTATION = [
  { key: '連作', cap: 10, fert: -2,   need: 4 },   // 土地を最も少なく使う。地力8から4年で0
  { key: '二圃', cap:  5, fert: -0.5, need: 8 },   // 16年もつ。土地を倍要る
  { key: '三圃', cap:  7, fert:  0,   need: 6 },   // ★既定。永久に回る（畑・豆・休）
  { key: '四圃', cap:  5, fert: +0.5, need: 8 },   // 地力が上がる ＝ **土地を治す道具**
];
export const ROT_MONO = 0, ROT_TWO = 1, ROT_THREE = 2, ROT_FOUR = 3;

/**
 * その村が実際に回せる輪作。**正典8「三圃は畑を6区画持たないと選べない。
 * 13区画のうち6枚が畑にならない村は連作しかできない」** ── 望みを区画数で切り下げる。
 * ★ 地力が基準を割っている村は、8区画あれば**四圃へ寄せて土地を治す**（§4-4「土地を治す道具」）
 */
export function rotationOf(land, L, v, want = ROT_THREE) {
  const fields = countRole(land, L, v, R.FIELD);
  let s = 0, n = 0;
  for (const p of land.cells[v] ?? []) {
    const role = roleOf(L, p);
    if (role < R.FIELD || role > R.PADDY) continue;
    s += stateOf(L, p); n++;
  }
  const avg = n ? s / n : 8;
  // ★★ **村長は連作を選ばない。**★★
  //   正典8「三圃は畑を6区画持たないと選べない。13区画のうち6枚が畑にならない村は
  //   連作しかできない」は**オーナーの選択肢の制約**であって、村長の既定ではない。
  //   連作は「戦争の前の4年なら正しい」という賭け（§4-4 柱7）で、地力が −2/年 ＝ 4年で土地が死ぬ。
  //   ★ 自動で落とすと、**畑2枚で始まる娘村（B-39）が全部4年で土地を殺す**
  //     ── 実測：300年・4種すべてが絶滅（2026-08-31）。
  //   三圃は畑が何枚でも回る（定員が枚数×7 になるだけ）ので、**これを床にする。**
  //   地力が基準を割っていて、かつ8区画あるときだけ**四圃へ寄せて土地を治す**
  // ★ 柱1：**オーナーが既定から動かしたカードは、村長が上書きしない。**
  //   連作は「戦争の前の4年なら正しい」賭けなので、勝手に四圃へ寄せたら判断を消すことになる。
  //   区画が足りない輪作だけは回せないので、回せる中でいちばん近いものへ落とす
  if (want !== ROT_THREE) return fields >= ROTATION[want].need ? want : ROT_THREE;
  // 既定（三圃）のままなら、傷んだ土地は村長の判断で四圃へ寄せて治す
  if (avg < 8 && fields >= ROTATION[ROT_FOUR].need) return ROT_FOUR;
  return ROT_THREE;
}

/**
 * §4-5　**毎年12月に更新（人工区画のみ）**
 * ```
 * 畑・水田 … 輪作カードの表 ／ 繊維畑 −3 ／ 菜園 +1 ／ 牧草地 +2 ／ 果樹園 0
 * 森林 … 樹齢（§4-6：植えた月に0、毎月 +0.25）／ 荒地・平野 0
 * ★ 地力が0になった人工区画は、翌年1月に 荒地 へ落ちる（元自然bitは保つ）
 * ```
 * @returns {{changed:number, ruined:number}} ruined ＝ 荒地へ落ちた区画
 */
export const FERT_YEAR = { [R.FIBER]: -3, [R.GARDEN]: +1, [R.PASTURE]: +2, [R.ORCHARD]: 0 };
export function fertYear(L, land, V, rotOf) {
  let changed = 0, ruined = 0;
  for (let v = 0; v < V.len; v++) {
    if (!V.a.alive[v]) continue;
    let touched = 0;                                   // ★ 村ごとに数える（累積させない）
    const rot = ROTATION[rotOf ? rotOf(v) : ROT_THREE];
    for (const p of land.cells[v] ?? []) {
      const role = roleOf(L, p);
      if (role < R.FIELD || role > R.PADDY) continue;
      const d = (role === R.FIELD || role === R.PADDY) ? rot.fert : (FERT_YEAR[role] ?? 0);
      if (!d) continue;
      let f = stateOf(L, p) + d;
      if (f > 15) f = 15;
      if (f <= 0) {                       // ★ 0 になった人工区画は荒地へ落ちる（元自然bitは保つ）
        L.b0[p] = R.WASTE;                //   荒地の地力は0（§9-3 抜け道1）
        ruined++;
      } else {
        L.b0[p] = role | (Math.round(f) << 4);
      }
      changed++; touched++;
    }
    if (touched) land.recap(v);
  }
  return { changed, ruined };
}

/** §4-6　植えた森が育つ（毎月 +0.25、60ヶ月で樹齢15）。★ 樹齢<8 は「未開」に数える */
export function forestMonth(L, land, V) {
  for (let v = 0; v < V.len; v++) {
    if (!V.a.alive[v]) continue;
    for (const p of land.cells[v] ?? []) {
      if (roleOf(L, p) !== R.WOOD) continue;
      const a = stateOf(L, p);
      if (a >= 15) continue;
      // 状態値は整数4bitなので、4ヶ月に1つ上げる（＝ +0.25/月）
      if ((land.px[v] + p) % 4 === 0) L.b0[p] = R.WOOD | ((a + 1) << 4);
    }
  }
}
