// 霧 ── 見え方の3段（#17 §6-6）と、晴れ方（§6-8）
//
// ★ 層A の余りビットに混ぜてはいけない。層Aは種から再生成できるがセーブに載せない。
//   霧は再生成できない遊び手固有の状態で、**セーブに載る唯一の地図データ**（144KB）。
//
// byte : bit0   既知（地形・川・海・鉱種が見える。ただし最後に見た年の状態）
//        bit1   可視（いまの状態が全部。区画1枚ずつ）
//        bit2-7 最後に見てから経過した年数 0..62（63 ＝ 63年以上前）
import { W, N } from './mapgen.js';

export const KNOWN = 1, SEEN = 2, AGE = 0xFC;
export const makeFog = () => new Uint8Array(N);          // 147,456B ＝ 144KB

export const isKnown = (f, i) => (f[i] & KNOWN) !== 0;
export const isSeen  = (f, i) => (f[i] & SEEN)  !== 0;
export const ageOf   = (f, i) => f[i] >> 2;

/** 円形に霧を晴らす。level 2＝可視（既知も立つ）／1＝既知だけ */
export function reveal(f, cx, cy, r, level) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy; if (y < 0 || y >= W) continue;
    const w = Math.floor(Math.sqrt(r2 - dy * dy));
    for (let dx = -w; dx <= w; dx++) {
      const x = cx + dx; if (x < 0 || x >= W) continue;
      const i = y * W + x;
      f[i] = (f[i] | KNOWN | (level >= 2 ? SEEN : 0)) & ~AGE;   // 見た年に戻す
    }
  }
}

/**
 * ★ 月の手順（この順で呼ぶ）
 *     1. beginMonth(f)          … 可視を全部消す
 *     2. fromSettlements(f, S)  … 拠点の中心2里を可視・外周4里を既知に
 *     3. scout / warReveal      … その月に動いている斥候と戦争
 *   ★ **可視は毎月ゼロから引き直す。**そうしないと斥候が通ったきり永久に可視のまま残り、
 *     §6-6 の要「既知だが可視でない ＝ 10年前に見た地図」が一度も発生しない
 */
export function beginMonth(f) { for (let i = 0; i < N; i++) f[i] &= ~SEEN; }

/** 拠点の周りを塗る（§6-8 拠点そのもの＝半径2里 可視／外周2〜4里 既知） */
export function fromSettlements(f, S, n = S.n, PPL = 4) {
  for (let k = 0; k < n; k++) {
    const cx = (S.vx[k] / PPL) | 0, cy = (S.vy[k] / PPL) | 0;
    reveal(f, cx, cy, 4, 1);                               // 外周 ＝ 既知
    reveal(f, cx, cy, 2, 2);                               // 中心 ＝ 可視
  }
}

/** 斥候：幅3里の帯を進む。月に12里マス進み、帯が既知・中心線が可視（§6-8） */
export function scout(f, x0, y0, dirRad, months = 1) {
  const steps = 12 * months;
  let x = x0, y = y0;
  const dx = Math.cos(dirRad), dy = Math.sin(dirRad);
  for (let s = 0; s < steps; s++) {
    x += dx; y += dy;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= W) break;
    reveal(f, ix, iy, 1, 1);      // 幅3里の帯（半径1里）＝ 既知
    const i = iy * W + ix;
    f[i] = (f[i] | KNOWN | SEEN) & ~AGE;                   // 中心線は一時的に可視
  }
  return { x, y };
}

/** 毎年1月：既知かつ非可視の里マスだけ +1（63で止める） */
export function ageFog(f) {
  for (let i = 0; i < N; i++) {
    if ((f[i] & KNOWN) === 0 || (f[i] & SEEN) !== 0) continue;
    const a = f[i] >> 2;
    if (a < 63) f[i] = (f[i] & ~AGE) | ((a + 1) << 2);
  }
}

export function stats(f, g) {
  let unknown = 0, known = 0, seen = 0, landKnown = 0, land = 0, oreKnown = 0, ore = 0;
  for (let i = 0; i < N; i++) {
    const k = f[i] & KNOWN, s = f[i] & SEEN;
    if (s) seen++; else if (k) known++; else unknown++;
    if (g.land[i]) { land++; if (k) landKnown++; }
    if (g.ore[i]) { ore++; if (k) oreKnown++; }
  }
  return { unknown, known, seen, landKnown, land, oreKnown, ore, bytes: f.byteLength };
}

// ───────────────────────────────────────────────────────────────
//  §6-8 の残り4つの晴らし方
// ───────────────────────────────────────────────────────────────

/**
 * 行商（町の職）── 通った里マスの半径1里が既知。
 * ★ **既知の里マスの間しか通れない。**知らない土地へは踏み込めない。
 *   だから行商は「新しく見つける」のではなく「知っている土地を繋ぐ」だけ。
 *   帯の縁（半径1里）が既知になるので、既知の領域が**少しずつ太る**。
 * 代金：産出に出ない／盗賊で月1.5%
 * @returns 通れたか（既知の道が繋がっていなければ false）
 */
export function peddler(f, x0, y0, x1, y1) {
  const from = new Int32Array(N).fill(-1);
  const q = [y0 * W + x0]; from[q[0]] = q[0];
  const goal = y1 * W + x1;
  let hit = false;
  for (let h = 0; h < q.length && !hit; h++) {
    const i = q[h], x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const j = ny * W + nx;
      if (from[j] >= 0 || (f[j] & KNOWN) === 0) continue;   // ★ 既知しか通れない
      from[j] = i; q.push(j);
      if (j === goal) { hit = true; break; }
    }
  }
  if (!hit) return false;
  for (let i = goal; i !== from[i]; i = from[i]) reveal(f, i % W, (i / W) | 0, 1, 1);
  return true;
}

/**
 * 分村 ── 親村から新村への直線と、新村の周り。規則は拠点と同じ（中心2里 可視／外周4里 既知）
 * ★ 「良い土地を見つけて分村すると、相手の斥候に見つかる」（§7-1）の裏返しでもある
 */
export function splitReveal(f, px, py, nx, ny) {
  const d = Math.max(Math.abs(nx - px), Math.abs(ny - py));
  for (let t = 0; t <= d; t++)
    reveal(f, Math.round(px + (nx - px) * t / d), Math.round(py + (ny - py) * t / d), 1, 1);
  reveal(f, nx, ny, 4, 1);
  reveal(f, nx, ny, 2, 2);
}

/**
 * 戦争 ── 相手国の「侵攻できる3村」の周り半径2里。開戦中は可視。
 * ★ 見えるのは自然の役割だけ（§6-6）。人工の7役割と拠点は「耕されている」の1bitに丸める。
 *   区画数を数えられると 4-3 の国力から耕地を引いて練度と人口が逆算でき、装置③が壊れる
 */
export function warReveal(f, targets) {
  for (const [x, y] of targets) reveal(f, x, y, 2, 2);
}
/** 終戦 ── 可視を既知へ落とす（見えていたものが記憶に変わる） */
export function warEnd(f, targets) {
  for (const [x, y] of targets) {
    const r2 = 4;
    for (let dy = -2; dy <= 2; dy++) { const yy = y + dy; if (yy < 0 || yy >= W) continue;
      for (let dx = -2; dx <= 2; dx++) { if (dx*dx + dy*dy > r2) continue;
        const xx = x + dx; if (xx < 0 || xx >= W) continue;
        f[yy * W + xx] &= ~SEEN; } }
  }
}

/**
 * 捕虜 ── 出身村の周り半径2里が既知になる。帰化時に1回だけ（正典4-5）。
 * ★ **記憶なので、帰化した年で止まる。**そこから普通に古びていく。
 *   10年後には「その者が国を出た年の地図」を10年前の情報として持っていることになる。
 *   斥候の「10年前に見た地図」と同じ仕掛けが、人間の側で起きる。
 */
export function captiveMemory(f, hx, hy) { reveal(f, hx, hy, 2, 1); }
