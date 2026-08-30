// しがらみ（人と人のつながり。正典3-2）。
//
// **人と人のつながりを、数字1つに潰さない。潰すと相手が消える。**
// 「妻」「弟を殺した相手」「借りがある男」は、本人の中にはなく、**2人のあいだにある。**
//
// 潰すと柱が2本折れる：
//   ・**配役が敵対関係の主エンジン** … 誰を誰の上に置いたかで恨みが生まれる。相手が消えれば生まれない
//   ・**恨みが家系に継承される**     … 「誰への恨みか」が無ければ継承できない
//
// ★ 評判と好き嫌いは別物（裁定を仰ぐ.md の決着）
//     評判   … 公の評価。**個体に1つの数字。**誰から見ても同じ。局長に見える → reputation.js
//     好き嫌い … 私の感情。**2人のあいだに1つずつ。**人によって違う。**局長には見えない** → ここ
//
// ★ 1人あたりの線は**上位20本だけ**持つ（0-3e）。
//   ダンバー数150は「人が持ちうる関係の数」であって、保持する辺の数ではない。
//   #6-B が「つながり点は20本で満点」と確定させているのと同じ数。
//   上限が無いと無限に増える。実測の目安：10万人 × 20本 ＝ 200万本で 1ヶ月 8.1ms・40MB。
//
// ★ **辺が無い相手の好き嫌いは、相性の初期値で読む**（正典 第6部b）。
//   全員ぶんの辺を張らない。相性は式なので、要るときに引けばよい。

import * as S from '../core/stats.js';
import { make } from '../core/arrays.js';

export const SLOTS = 20;              // 1人あたりの線の本数
export const FEEL_MIN = 0, FEEL_MAX = 100;

// 線の種類（正典3-3 の派閥の線の順。上ほど強い）
export const T_NONE = 0;
export const T_BLOOD = 1;    // 1 血縁・姻戚。家門がそのまま政治単位
export const T_FAVOR = 2;    // 2 主従（恩顧）。オーナーが引き上げた者もここ
export const T_FAITH = 3;    // 3 信仰・宗派。★国をまたぐ唯一の線
export const T_FEUD  = 4;    // 4 怨恨（血讐）。★世代を越えて続く
export const T_COIN  = 5;    // 5 財・利害
export const T_LAND  = 6;    // 6 地縁。同じ村・同じ土地の出身
export const TIE_NAMES = ['—', '血縁', '恩顧', '信仰', '怨恨', '利害', '地縁'];

// ---- 相性（好き嫌いの初期値。正典3-6b） -----------------------------------
//   相性 ＝ 50 −（性格の隔たり）× 0.5
//   性格の隔たり ＝ 社交・情・誇り・度胸・信心・貪欲・正直さ の7つの差の平均
// ★ 7つは 13A/12A/10A/11A/13B/14A/14B と**全部ちがう腕**から取る。
//   同じ腕から2つ取ると相性が1軸に潰れ、派閥が遺伝から予測できてしまう。
export const AFFINITY_STATS = ['社交', '情', '誇り', '度胸', '信心', '貪欲', '正直さ'];
const AFF_IDS = AFFINITY_STATS.map(n => S.needId(n));
export const AFFINITY_MIN = 25, AFFINITY_MAX = 50;   // 範囲は25〜50。薄い

/** 相性。**辺が無い相手の好き嫌いはこれで読む**（25〜50・中央37） */
export function affinity(P, i, j) {
  const A = P.a;
  let d = 0;
  for (let k = 0; k < AFF_IDS.length; k++) {
    const s = AFF_IDS[k];
    d += Math.abs(P.effective(i, s) - P.effective(j, s));
  }
  const v = 50 - (d / AFF_IDS.length) * 0.5;
  return v < AFFINITY_MIN ? AFFINITY_MIN : v > AFFINITY_MAX ? AFFINITY_MAX : v;
}

// ---- 出来事の重み ----------------------------------------------------------
//
// ★ 正典が数で書いているのは3本だけ：
//     恩を受けた（引き上げられた）… **主への好き嫌い +25**（正典3-1 の rank 0→1 の行）
//     改宗した                   … 旧宗派の信徒から本人へ **−20**（#8 §6）
//     同じ信仰／違う信仰          … 年 ±0.5 ×（団結/63 ・ 排他性/60）（#8 §8）
//   残り（血縁・地縁・殺害・抜かれた）は「大きく＋」「小さく＋」「大きく−」という
//   **言葉でしか書かれていない。**下の値は、上の3本を目盛りにして引いた**暫定値**で、
//   裁定を仰ぐ.md の **B-14**（第2次・2026-08-29）に上げた。
//   ★勝手に決めた値ではないが、正典が決めた値でもない。
// ★★ この暫定値が社会の仕組みを全部止めている（B-14 に詳述）：
//   相性の上限は 50（実測の最大 48.5）。だが「誘い手」の門は 55、「つながり」の門は 60。
//   ＝ **出来事が起きていない相手とは、永久に線が繋がらない。**
//   → つながりの数が伸びない → 影響力が門35に届かない（実測の最大16.7）
//   → 宗教が1件も起きない → 神への不満が溜まらない → 諦観・狂信・棄教が一度も発火しない
export const W = {
  伴侶: 25,        // 「大きく＋」＝ 恩義 +25 と同じ桁に置いた
  親子: 25,
  きょうだい: 20,
  恩顧: 25,        // ★ 正典に数がある唯一の「大きく＋」
  地縁: 1.0,       // 「年数に比例して小さく＋」。★2026-08-29 実測で 0.5→1.0 に校正。
                   //   0.5 だと村長が門35を1人も通らず宗教が永久に起きない。
                   //   1.0 で村長の19%が通り、無役は0% ＝ 正典「村長格だけが通る線」そのもの
  家族を殺された: -40,   // 「大きく−。家系に継承される」
  抜かれた: -10,
  改宗された: -20, // ★ 正典に数がある（#8 §6）
};
export const TIE_POINT = 60;   // つながり点に数える線（#6-B。出来事が10点以上積まれた相手）

// ---------------------------------------------------------------------------
export class Ties {
  constructor(cap = 256) {
    // 1人あたり20枠。辺は**向きつき**（好き嫌いは i→j と j→i で別物）
    this.a = make(cap, {
      to: `i32*${SLOTS}`,        // 相手。-1 は空き
      delta: `i16*${SLOTS}`,     // 出来事の累積（相性は含まない。要るとき足す）
      type: `u8*${SLOTS}`,
      since: `u16*${SLOTS}`,     // いつから（月）
    });
    for (let k = 0; k < SLOTS; k++) this.a.to[k].fill(-1);
    this.count = 0;              // 張られている線の本数
  }

  /**
   * 席を伸ばす。★ 伸ばした先を **−1 で埋め直す**こと。
   *   型付き配列の既定値は0で、0 は「0番の人への線」と区別が付かない。
   *   （ここを落とすと、256人目以降の枠が「0番への線で満杯」に見えて線が1本も張れない）
   */
  grow(n) {
    const before = this.a.cap;
    if (n <= before) return;
    this.a.ensure(n);
    for (let k = 0; k < SLOTS; k++) this.a.to[k].fill(-1, before);
  }

  /** i から j への線の枠。無ければ -1 */
  slot(i, j) {
    if (i >= this.a.cap) return -1;
    const A = this.a;
    for (let k = 0; k < SLOTS; k++) if (A.to[k][i] === j) return k;
    return -1;
  }

  /**
   * 好き嫌い[i → j]。**辺が無ければ相性で読む**（正典 第6部b）。
   * 25〜50 の相性に、出来事の累積を足したもの。0〜100 で頭打ち。
   */
  feel(P, i, j) {
    if (i === j) return FEEL_MAX;
    const base = affinity(P, i, j);
    const k = this.slot(i, j);
    const v = k < 0 ? base : base + this.a.delta[k][i];
    return v < FEEL_MIN ? FEEL_MIN : v > FEEL_MAX ? FEEL_MAX : v;
  }

  /**
   * 出来事で線を動かす。枠が満杯なら**いちばん薄い線を捨てる**（上位20本だけ持つ）。
   * ★ 捨てる判定は |delta| で見る。**恨みも濃い線**なので、強い負の線を捨てない。
   */
  link(i, j, delta, type, month = 0) {
    if (i === j || i < 0 || j < 0) return -1;
    this.grow(Math.max(i, j) + 1);
    const A = this.a;
    let k = this.slot(i, j);
    if (k < 0) {
      let empty = -1, weakest = 0;
      for (let s = 0; s < SLOTS; s++) {
        if (A.to[s][i] < 0) { empty = s; break; }
        if (Math.abs(A.delta[s][i]) < Math.abs(A.delta[weakest][i])) weakest = s;
      }
      if (empty >= 0) { k = empty; this.count++; }
      else {
        // 満杯。新しい線が既存のいちばん薄い線より濃くなければ張らない
        if (Math.abs(delta) <= Math.abs(A.delta[weakest][i])) return -1;
        k = weakest;
      }
      A.to[k][i] = j; A.delta[k][i] = 0; A.type[k][i] = type; A.since[k][i] = month;
    }
    let d = A.delta[k][i] + delta;
    if (d < -32768) d = -32768; else if (d > 32767) d = 32767;
    A.delta[k][i] = d;
    if (type > A.type[k][i] || A.type[k][i] === T_NONE) { /* 強い線（番号の小さい方）を残す */ }
    if (type !== T_NONE && (A.type[k][i] === T_NONE || type < A.type[k][i])) A.type[k][i] = type;
    return k;
  }

  /** 相互に張る（血縁・地縁のように向きの無い出来事） */
  linkBoth(i, j, delta, type, month = 0) {
    this.link(i, j, delta, type, month);
    this.link(j, i, delta, type, month);
  }

  /**
   * つながり点（#6-B）。**その人への**好き嫌いが 60 以上の人数 × 5、100で頭打ち。
   * ★ 20本で満点。★ 「正の人数」ではなく60以上にする理由：
   *   相性は25〜50 なので「正」だと村の12歳以上がほぼ全員数えられ、
   *   つながりが村の人口の関数になって評判と立場が埋没する。
   *   60は「出来事が10点以上プラスに積まれた相手」＝実際に何かがあった相手だけ。
   * ★ 逆引きテーブルを持たない（#15）ので、j 側の枠を見る。
   */
  incoming(P, j, candidates) {
    let n = 0;
    for (const i of candidates) {
      if (i === j) continue;
      if (this.slot(i, j) < 0) continue;          // 線が無い＝相性のまま＝60に届かない
      if (this.feel(P, i, j) >= TIE_POINT) n++;
    }
    return n;
  }
  static point(n) { return Math.min(100, 5 * n); }

  /** 死んだ者への線を畳む（枠を空ける）。恨みは #4 の grudge1 が別に持っている */
  dropDead(P, i) {
    const A = this.a;
    let n = 0;
    for (let k = 0; k < SLOTS; k++) {
      const j = A.to[k][i];
      if (j < 0) continue;
      if (!P.a.alive[j]) { A.to[k][i] = -1; A.delta[k][i] = 0; A.type[k][i] = T_NONE; n++; this.count--; }
    }
    return n;
  }

  bytes() { return this.a.bytes(); }
  bytesPerRow() { return this.a.bytesPerRow(); }
}

/**
 * つながりの数を**全員ぶん一気に**数える（#6-B）。
 *
 * ★ 素直に「その人へ向いている線」を村内総当たりで探すと O(人×村人数×20) になり、
 *   10万人・村100人で約3.8秒／月かかる。**前向きに1周する**と厳密に同じ答えが
 *   O(人×20) ＝ 200万回で出る（M-21 の実測 8.1ms／月 と同じ桁）。
 *
 * ★ さらに篩える：相性の上限は 50（AFFINITY_MAX）なので、
 *   `好き嫌い = 相性 + 出来事の累積 ≥ 60` には **累積 ≥ 10** が要る。
 *   これは近似ではなく厳密な足切りなので、相性の計算そのものを大半で省ける。
 *
 * @param out Int32Array（人数ぶん）。0で始めてここに数え上げる
 */
export const DELTA_MIN_FOR_POINT = TIE_POINT - AFFINITY_MAX;   // = 10
// ★ 上側の足切り。相性の**下限**は 25（AFFINITY_MIN）なので、
//   累積が 60−25 ＝ 35 以上あれば、相性がどんなに低くても好き嫌いは必ず60を超える。
//   → **相性を計算せずに数えてよい。**これも近似ではなく厳密。
//   地縁は年1.0ずつ積むので、35年連れ添った相手は全部この道を通る＝実測の大半がここ。
export const DELTA_ALWAYS_POINT = TIE_POINT - AFFINITY_MIN;    // = 35

// 相性に使う7ステの実効値を置く場所（呼び出しのあいだ使い回す）
let _aff = new Float64Array(0);

export function countIncoming(P, ties, out) {
  const A = ties.a, PA = P.a, n = Math.min(PA.len, ties.a.cap);
  out.fill(0);
  const NA = AFF_IDS.length;

  // ★★ **実効値を1人1回だけ計算する。**
  //   `P.effective()` は呼ばれるたびに状態12個の枠をまるごと作り直すので、
  //   `affinity` は1回で14回ぶん作っていた。20スロットぶん回すと1人あたり280回。
  //   実測：1,304人で 19.4ms／月 ＝ この関数だけで月の6割。
  //   ここで 7×人数 に落とす（**答えは1つも変わらない。同じ月の同じ状態を読むだけ**）。
  if (_aff.length < n * NA) _aff = new Float64Array(n * NA * 2);
  for (let i = 0; i < n; i++) {
    if (!PA.alive[i]) continue;
    const b = i * NA;
    for (let k = 0; k < NA; k++) _aff[b + k] = P.effective(i, AFF_IDS[k]);
  }

  for (let i = 0; i < n; i++) {
    if (!PA.alive[i]) continue;
    for (let k = 0; k < SLOTS; k++) {
      const j = A.to[k][i];
      if (j < 0 || j >= PA.len || !PA.alive[j]) continue;
      const d = A.delta[k][i];
      if (d < DELTA_MIN_FOR_POINT) continue;               // 相性が上限でも届かない
      if (PA.village[j] !== PA.village[i]) continue;       // 同じ村・同じ局・自分が治める村
      // ★ 相性が下限でも届く ＝ 相性を計算しない
      if (d >= DELTA_ALWAYS_POINT) { out[j]++; continue; }
      // 相性 ＝ 50 −（7ステの差の平均）× 0.5。上で作った表から読む
      const bi = i * NA, bj = j * NA;
      let dif = 0;
      for (let m = 0; m < NA; m++) { const x = _aff[bi + m] - _aff[bj + m]; dif += x < 0 ? -x : x; }
      let aff = 50 - (dif / NA) * 0.5;
      if (aff < AFFINITY_MIN) aff = AFFINITY_MIN; else if (aff > AFFINITY_MAX) aff = AFFINITY_MAX;
      if (aff + d >= TIE_POINT) out[j]++;
    }
  }
  return out;
}
