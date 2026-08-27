// 層B ── 里マスを16区画に展開する（#17 §2-4 のバイト割り／§3-2 の展開表）
//   1里マス（5km四方・2,500ha） → 4×4 の16区画（1区画 1.25km四方・156.25ha）
//   世界 384×384里マス → 1,536×1,536区画 ＝ 2,359,296区画 × 2バイト ＝ 4.50MB
import { W, N, T, ORE } from './mapgen.js';

export const PW = W * 4;              // 区画の幅 1,536
export const PN = PW * PW;            // 2,359,296

// 役割16種（#17 §4-1。これ以上増やさない）
export const R = {
  WOOD:0, RIVER:1, WATER:2, ORE:3, MTN:4, WASTE:5, PLAIN:6,          // 自然7
  FIELD:7, GARDEN:8, ORCHARD:9, PASTURE:10, FIBER:11, PADDY:12, HOME:13,  // 人工7
  BUILDING:14, DEAD:15,
};
// byte1 のビット
export const B1 = { OWNED:1, WASNAT:2, VIRGIN:4, WORK:0x18, COAST:0x20, SILVER:0x40 };

// §3-2 展開表：母地形 → 16区画の内訳
const EXP = {
  [T.SEA]:      [[R.WATER,16]],
  [T.LAKE]:     [[R.WATER,16]],
  [T.MARSH]:    [[R.RIVER,3],[R.PLAIN,9],[R.WASTE,4]],
  [T.PLAIN]:    [[R.PLAIN,16]],
  [T.GRASS]:    [[R.PLAIN,12],[R.WASTE,4]],
  [T.WOOD]:     [[R.WOOD,7],[R.PLAIN,9]],
  [T.JUNGLE]:   [[R.WOOD,13],[R.PLAIN,3]],          // 森林13は原生bitを立てる
  [T.HILL]:     [[R.PLAIN,8],[R.WOOD,4],[R.MTN,4]],
  [T.MTN]:      [[R.MTN,12],[R.WASTE,4]],
  [T.ALP]:      [[R.DEAD,16]],
  [T.ICE]:      [[R.DEAD,16]],
  [T.WASTE]:    [[R.WASTE,14],[R.PLAIN,2]],
  [T.SAND]:     [[R.DEAD,12],[R.WASTE,4]],
  [T.ROCK]:     [[R.MTN,10],[R.WASTE,6]],
  [T.SALTLAKE]: [[R.WATER,12],[R.WASTE,4]],         // 海湖12は沿岸bitを立てる
};

// ★ 並べ方＝「順に詰める」（オーナー裁定 2026-08-27）
//   §3-2 は16枚の内訳しか決めておらず、4×4のどこに置くかを書いていなかった。
//   4通り測って決めた（100種・創世の村の13区画）:
//     順に詰める 畑にできる11.1枚(森林3.9) ／ 列ごと 11.1(3.6)
//     市松 10.4(2.1) ／ 2x2で散らす 9.8(2.2)
//   どれでも畑6枚は 100/100 で取れる（飢える世界0）が、市松と2x2は
//   §2-2 の標準村が要る森林3枚に届かない。森林がいちばん残る「順に詰める」を採る。
const SLOT = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];

// ★ 上書きがどの区画を食うかも §3-2 は書いていない。**山 → 荒地 → 平野 → 森林** の順に食う。
//   上書きは川3枚＋海湖2枚＋鉱脈4枚で最大9枚に達しうるので、どれを食うかが村の中身を決める。
//   4通り測った（100種・創世の村の claim 13区画。§2-2 の線は 畑6枚・森林3枚）:
//     森林→山→荒地→平野  畑100/100  森林 67/100   平均 畑10.1 森2.8
//     山→荒地→森林→平野  畑100/100  森林 96/100   平均 畑11.1 森4.4
//     **山→荒地→平野→森林  畑100/100（最小8）  森林100/100（最小3）  平均 畑10.5 森4.5** ← 採用
//   畑にも森にもならない 山 と、地力0の 荒地 を先に食う。そのうえで **森林を最後に守る** ──
//   畑は最小8枚で線(6)に余裕があるのに、森林は最小3枚で線(3)ちょうどしか無いため。
//   （森林が3枚を割ると §2-2 の crowd森 が 1.00 を割り、#3-(h) の産出135.8 がその世界だけ動く）
const EAT = [R.MTN, R.WASTE, R.PLAIN, R.WOOD, R.RIVER, R.WATER];

export function expand(g) {
  const b0 = new Uint8Array(PN);          // bit0-3 役割 ／ bit4-7 状態値
  const b1 = new Uint8Array(PN);          // 有主・元は自然・原生・工事・沿岸・含銀
  const rol = new Uint8Array(16), sta = new Uint8Array(16), flg = new Uint8Array(16);

  for (let ty = 0; ty < W; ty++) for (let tx = 0; tx < W; tx++) {
    const ti = ty * W + tx, ter = g.ter[ti];
    rol.fill(0); sta.fill(0); flg.fill(0);

    // ── 展開
    let k = 0;
    for (const [kind, n] of (EXP[ter] || [[R.WASTE,16]]))
      for (let a = 0; a < n; a++) rol[SLOT[k++]] = kind;
    if (ter === T.JUNGLE) for (let s = 0; s < 16; s++) if (rol[s] === R.WOOD) flg[s] |= B1.VIRGIN;
    if (ter === T.SALTLAKE) for (let s = 0; s < 16; s++) if (rol[s] === R.WATER) flg[s] |= B1.COAST;

    // ── 上書き（§3-2 の 1→2→3）。食う順は EAT
    const eat = (kind, count, mark) => {
      for (const victim of EAT) {
        for (let s = 0; s < 16 && count > 0; s++) {
          if (rol[SLOT[s]] !== victim) continue;
          rol[SLOT[s]] = kind; flg[SLOT[s]] = mark ? (flg[SLOT[s]] | mark) : flg[SLOT[s]]; count--;
        }
        if (count === 0) return;
      }
    };
    if (g.land[ti]) {
      if (g.river[ti] > 0) eat(R.RIVER, g.river[ti], 0);      // 1. 川の等級ぶん
      if (g.coast[ti] >= 2) eat(R.WATER, 2, B1.COAST);        // 2. 沿岸なら2区画を海湖に
      if (g.ore[ti]) eat(R.ORE, 4, g.silver[ti] ? B1.SILVER : 0);  // 3. 鉱種があれば4区画
    }

    // ── 4. 状態値の初期値
    const fert = g.fert[ti];
    for (let s = 0; s < 16; s++) {
      const v = rol[s];
      if (v === R.WOOD) { sta[s] = 15; flg[s] |= B1.WASNAT; }   // 樹齢15。伐っても植林で戻せる
      else if (v === R.PLAIN) sta[s] = fert;                    // 畑になりうる＝肥沃度をコピー
      else if (v === R.WASTE) sta[s] = 0;                       // ★ 荒地の地力は0（§9-3 の抜け道1の塞ぎ）
      const p = ((ty * 4 + (s >> 2)) * PW) + (tx * 4 + (s & 3));
      b0[p] = v | (sta[s] << 4); b1[p] = flg[s];
    }
  }
  return { b0, b1 };
}

// 便利：区画の役割と状態値
export const roleOf  = (L, p) => L.b0[p] & 15;
export const stateOf = (L, p) => L.b0[p] >> 4;

// ★ #17 §9-2 検査3 の錠 ── 職の可否は**必ず層Bで**判定する。
//   層Aの鉱種bitは地質図であって、鉱脈区画を4枚とも潰したら職は消えなければならない。
//   鉱種を知りたい所は必ずこの関数を通す（g.ore を直接読まない）。
export function minable(g, L, tx, ty) {
  const kind = g.ore[ty * W + tx];
  if (!kind) return 0;
  for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++)
    if (roleOf(L, ((ty * 4 + ly) * PW) + (tx * 4 + lx)) === R.ORE) return kind;
  return 0;                       // 4枚とも潰れた ＝ 掘れない（地質図には残る）
}
