// 異端狩り（#7）。**乱数は犯罪のストリーム（9番）だけを引く。**
//
// ★ 2つの狩りは別の仕事を持つ（#7 §0）。**4つのステが全部ちがう腕**なので独立に動く（柱4）：
//     H_s 厳格さ ＝ 規範意識(14B) × 従順(10B) ÷ 100   … **網の目**を決める（秩序の側）
//     H_v 激しさ ＝ 残酷さ(12B)   × 信心(13B) ÷ 100   … **処し方**を決める（狂信の側）
//   ★ 読むのは個人のステではなく、**宗派の教義の値**。
//
// ★ 正典の実測が出した一番大事な帰結：
//   **H_s も H_v も 100 に届かない**（2つのステの積÷100 に 0.7/0.3 の加重平均が掛かるので
//   中心へ二重に引かれる。実測の最大は H_s 58.6・H_v 68.1）。
//   → **規範意識 42 以上の者は、どんな教団の自派狩りにも構造的に掛からない。**
//     これが「審問会が自分の信者を食い尽くして国が消える」を止める唯一の底。
//
// > **焼く教団は、焼かれた者から生まれる。**
//   オーナーが粛清をすると、その遺族の中から 起源＝罰 の宗教が起き（激しさ +20）、
//   その約7割が焚刑教団になる。焚刑を先に無くす道は無い。

import * as S from '../core/stats.js';
import {
  SECT_NONE, NOFAITH_D, DEATH_EXECUTED, NO_VILLAGE, RANK_COMMON,
  POST_CHIEF, BUREAUS,
} from './people.js';
import * as SECT from './sect.js';
import * as DIS from './discontent.js';
import * as REP from './reputation.js';

// ---- 台帳値（正典 #7 の実測。帯なしの母集団中央）--------------------------
export const H_S_MED = 24.4;    // 生きている宗派の 教義[H_s] の中央
export const D_MED = 13.6;      // 別宗派どうしの d の中央
export const H_V_MED = 35.8;    // 教義[H_v]（起源≠罰）の中央
export const CAPTIVE_D = 40;    // 捕虜の「異国の宗派」

// ---- 審問会が生える門（#7 §1）----------------------------------------------
// ★ 信仰性の門を 60 → 75 に上げてある。60 は実測で **100.0% が通る**死んだ条項だった
//   （教義の信仰性の p5 が 62.7。発起人は信心≥60 の門を通るので下から詰まる）。
export const INQ_FAITH = 75, INQ_HARD = 50, INQ_MONTHS = 24;

// ---- ズレ d（#7 §2）--------------------------------------------------------
// ★ 22項目のうち**6項目だけ**を使う。全部平均すると導出値が二重に効いて、
//   近い分派と敵対宗派の d が近づく
export const D_AXES = ['信仰性', '教義の硬さ', '階層性', '戒律の細かさ', '体系化', '排他性'];

// ---- 網の目（#7 §3）--------------------------------------------------------
// G = clamp(4, 2×d*, d* × (2 − H_s/H_s*))
// ★ 床4：H_s が高いと門が0になり**自派の全員が候補**になる。自派を食う経路は
//   「獲物が絶えたとき」の1本だけにする
// ★ 上限 2×d*：H_s=0 の教団でも門が 27.2 で止まり、
//   **捕虜(40)と無信仰(30)だけはどんな教団の網にも入る**（獲物が0の穴を作らない）
export const G_FLOOR = 4;
export const P_BASE = 0.00018, P_CAP = 0.0020, D_SQ_CAP = 5.0, D_DIV = 15;
export const STARVED_SHARE = 0.005, STARVED_D = 12;

// ---- 誤爆（#7 §5）----------------------------------------------------------
export const MISFIRE_BASE = 0.15, MISFIRE_CAP = 0.40, MISFIRE_D = 10;

// ---- 処し方（#7 §4）--------------------------------------------------------
export const WARN_MAX = 25, EXILE_MAX = 50;      // <25 戒告 ／ 25〜49 破門 ／ ≥50 焚刑
export const WARN_REP = -10, WARN_DIS3 = 10;
export const EXILE_REP = -35, EXILE_DIS2 = 30, EXILE_DIS3 = 25;
export const EXILE_KIN_G1 = 15, EXILE_KIN_G3 = 10;
export const BURN_REP = -35;
export const BURN_KIN_G1 = 35, BURN_KIN_G3 = 35, BURN_KIN_G5 = 10;
export const BURN_PIETY_LINE = 60;               // 信心≥60 なら ⑤−10、未満なら ⑤+10
export const MISFIRE_G1 = 30, MISFIRE_G3 = 30;   // 冤罪（正典3-6b の行）
export const HOUSE_G_BURN = 10, HOUSE_G_EXILE = 4;   // 家門 → 祭祀局。★これだけが世代を跨ぐ

const ID_NORM = S.needId('規範意識');
const ID_PIETY = S.needId('信心');
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 網の目 G */
export function meshOf(hs) {
  return clamp(D_MED * (2 - hs / H_S_MED), G_FLOOR, 2 * D_MED);
}
/** 摘発の月率 */
export function catchP(hs, d) {
  return clamp(P_BASE * (hs / H_S_MED) * Math.min(D_SQ_CAP, (d / D_DIV) ** 2), 0, P_CAP);
}
/** 誤爆率。★ 厳格さが高いほど網が正確、激しさが高いほど誤爆が増える */
export function misfireP(hv, hs) {
  return clamp(MISFIRE_BASE * (hv / H_V_MED) * (1 - hs / 100), 0, MISFIRE_CAP);
}

/** ズレ d。6項目の平均差 */
export function driftOf(sects, a, b) {
  if (a === b) return 0;
  if (!a) return NOFAITH_D;                       // 無信仰は30固定
  const da = sects.doctrine[a], db = sects.doctrine[b];
  if (!da || !db) return NOFAITH_D;
  let sum = 0;
  for (const n of D_AXES) sum += Math.abs(da[SECT.AX[n]] - db[SECT.AX[n]]);
  return sum / D_AXES.length;
}

// ---------------------------------------------------------------------------
// 異端審問会
// ---------------------------------------------------------------------------
//
// ★ 正統宗派 s* ＝ **祭祀局長の sect**。「国教」というフラグを持たない（正典3-6）。
//   信者率1位でもない。祭祀局が空席、または祭祀局長が無信仰なら s* は存在せず、審問会も動かない。
// ★ 祭祀局長が代替わりして sect が変わった月：**昨日までの正統が、今日の異端になる。**
//   ズレ d は全国民について再計算され、摘発の対象が丸ごと裏返る。
// ★ **フェーズ1・2（局が無い）には異端審問会が存在しない。**

export class Inquisition {
  constructor() {
    this.alive = false;        // 一度生えたら消えない（正典3-6「仕事を増やし続ける装置」）
    this.starSect = 0;         // 正統宗派 s*
    this.qualMonths = 0;       // 門を満たしている連続月数
    this.houseG = new Map();   // 家門 → 祭祀局 の恨み。★これだけが世代を跨ぐ
    this.burns12 = 0;          // 直近12ヶ月の焚刑
    this.caught12 = 0;         // 直近12ヶ月の摘発
    this._ring = new Int32Array(24);   // [焚刑×12, 摘発×12] の輪
  }
  save() {
    return { alive: this.alive, starSect: this.starSect, qualMonths: this.qualMonths,
             houseG: [...this.houseG], ring: [...this._ring] };
  }
  load(o) {
    Object.assign(this, o);
    this.houseG = new Map(o.houseG ?? []);
    this._ring = Int32Array.from(o.ring ?? new Array(24).fill(0));
    return this;
  }
}

/** 祭祀局長を探す。居なければ −1 */
export function ritesChief(P) {
  const A = P.a, slot = BUREAUS.indexOf('祭祀局') + 1;
  for (let i = 0; i < A.len; i++) {
    if (A.alive[i] && A.post[i] === POST_CHIEF && A.bureau[i] === slot) return i;
  }
  return -1;
}
/** 刑務局長を探す（執行者）。居なければ −1 */
export function jailChief(P) {
  const A = P.a, slot = BUREAUS.indexOf('刑務局') + 1;
  for (let i = 0; i < A.len; i++) {
    if (A.alive[i] && A.post[i] === POST_CHIEF && A.bureau[i] === slot) return i;
  }
  return -1;
}

/**
 * 異端狩りの月次。★ 乱数は犯罪のストリーム（9番）だけ。
 * @returns {{warned, exiled, burned, misfired, star, hs, hv}}
 */
export function heresyMonth(P, sects, inq, tick, rng, onKin) {
  const A = P.a;
  const out = { warned: 0, exiled: 0, burned: 0, misfired: 0, star: 0, hs: 0, hv: 0 };

  // ---- s* ＝ 祭祀局長の sect ----
  const rites = ritesChief(P);
  const star = rites >= 0 ? A.sect[rites] : SECT_NONE;
  if (star !== inq.starSect) {
    inq.starSect = star;            // ★ 昨日までの正統が、今日の異端になる
  }
  out.star = star;
  if (!star || !sects.a.alive[star]) { inq.qualMonths = 0; return out; }

  const hs = sects.ax(star, '異端狩りの厳格さ');
  const hv = sects.ax(star, '異端狩りの激しさ');
  out.hs = hs; out.hv = hv;

  // ---- 生えるか（#7 §1）----
  if (!inq.alive) {
    const jail = jailChief(P);
    const ok = jail >= 0 && sects.ax(star, '信仰性') >= INQ_FAITH
            && sects.ax(star, '教義の硬さ') >= INQ_HARD;
    inq.qualMonths = ok ? inq.qualMonths + 1 : 0;
    if (inq.qualMonths < INQ_MONTHS) return out;
    inq.alive = true;               // 一度生えたら消えない
  }

  // ---- 候補を集める ----
  const G = meshOf(hs);
  const cand = [];                  // [i, d]
  let alive12 = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < 12) continue;
    alive12++;
    const d = driftOf(sects, A.sect[i], star);
    if (d >= G) cand.push(i, d);
  }

  // ---- 獲物が絶えたとき（#7 §3）★ 自派を食う経路はここ1本だけ ----
  let starved = false;
  if (cand.length / 2 < alive12 * STARVED_SHARE) {
    starved = true;
    cand.length = 0;
    const line = 100 - hs;          // ★ H_s は100に届かないので、規範意識42以上は構造的に掛からない
    for (let i = 0; i < A.len; i++) {
      if (!A.alive[i] || A.sect[i] !== star) continue;
      if ((A.ageMonths[i] / 12 | 0) < 12) continue;
      if (A.gene[ID_NORM][i] + A.ev[ID_NORM][i] >= line) continue;
      cand.push(i, STARVED_D);      // 網の目 G は適用しない（この切り替えが門の代わり）
    }
  }
  if (!cand.length) return out;

  // ---- 摘発（★ 候補ごとに必ず1回引く。当たらなくても引いて捨てる）----
  const caught = [];
  for (let k = 0; k < cand.length; k += 2) {
    const i = cand[k], d = cand[k + 1];
    if (rng.next() < catchP(hs, d)) caught.push(i);
  }
  // ★ 標的の順序：同じ p摘 の中では 影響力 I の高い者から挙げる
  caught.sort((a, b) => A.infl[b] - A.infl[a] || a - b);

  const jail = jailChief(P);
  const mis = misfireP(hv, hs);
  const inner = [];                 // 誤爆の差し替え先（d < 10 の正統な信者）
  if (mis > 0) for (let i = 0; i < A.len; i++) {
    if (A.alive[i] && A.sect[i] === star && driftOf(sects, star, star) < MISFIRE_D) inner.push(i);
  }

  for (let t of caught) {
    // ---- 誤爆（#7 §5）。★ 候補1件につき必ず1回引く ----
    const r = rng.next();
    let wrong = false;
    if (!starved && r < mis && inner.length) {
      t = inner[Math.floor(rng.next() * inner.length)];
      wrong = true; out.misfired++;
    }
    punish(P, sects, inq, t, hv, jail, tick, wrong, out);
  }
  return out;
}

/** 処し方（#7 §4）。3段の階段。★ 乱数を引かない */
function punish(P, sects, inq, t, hv, jail, tick, wrong, out) {
  const A = P.a;
  const kin = [A.mother[t], A.father[t], A.spouse[t]].filter(
    (k) => k >= 0 && k < A.len && A.alive[k]);

  if (hv < WARN_MAX) {                                   // ---- 戒告 ----
    REP.award(P, t, WARN_REP);
    DIS.addDiscontent(P, t, DIS.D_RULE, WARN_DIS3);
    out.warned++;
  } else if (hv < EXILE_MAX) {                           // ---- 破門・追放 ----
    A.sect[t] = SECT_NONE; A.faith[t] = 0; A.mode[t] = 0; A.sectMon[t] = 0;
    REP.award(P, t, EXILE_REP);
    if (A.rank[t] > RANK_COMMON) A.rank[t]--;            // 身分1段降格
    DIS.addDiscontent(P, t, DIS.D_GROUP, EXILE_DIS2);
    DIS.addDiscontent(P, t, DIS.D_RULE, EXILE_DIS3);
    for (const k of kin) {
      if (jail >= 0) DIS.addGrudge1(P, k, jail, EXILE_KIN_G1);
      DIS.addGrudge(P, k, DIS.D_RULE, EXILE_KIN_G3);
    }
    bumpHouse(inq, A.house[t], HOUSE_G_EXILE);
    out.exiled++;
  } else {                                               // ---- 焚刑（死）----
    P.kill(t, tick, DEATH_EXECUTED);
    A.rep[t] = Math.max(-100, A.rep[t] + BURN_REP);      // 評判 −35 のまま凍結
    for (const k of kin) {
      if (jail >= 0) DIS.addGrudge1(P, k, jail, BURN_KIN_G1);
      DIS.addGrudge(P, k, DIS.D_RULE, BURN_KIN_G3);
      // ★ 信心の高い者は「試練だ」と受け止めて⑤が下がり、そのぶん①が実行者に集中する
      const piety = A.gene[ID_PIETY][k] + A.ev[ID_PIETY][k];
      DIS.addDiscontent(P, k, DIS.D_GOD, piety >= BURN_PIETY_LINE ? -BURN_KIN_G5 : BURN_KIN_G5);
    }
    bumpHouse(inq, A.house[t], HOUSE_G_BURN);
    out.burned++;
  }
  // ---- 冤罪（正典3-6b の行）。★ 誤爆の恨みは 恨み③。⑥ではない ----
  //   審問は自国の統治が自国民にやった行為だから
  if (wrong) {
    if (jail >= 0 && A.alive[t]) DIS.addGrudge1(P, t, jail, MISFIRE_G1);
    for (const k of kin) DIS.addGrudge(P, k, DIS.D_RULE, MISFIRE_G3);
  }
}

function bumpHouse(inq, house, pt) {
  if (house === undefined || house < 0) return;
  inq.houseG.set(house, (inq.houseG.get(house) ?? 0) + pt);
}
