// 評判 R（正典 #6-A）。**公の評価。誰から見ても同じ1つの数字**（裁定を仰ぐ.md の決着）。
//
// 正典3-2 の「累積 × 風化（年に −1）」は掛け算と引き算が混ざっていて演算にならないので、
// **「累積」のち「0へ向かって年1点ずつ」**に直してある。
// これで「−1」という数字がそのまま生き、かつ無名（0）の者が下限へ沈まない。
//
//   出来事が起きた月：  R ← clamp(−100, +100, R + ΔR)
//   毎月（生存者のみ）：R ← R − sign(R) × min(|R|, 1/12)     ★ 0を跨いで振動しない
//   死亡した月：        以後 R を一切更新しない（死者の評判は凍結＝そのまま歴史になる）
//   捕虜として帰化：    R ← 0（正典4-4「②③④はゼロから始まる」）
//
// ★ 生きている者の評判は必ず0へ戻る。**評判100を維持する道は存在しない。**
//   これが「名声だけでは傲慢は満たされない」（#3 §2）の裏付けになっている。

export const REP_MIN = -100, REP_MAX = 100;
export const REP_DECAY_PER_MONTH = 1 / 12;      // 年−1

// 点（正典3-2 の表そのまま。1点も足さない・引かない）
export const REP_EVENT = {
  発掘された: 25,        // オーナーに発掘された
  施し: 20,              // 飢饉の年に施しをした
  戦の手柄: 15,
  役職に就いた: 10,
  家督を継いだ: 8,
  子を5人育てた: 5,      // 一生に1度
  長生き: 5,             // 60歳以上まで生きた。一生に1度
  家督争いに負けた: -5,
  罷免: -15,             // 罷免・左遷された
  戦で逃げた: -20,
};

// 一生に1度の出来事のビット（repOnce）
export const ONCE_RAISED5 = 1 << 0, ONCE_OLD = 1 << 1;
export const RAISED_AGE = 5;       // 何歳まで育てたら「育てた」と数えるか
export const RAISED_COUNT = 5;
export const OLD_AGE = 60;

/** 出来事。R を動かす */
export function award(P, i, delta) {
  const A = P.a;
  if (!A.alive[i]) return A.rep[i];               // 死者の評判は凍結
  let r = A.rep[i] + delta;
  if (r < REP_MIN) r = REP_MIN; else if (r > REP_MAX) r = REP_MAX;
  A.rep[i] = r;
  return r;
}

/**
 * 評判の月次。風化と、いま供給源が在る出来事3つ。
 * ★ 供給源が無いのは：発掘・施し・戦の手柄・役職・家督争い・罷免・戦で逃げた の7つ。
 *   オーナーの動詞（#6部b）と戦争（O-27）と役職（#10）が入る日に生きる。
 * @param onRaised 5歳になった子の親を数え上げるための入口（house.js が持っている親子の線）
 */
export function reputationMonth(P, tick) {
  const A = P.a;
  let events = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const y = (A.ageMonths[i] / 12) | 0;

    // 子が5歳になったら、親の「育てた数」を1つ増やす（O(1)。逆引きテーブルを作らない）
    if (A.ageMonths[i] === RAISED_AGE * 12) {
      for (const p of [A.mother[i], A.father[i]]) {
        if (p < 0 || p >= A.len || !A.alive[p]) continue;
        if (A.raised[p] < 255) A.raised[p]++;
        if (A.raised[p] >= RAISED_COUNT && !(A.repOnce[p] & ONCE_RAISED5)) {
          A.repOnce[p] |= ONCE_RAISED5;
          award(P, p, REP_EVENT.子を5人育てた); events++;
        }
      }
    }
    // 60歳以上まで生きた（一生に1度）
    if (y >= OLD_AGE && !(A.repOnce[i] & ONCE_OLD)) {
      A.repOnce[i] |= ONCE_OLD;
      award(P, i, REP_EVENT.長生き); events++;
    }

    // 風化。0へ向かって年1点ずつ。0を跨いで振動しない
    const r = A.rep[i];
    if (r > 0) A.rep[i] = r - Math.min(r, REP_DECAY_PER_MONTH);
    else if (r < 0) A.rep[i] = r + Math.min(-r, REP_DECAY_PER_MONTH);
  }
  return { events };
}

// ---------------------------------------------------------------------------
// 影響力（正典 #6-B）
// ---------------------------------------------------------------------------
//
//   影響力 I = clamp(0, 100, ( 評判 R ＋ 立場 ＋ つながり点 ) / 3 )
//     立場       = 爵位の段 × 10 ＋ 役職の段 × 15      ∈ [0, 95]
//     つながり点 = min(100, 5 × n)                     n ＝ 好き嫌い[j→i] ≥ 60 の人数
//
// ★ **分母3の根拠**：3項の上限和が 100 + 95 + 100 = 295。3で割ると 98.3 で、
//   **係数を1つも発明せずに 0〜100 に収まる唯一の割り方。**
//
// ★ 何に効くか
//     宗教が起きる門         I ≥ 35（平常）／25（確定イベントの厄災）  … #6-C
//     謀反の実行の門         I ≥ 35                                    … #4-(e)
//     異端狩りの標的の順序   同じ確率の中では I の高い者から            … #7
//     国民力③               I そのもの                                … 正典4-4
//
// ★ 正典の検算：無名の平民5.0／慕われた老人25.0／村長（男爵）36.7／
//   街長（伯爵）60.0／局長（公爵）85.0／粛清された者0
//   ＝ **T_i=35 は「村長格だけが通る」線。**

export const INFLUENCE_DIV = 3;
export const TITLE_STEP = 10, POST_STEP = 15;

/** 立場 ＝ 爵位の段×10 ＋ 役職の段×15 */
export const standing = (titleStep, postStep) => titleStep * TITLE_STEP + postStep * POST_STEP;

/** 影響力 I */
export function influence(rep, titleStep, postStep, tiePoint) {
  const v = (rep + standing(titleStep, postStep) + tiePoint) / INFLUENCE_DIV;
  return v < 0 ? 0 : v > 100 ? 100 : v;
}
