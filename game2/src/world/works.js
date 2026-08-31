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
