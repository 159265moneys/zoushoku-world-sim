// 派閥（正典3-3）。**乱数を1回も引かない。**
//
// > **派閥を手で作らない。人と人の線が密になっている塊を、派閥と呼ぶ。**
// > **線に乗るのは「好き嫌い」であって「評判」ではない。**
//
// ★ 線の種類には順がある（**上ほど強い**）。塊を見つけるときは上の線を重く数える：
//     1 血縁・姻戚 … 家門がそのまま政治単位
//     2 主従（恩顧）… 誰が誰に土地と地位を与えたか。オーナーが引き上げた者もここ
//     3 信仰・宗派 … **国をまたぐ唯一の線**
//     4 怨恨（血讐）… 家門どうしの確執。**世代を越えて続く**
//     5 財・利害   … ギルド、商人、債権債務
//     6 地縁       … 同じ村・同じ土地の出身
//
// ★ **怨恨（4）も線である。**憎み合っている家どうしは、互いを強く意識している＝同じ盤面にいる。
//   だが派閥は「組む相手」の塊なので、**塊に数えるのは好きの側だけ**にする。
//   恨みの側は #4 の恨み6本が別に持っている（二重に置かない・正典1061）。
//
// ★ 手順は**ラベル伝播**。1周ごとに「いちばん重い隣人のラベル」を採る。
//   O(人 × 枠20 × 周回) ＝ 線形。10万人でも動く（#12）。
//   同点は**添字の小さいラベル**を採る ＝ 決定的（乱数を引かない）。

import { SLOTS, T_NONE, T_BLOOD, T_FAVOR, T_FAITH, T_FEUD, T_COIN, T_LAND,
         TIE_POINT, affinityTable, feelWith } from './ties.js';

/** 線の重み。★ 正典3-3 の順（1が最強）をそのまま 6..1 に写す。数字を発明していない */
export const TYPE_W = new Float64Array(7);
TYPE_W[T_BLOOD] = 6; TYPE_W[T_FAVOR] = 5; TYPE_W[T_FAITH] = 4;
TYPE_W[T_FEUD] = 3;  TYPE_W[T_COIN] = 2;  TYPE_W[T_LAND] = 1;
TYPE_W[T_NONE] = 0;

export const JOIN_FEEL = TIE_POINT;   // 塊に数える線＝好き嫌い60以上（#6-B のつながり点と同じ線）
export const PASSES = 6;              // ラベル伝播の周回数
export const MIN_SIZE = 3;            // これ未満の塊は派閥と呼ばない

/**
 * 派閥を数え直す。★ 乱数を1回も引かない。年に1度呼ぶ。
 * @returns {{count, biggest, inFaction}}
 */
export function factionYear(P, ties) {
  const A = P.a, TA = ties.a, n = Math.min(A.len, TA.cap);
  const tab = affinityTable(P);

  // ---- 初期ラベル＝自分の添字 ----
  const lab = new Int32Array(n);
  for (let i = 0; i < n; i++) lab[i] = A.alive[i] ? i : -1;

  // ---- ラベル伝播 ----
  const score = new Map();
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (lab[i] < 0) continue;
      score.clear();
      // 自分のラベルにも重みを1つ持たせる（孤立した者が振動しない）
      score.set(lab[i], 1e-6);
      for (let k = 0; k < SLOTS; k++) {
        const j = TA.to[k][i];
        if (j < 0 || j >= n || lab[j] < 0) continue;
        const w = TYPE_W[TA.type[k][i]];
        if (!w) continue;
        // ★ 塊に数えるのは**好きの側だけ**。恨みは #4 が別に持っている
        const f = feelWith(tab, ties, i, j);
        if (f < JOIN_FEEL) continue;
        score.set(lab[j], (score.get(lab[j]) ?? 0) + w * (f - JOIN_FEEL + 1));
      }
      // 同点は添字の小さいラベルを採る（決定的）
      let best = lab[i], bestS = -1;
      for (const [L, sc] of score) if (sc > bestS || (sc === bestS && L < best)) { bestS = sc; best = L; }
      if (best !== lab[i]) { lab[i] = best; moved++; }
    }
    if (!moved) break;
  }

  // ---- 小さすぎる塊は派閥と呼ばない ----
  const size = new Map();
  for (let i = 0; i < n; i++) if (lab[i] >= 0) size.set(lab[i], (size.get(lab[i]) ?? 0) + 1);
  // ラベルを 1 から詰め直す（0＝どこにも属さない）
  const id = new Map();
  let next = 1, biggest = 0, inFaction = 0;
  for (const [L, sz] of [...size].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    if (sz < MIN_SIZE) continue;
    id.set(L, next++);
    if (sz > biggest) biggest = sz;
    inFaction += sz;
  }
  for (let i = 0; i < A.len; i++) {
    A.faction[i] = (i < n && lab[i] >= 0) ? (id.get(lab[i]) ?? 0) : 0;
  }
  return { count: next - 1, biggest, inFaction };
}

/** その派閥の芯（影響力がいちばん高い者）。★ 正典3-3「線に乗るのは好き嫌い」 */
export function coreOf(P, faction) {
  const A = P.a;
  let best = -1, bestI = -1;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || A.faction[i] !== faction) continue;
    if (A.infl[i] > bestI) { bestI = A.infl[i]; best = i; }
  }
  return best;
}
