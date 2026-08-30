// 村の「近い順3村」（#11-D・#11-F・#11-G の共通の土台）。**乱数を1回も引かない。**
//
// ★ 正典7051：11-D は「**半径ではなく村数で切る**」に変わっている。
//   半径で切ると、村が疎らな国では相手が0人になり血のプールが村1つに閉じる。
//   村数で切れば **97.2%の村が12里以内に3村を持つ**ので、上位3村は常に埋まる。
//
// ★ 単位は **1里 ＝ 徒歩半日 ≒ 5km**（正典664）。
//   結婚の範囲・救援の到達・疫病の伝播の3つが全部「人が歩いて往復できるか」で決まる。
//   中世ヨーロッパの婚姻圏の実測（大半が徒歩半日圏＝5〜10km）に一致する。

import { PPL } from './settle.js';

export const NEAR = 3;         // 近い順に何村持つか

/**
 * 近い順3村と、その距離（里）を数え直す。村が動かないので分村のたびに呼べばよい。
 * @returns {{near: Int32Array, dist: Float64Array}} どちらも 村数 × NEAR
 */
export function nearest(V, land) {
  const nv = V.a.len;
  const near = new Int32Array(nv * NEAR).fill(-1);
  const dist = new Float64Array(nv * NEAR).fill(Infinity);
  if (!land) return { near, dist };
  for (let a = 0; a < nv; a++) {
    if (!V.a.alive[a]) continue;
    for (let b = 0; b < nv; b++) {
      if (b === a || !V.a.alive[b]) continue;
      const dx = (land.px[a] - land.px[b]) / PPL, dy = (land.py[a] - land.py[b]) / PPL;
      const d = Math.hypot(dx, dy);
      // 上位3つに挿す（同じ距離なら村番号の小さいほう＝決定的）
      for (let k = 0; k < NEAR; k++) {
        const o = a * NEAR + k;
        if (d < dist[o] || (d === dist[o] && b < near[o])) {
          for (let m = NEAR - 1; m > k; m--) {
            dist[a * NEAR + m] = dist[a * NEAR + m - 1];
            near[a * NEAR + m] = near[a * NEAR + m - 1];
          }
          dist[o] = d; near[o] = b;
          break;
        }
      }
    }
  }
  return { near, dist };
}

// ---------------------------------------------------------------------------
// #11-D　結婚の範囲（★ 半径ではなく村数で切る）
// ---------------------------------------------------------------------------
//
// ★ h(i,j) は**新しい列も新しい乱数も要らない**。既にある身分・五分位・相性から作る。
//   **0 にしない ── 身分違いの婚姻を禁じない**（h の下限 0.075）。
//   貴族どうしが結ばれる確率は平民との 3.3倍。3世代（90年）で貴族の家門が実際に閉じ、
//   **劣性ホモが貴族層だけで上がる。**「信仰で安定を買うと血が腐る」と同じ形が身分でも立つ。

export const N_DIV = 80;                       // N = 1 + floor((社交+好奇心+婚姻圧)/80)
export const W0_BASE = 0.04, W0_SPAN = 0.32, W0_DIV = 200;
export const NEAR_DECAY = 0.5;                 // k番目に近い村は w0 × 0.5^(k−1)
export const H_RANK = 0.60, H_RANK_DIV = 7;    // 身分の段 0..7
export const H_TIER = 0.30, H_TIER_DIV = 4;    // 平民の段＝富の村内五分位
export const H_AFF_BASE = 0.50, H_AFF_DIV = 100;

/** 相手を探す村の数 N（1〜3） */
export function rangeN(social, curiosity, pressure) {
  const n = 1 + Math.floor((social + curiosity + pressure) / N_DIV);
  return n < 1 ? 1 : n > NEAR ? NEAR : n;
}
/** 村外の重み w0（0.04〜0.36） */
export function outWeight(social, curiosity, pressure) {
  return W0_BASE + W0_SPAN * (social + curiosity + pressure) / W0_DIV;
}
/**
 * 身分と富と相性の掛け算 h(i,j)。★ 0 にしない（身分違いを禁じない）
 * @param pressure 婚姻圧カード（民生局・既定0）。上げると身分の項が緩む
 */
export function matchH(rankA, rankB, tierA, tierB, affinity, pressure = 0) {
  const hr = 1 - H_RANK * (1 - pressure / 200) * Math.abs(rankA - rankB) / H_RANK_DIV;
  const ht = 1 - H_TIER * Math.abs(tierA - tierB) / H_TIER_DIV;
  const ha = H_AFF_BASE + affinity / H_AFF_DIV;
  return hr * ht * ha;
}

// ---------------------------------------------------------------------------
// #11-F　疫病の村間伝播（★ 距離を締める）
// ---------------------------------------------------------------------------
//
// ★ exp(−d/**1.5**)。甲1の exp(−d/5) だと同じ条件で月2.25%・16村相手で毎月31%どれかに飛び、
//   1年で地域全体に回って、正典3-7 の「疫病＝100人の村で20年に1回」という頻度設計が壊れる。
//   1.5 にすると「**広く薄く散らばった国は届きにくい／密集して婚姻の線が濃い国は速い**」が
//   距離で初めて分かれる。
export const SPREAD_P0 = 0.25, SPREAD_DECAY = 1.5, SPREAD_LINES = 6;

/** 疫病が村Aから村Bへ飛ぶ月率。★ 線の数が0の村へは飛ばない */
export function spreadP(d, lines) {
  if (lines <= 0) return 0;
  return SPREAD_P0 * Math.exp(-d / SPREAD_DECAY) * Math.min(1, lines / SPREAD_LINES);
}
