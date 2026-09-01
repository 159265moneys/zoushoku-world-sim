// 斥候 ── #17 §6-8（正典9540）
//
// > | **斥候**（軍10職） | **幅3里の帯**を進む。月に **12里マス**（1里＝徒歩半日＝月30里、
// >   往復と踏査で実効半分）。**同時最大3人** | 帯が既知、中心線が一時的に可視 |
// >   **産出に出ない。獣害・遭難で月2.5%死ぬ** |
//
// ★ **なぜ要るか**（2026-08-31 の実測）：分村の候補地が落ちる理由は
//   **最小間隔3里が77.8%・霧が15.1%**。霧は村の周りしか晴れないので、
//   **外向きの分村先が「未知」で弾かれ、開拓が村の可視半径ぶんずつしか進まない。**
//   正典1740「霧が晴れるのは：**斥候**／行商／分村／戦争」の1本目が無かった。
//
// ★ 代金は正典9546 の検算そのまま：「55人から3人抜くと産出 117.3 → 110.9（−5.5%）。
//   **豊かな村しか探索できない。貧しい国は地図が広がらないまま。**」
import * as F from './fog.js';
import { W } from './mapgen.js';

export const SCOUT_MAX = 3;          // 同時最大3人（正典9540）
export const SCOUT_SPEED = 12;       // 月に12里マス
export const SCOUT_BAND = 1;         // 幅3里の帯 ＝ 中心から±1里
export const SCOUT_DEATH = 0.025;    // 獣害・遭難で月2.5%死ぬ
export const SCOUT_RANGE = 60;       // これ以上離れたら引き返す（＝消える）。往復の実効
// ★★ **豊かな村しか探索できない**（正典9546）★★
//   検算は「**55人から3人抜く**と産出 117.3 → 110.9（−5.5%）」＝ **斥候1人につき働き手18人**。
//   これを門にしないと、10人の村から1人抜いて産出が2割落ち、世界が死ぬ
//   （実測：門なしで 120年40種の絶滅率が **90%**）。
//   正典の「貧しい国は地図が広がらないまま」は、まさにこの門のこと。
export const WORKERS_PER_SCOUT = Math.round(55 / 3);   // 18
export const DEATH_ACCIDENT = 3;     // 死因は事故（#9-D の3）

/** 出ている斥候。★ 個体そのものを持つ（`who` が死んだら消える） */
export class Scouts {
  constructor() { this.who = []; this.x = []; this.y = []; this.dx = []; this.dy = []; this.n = 0;
                  this.sent = 0; this.lost = 0; this.tiles = 0; }
  get count() { return this.who.length; }
}

/** 8方位。★ 乱数で選ばない ── 出す順に回して、同じ方角ばかり見ないようにする */
const DIRS = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];

/**
 * 斥候の1ヶ月。★ 乱数は**斥候1人につき必ず1回**（掟：分岐で回数を変えない）。
 * @param want    出したい人数（軍務局のカード「斥候の数」。0〜3）
 * @param workers 出発する村の働き手の数。**18人につき1人まで**（正典9546）
 * @param pick   () → 出せる働き手の添字。無ければ −1
 * @param homeOf () → 出発点 [tx, ty]
 * @param onDead (i) → 死んだ斥候の始末（world 側が P.kill する）
 */
export function scoutMonth(sc, fog, rng, want, workers, pick, homeOf, alive, onDead, onReturn = null) {
  // ---- 死んでいる／村から消えた者を落とす ----
  for (let k = sc.who.length - 1; k >= 0; k--) {
    if (!alive(sc.who[k])) { drop(sc, k); }
  }
  // ---- 足りなければ出す。★ 出せる働き手が居ないときは出さない（貧しい国は広がらない）----
  // ★ 出せる上限は「働き手 ÷ 18」でも切る（正典9546）。貧しい国は広がらない
  const cap = Math.max(0, Math.min(SCOUT_MAX, want | 0, Math.floor(workers / WORKERS_PER_SCOUT)));
  while (sc.who.length < cap) {
    const i = pick();
    if (i < 0) break;
    const h = homeOf();
    if (!h) break;
    const d = DIRS[sc.sent % DIRS.length];
    sc.who.push(i); sc.x.push(h[0]); sc.y.push(h[1]); sc.dx.push(d[0]); sc.dy.push(d[1]);
    sc.sent++;
  }
  // ---- 進む・晴らす・死ぬ ----
  for (let k = sc.who.length - 1; k >= 0; k--) {
    const r = rng.next();                       // ★ 当たらなくても必ず1回
    // 進む（12里マス）。帯は幅3里 ＝ 中心から±1
    for (let step = 0; step < SCOUT_SPEED; step++) {
      sc.x[k] += sc.dx[k]; sc.y[k] += sc.dy[k];
      if (sc.x[k] < 1 || sc.y[k] < 1 || sc.x[k] >= W - 1 || sc.y[k] >= W - 1) { sc.x[k] -= sc.dx[k]; sc.y[k] -= sc.dy[k]; break; }
      F.reveal(fog, sc.x[k], sc.y[k], SCOUT_BAND, 1);   // 帯が既知
      sc.tiles++;
    }
    F.reveal(fog, sc.x[k], sc.y[k], 0, 2);              // 中心線が一時的に可視
    if (r < SCOUT_DEATH) { onDead(sc.who[k]); sc.lost++; drop(sc, k); continue; }
    // 遠すぎたら引き返した扱いで消える（次の月にまた出る）
    const h = homeOf();
    if (h) {
      const dx = sc.x[k] - h[0], dy = sc.y[k] - h[1];
      if (dx * dx + dy * dy > SCOUT_RANGE * SCOUT_RANGE) { if (onReturn) onReturn(sc.who[k]); drop(sc, k); }
    }
  }
  return { out: sc.who.length, sent: sc.sent, lost: sc.lost };
}

function drop(sc, k) {
  sc.who.splice(k, 1); sc.x.splice(k, 1); sc.y.splice(k, 1); sc.dx.splice(k, 1); sc.dy.splice(k, 1);
}
