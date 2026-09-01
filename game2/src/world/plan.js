// 具申と差し止め（#14）。**乱数を1回も引かない。**
//
// > **既定＝実行。**役職者が予定を立て、猶予を過ぎたら**勝手に実行される。**
// > オーナーは猶予のあいだだけ止められる。**止めるは、5つの中で唯一 民が誰も恨まない動詞。
// > だから連発したくなる。だから4.4年に1件で尽きる。**
//
// ★ ヘッドレス（オーナーが居ない）では**誰も止めない**ので、全部が猶予どおりに実行される。
//   それでも #14 を入れる意味は3つある：
//     1. **件数の川**が正典の予測どおりか測れる（村長4件/年/村・街長12/年/街・局長12/年/局）
//     2. **歪み**が効く ── 命じたとおりには一度も実行されない（実行値 ＝ カード ×(1+歪み_i)）
//     3. **L_i の段**が世界に効く（<40 で猶予いっぱいまで遅らせる／<20 で1件黙って実行しない）
//
// ★ 正典 4385：「#14 の猶予と L と歪みと待ち行列 ── すべて1文字も変えない」

import * as S from '../core/stats.js';
import { POST_HEADMAN, POST_MAYOR, POST_CHIEF } from './people.js';

// ---- 級と基底猶予（#14 の表）----------------------------------------------
export const LIGHT = 0, HEAVY = 1;
export const BASE_DAYS = [30, 90];              // 軽30日 ／ 重90日
export const QUEUE_CAP = [50, 180];             // 待ち行列の上限。溢れたら古いものから実行される

// ---- 件数の川（正典3855）--------------------------------------------------
export const PLANS_PER_YEAR = { 村長: 4, 街長: 12, 局長: 12 };

const ID = {};
for (const n of ['従順', '野心', '誇り', '保身', '恩義']) ID[n] = S.needId(n);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const cur = (P, i, n) => P.a.gene[ID[n]][i] + P.a.ev[ID[n]][i];
/** 外から歪みを引く口（#14 の distortion に要る4ステをまとめて渡す） */
export function distortionOf(P, i, loyalty) {
  return distortion(cur(P, i, '誇り'), cur(P, i, '野心'), cur(P, i, '従順'), cur(P, i, '保身'), loyalty);
}

/**
 * 猶予の倍率 m_i（#14）。★ 中心は 50/50/50。**歪み式の中心（60/48/66/66）を流用しない。**
 *   甲案は 48/60 に書き換えていたが、検算「中央値の局長 → m=1.24」は 50/50/50 でしか出ない。
 */
export function graceMul(obedience, ambition, pride) {
  return clamp(1 + (obedience - 50) / 50 - (ambition - 50) / 100 - (pride - 50) / 100, 1.0, 2.0);
}
/** 猶予（日） */
export function graceDays(level, m) { return BASE_DAYS[level] * m; }

/**
 * 歪み（正典7836）。★ **件ではなく人に立つ属性。**
 *   同じ立案者の同月の件は全部同じ歪みなので、件に立てると2件目以降は何も教えない。
 * ★ L < 40 の局長は ±0.60 まで開く。
 */
export const DISTORT_CAP = 0.40, DISTORT_CAP_LOW = 0.60;
export function distortion(pride, ambition, obedience, selfKeep, loyalty = 100) {
  const cap = loyalty < L_DISTORT ? DISTORT_CAP_LOW : DISTORT_CAP;
  return clamp((pride - 60) / 250 + (ambition - 48) / 250
             - (obedience - 66) / 250 - (selfKeep - 66) / 250, -cap, cap);
}

// ---- 忠誠 L（#14）----------------------------------------------------------
// ★ **L が下がる事由は1つだけ ── その者の決定を、オーナーが上書きしたとき。**
//   猶予内に自分で置いたときは「上書き」ではない ── L は下がらない。
export const L_OVERRIDE = 8;             // −8 × (0.5 + 誇り/100)
export const L_RECOVER = 2;              // 12ヶ月に1回、B_i の方向へ 2
export const L_REPORT = 55;              // これ未満で報告の歪みが1段深くなる
export const L_DISTORT = 40;             // これ未満で歪み ±0.60／村長は猶予いっぱいまで遅らせる
export const L_REVOLT = 20;              // これ未満で局長は謀反の候補（V③ +20）／村長は1件黙って実行しない
export const L_REVOLT_DIS = 20;          // 謀反の候補になった局長の V③ に足す

// ★★ B-37：**B_i の式が正典に書かれていない。**
//   「基準値 B_i も #14 の式のまま（恩義・従順・野心＋発掘フラグ。3つとも CSV 実在）」と
//   材料だけが書かれ、式そのものと係数が無い。検算値「中央値 B_i = 68.0」だけが残っている。
//   ★ しかも**うちの世界のステ分布が正典の想定と違う**（実測の大人の中央：
//     恩義42.3／従順52.7／野心38.8 ↔ 正典が猶予の検算で使う 従順66／野心48）。
//     どんな自然な式を置いても、この分布では 68.0 にならない（実測 47.5〜52.1）。
//   → **材料（恩義・従順・野心・発掘）だけ正典どおりに使い、係数は等分に置く。**
//     ヘッドレスではオーナーが上書きしないので L は動かず、この値は世界に効かない。
//     オーナーの動詞が入る日に、68.0 を出す分布と合わせて校正し直すこと。
export const L_FOUND_BONUS = 15;         // 発掘フラグ（オーナーに見出された者）

export function baselineL(P, i, found = false) {
  const b = 50 + (cur(P, i, '恩義') - 50) / 3 + (cur(P, i, '従順') - 50) / 3
              - (cur(P, i, '野心') - 50) / 3 + (found ? L_FOUND_BONUS : 0);
  return clamp(b, 0, 100);
}
/** 上書きされたときの下げ幅 */
export const overrideCost = (pride) => L_OVERRIDE * (0.5 + pride / 100);

// ---------------------------------------------------------------------------
// 待ち行列（#14）
// ---------------------------------------------------------------------------
//
// ★ **段ごと・箱ごと・級ごとに上限**（軽50／重180）。
//   溢れたら**古いものから実行される（止められない）。**
//   正典3808：「溢れるのは『12年オフラインから戻ったとき』だけ」──
//   つまり**オーナーが居るあいだは溢れない**設計で、溢れは不在の代金。
//
// ★ ヘッドレスでは誰も止めないので、猶予が来た件から順に実行されていく。

export const PLAN_SPEC = {
  who: 'i32',        // 立案者
  box: 'u16',        // 箱（村／街／局の番号）
  level: 'u8',       // 軽0／重1
  due: 'i32',        // 実行される tick（立案 ＋ 猶予）
  kind: 'u8',        // 予定の種類（局の番号など。いまは記録だけ）
  done: 'u8',
};

export class Plans {
  constructor() { this.q = []; this.serial = 0; }

  /** 予定を1つ立てる。★ 猶予は立案者の性格で決まる（#14） */
  add(P, who, box, level, tick, kind = 0) {
    const m = graceMul(cur(P, who, '従順'), cur(P, who, '野心'), cur(P, who, '誇り'));
    // ★ L < 40 の家長・村長・街長は「命令を、猶予いっぱいまで遅らせて実行する」
    //   （既に猶予いっぱいなので、ここでは段の記録だけ。局長は歪みが開く）
    const due = tick + Math.round(graceDays(level, m));
    this.q.push({ id: this.serial++, who, box, level, due, kind, done: 0 });
    return due;
  }

  /**
   * 上限を超えたぶんは古いものから実行される（止められない）。
   * ★★ 2026-09-01（第2回の精査で発見）：**上限を世界でんぶ1本にしていた。**★★
   *   正典3916 は「待ち行列：**段ごと・箱ごと・級ごと**に上限（軽50／重180）」。
   *   1本にしていたので**役職者が50人を超えた瞬間に世界じゅうが溢れ**、
   *   `plansOverflow` が 0 → 14,880件 になっていた。**箱ごとに数える。**
   */
  overflow(level) {
    const byBox = new Map();
    for (const p of this.q) {
      if (p.done || p.level !== level) continue;
      (byBox.get(p.box) ?? byBox.set(p.box, []).get(p.box)).push(p);
    }
    let over = 0;
    for (const same of byBox.values()) {
      const n = same.length - QUEUE_CAP[level];
      if (n <= 0) continue;
      same.sort((a, b) => a.due - b.due || a.id - b.id);
      for (let k = 0; k < n; k++) same[k].due = -1;       // すぐ実行
      over += n;
    }
    return over;
  }

  /**
   * 期限の来た予定を実行する。★ ヘッドレスでは誰も止めないので全部通る。
   * @param onRun (plan, distort) → 実行。distort は立案者の歪み（実行値 ＝ カード ×(1+歪み)）
   * @returns {{ran, silent, overflowed}}
   */
  runDue(P, tick, loyaltyOf, onRun) {
    let ran = 0, silent = 0;
    const over = this.overflow(LIGHT) + this.overflow(HEAVY);
    for (const p of this.q) {
      if (p.done || p.due > tick) continue;
      p.done = 1;
      const L = loyaltyOf(p.who);
      // ★ L < 20：家長・村長・街長は**1件、黙って実行しない**
      //   （年代記に「実行された」が載らない。村を開けば分かる）
      if (L < L_REVOLT && P.a.post[p.who] < POST_CHIEF) { silent++; continue; }
      const d = distortion(cur(P, p.who, '誇り'), cur(P, p.who, '野心'),
                           cur(P, p.who, '従順'), cur(P, p.who, '保身'), L);
      onRun(p, d); ran++;
    }
    // 済んだ件は捨てる（年代記は #15 が別に持つ）
    if (this.q.length > 4096) this.q = this.q.filter((p) => !p.done);
    return { ran, silent, overflowed: over };
  }

  get pending() { let n = 0; for (const p of this.q) if (!p.done) n++; return n; }
}

/** その役職が年に何件立てるか（正典3855） */
export function plansPerYear(post) {
  if (post === POST_HEADMAN) return PLANS_PER_YEAR.村長;
  if (post === POST_MAYOR) return PLANS_PER_YEAR.街長;
  if (post === POST_CHIEF) return PLANS_PER_YEAR.局長;
  return 0;
}
