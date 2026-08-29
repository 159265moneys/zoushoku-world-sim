// 厄災（正典3-7 ＋ #9）。**乱数は厄災のストリーム（6番）だけを引く。**
//
// ★ 厄災が入るまで、これらは全部「器はあるが誰も書かない」状態だった：
//     病の段（sickStage）／負傷の段（hurtStage）／死因3「事故」／族「天」
//     そして **⑤神・世界へ の不満**（実測 0.006。門は 70 と 85）
//
// ★ **正典3-7 の一番大事な一文**：
//   「災害が無いと効率100%で回すのを止める理由が1つも無い。食料を貯める意味がない。
//     災害を入れると備蓄が保険になり、効率一辺倒が罰される」
//
// ★ 嵐は**年の収穫係数に一切触れない**（#9-A）。
//   触ると嵐の年がほぼ100%で飢の災いを兼ね、族が2つ立って宗教の照合が壊れる。
//   **嵐が殴るのは蔵（蓄え）と家（器）であって、流れ（作柄）ではない。**
//   この分離があるから「飢饉由来の宗教（分配と施し）は嵐に無力」が機構として成立する。

import * as C from '../core/calendar.js';
import { ST_HUNGRY } from '../core/states.js';
import {
  DEATH_ACCIDENT, DEATH_KIN, KIN_NONE, KIN_CAN_ORIGIN, DEATH_COUNT, NO_VILLAGE,
  KIN_HEAVEN, KIN_PLAGUE,
} from './people.js';
import { PART_ARM, PART_LEG, healMonths, sickMonths } from './condition.js';
import { D_PERSON, D_RULE, D_GOD, D_OUT } from './discontent.js';
import * as S from '../core/stats.js';

// ---- 嵐（#9-A） ------------------------------------------------------------
// 夏〜秋の6ヶ月（月6〜11）の各月に 0.7%。年 1−0.993^6 ＝ 4.12%／年 ＝ 24年に1回
export const STORM_MONTH_P = 0.007;
export const STORM_FROM = 5, STORM_TO = 10;      // 0起点の月。6月〜11月
export const STORM_STORE = 0.30;                  // 蔵の中身 −30%
export const STORM_HOUSES = 0.10;                 // 家の10%が損壊（切り上げ・最低1軒）
export const STORM_LODGE_MONTHS = 3;              // 損壊家の住人は3ヶ月「間借り」
export const STORM_FIELD_HURT = 0.03;             // 森／辺境で働いていた者の3%が負傷（w=2）
export const STORM_FIELD_DEAD = 0.005;            // 0.5%が死亡（死因＝事故）
export const STORM_X_HOUSE = [12, 4];             // 家が壊れた者   ⑤+12 ／ ③+4
export const STORM_X_OTHER = [4, 2];              // それ以外の村民 ⑤+4  ／ ③+2

// ---- 疫病（正典3-7） -------------------------------------------------------
// 人口密度 ×（100 − 潔癖の平均）÷ 100 × 基準。**100人の村で20年に1回**
// 「100人の村で20年に1回」から逆算：n=100・潔癖の平均50 のとき
//   (100/100) × ((100−50)/100) × 基準 = 1/20 ／年  →  基準 = 0.10 ／年
export const PLAGUE_BASE = 0.10;
export const PLAGUE_X = 20;                       // S = {⑤, ⑥}
// ★★ B-26：**かかる割合が正典に無い。**「病 → 死」としか書いていない。
//   0.25 は置いた値であって正典の数字ではない。裁定を仰ぐ.md B-26。
export const PLAGUE_SICK_SHARE = 0.25;            // かかる割合（★正典に無い）
export const PLAGUE_STAGE = 3;                    // 病の段3（疫病）

// ---- 火災（正典3-7） -------------------------------------------------------
// 家の密度 × 乾いた季節。**30軒の村で30年に1回**
export const FIRE_PER_YEAR = 1 / 30;
export const FIRE_X_HOUSE = 10, FIRE_X_VILLAGE = 3;   // 焼失した家の本人 X=10 ／ 村 X=3
export const FIRE_STORE = 0.30;                       // 蔵も焼ける

// ---- 獣害（正典3-7） -------------------------------------------------------
// 森で働く人数に比例。**10人で年1回、軽い負傷**
export const BEAST_PER_WORKER_YEAR = 0.1;   // 「10人で年1回」＝ 1人あたり 0.1／年
export const BEAST_X = 6;                             // S = {⑥}
// ★★ B-23：正典が自分と衝突している。**発明しないので 0 にしてある。**
//   発生する条件の欄 …「10人で年1回、**軽い負傷**」
//   何が起きるかの欄 …「**個人の死**」
//   死因3事故の括弧 …「倒壊・溺死・凍死・**獣害**・嵐」
//   死ぬとは3箇所が言うのに、**死ぬ確率がどこにも無い。**
//   嵐は「3%で負傷・0.5%で死亡」と両方が書いてあるので、書き忘れではなく欠落。
//   → **嵐の並びをそのまま流用する**（新しい数字を1つも作らない）。
//     嵐が同じ表の同じ列で「森／辺境で3%が負傷（w=2）・0.5%が死亡」と書いているので、
//     獣害＝「負傷100%（＝軽い負傷。条件の欄のとおり）・死亡 STORM_FIELD_DEAD」。
//   ★ 0 にすると族「天」の供給源が嵐だけになり、嵐が来ない村では天の宗派が
//     一度も的中できない（9-E 分岐1 は族の一致で判定する）。裁定を仰ぐ.md B-23。
export const BEAST_DEAD = STORM_FIELD_DEAD;   // ＝0.005。嵐の「森／辺境で0.5%が死亡」を流用

// ---- 厄災の点 X と S（正典 2376〜2389 の表そのまま。1点も足さない）--------
//   ★ これが無いと ⑤ が生涯ゼロだった。⑤ は時間減衰がゼロの溜め池なので、
//     この表が ⑤ の生涯到達値を単独で決めている。
//   ★ 点の向きへの割り振りは #4 の allocate に従う（厄災は S を名指しするだけ）
export const S_GOD        = [D_GOD];             // {⑤}
export const S_GOD_RULE   = [D_GOD, D_RULE];     // {⑤,③}
export const S_GOD_OUT    = [D_GOD, D_OUT];      // {⑤,⑥}
export const S_GOD_PERSON = [D_GOD, D_PERSON];   // {⑤,①}
export const S_RULE       = [D_RULE];            // {③}
export const S_OUT        = [D_OUT];             // {⑥}

export const HARSH_X = 8;      // 厳冬（収穫係数 0.70未満）X=8  S={⑤}   村の12歳以上
export const POOR_X  = 5;      // 凶作（収穫係数 0.85未満）X=5  S={⑤,③} 同
export const X_AGE = 12;       // ★「村の12歳以上」。#4 の不満は12歳から

const ID_CLEAN = S.needId('潔癖');

// ---------------------------------------------------------------------------
/**
 * 厄災の月次。★ 引く乱数の回数を分岐で変えない（掟）。
 *   村ごとに**必ず4回**引く（嵐・疫病・火災・獣害）。当たらなくても引いて捨てる。
 * @param onX (i, X, S) → その人に X の圧を S の向きで積む。配分は #4 の allocate が持つ
 * @returns {{storms, plagues, fires, beasts, dead, deadList}}
 */
export function disasterMonth(P, V, H, tick, rng, onX) {
  const A = P.a, VA = V.a, nv = VA.len;
  const old12 = (i) => (A.ageMonths[i] / 12 | 0) >= X_AGE;   // ★「村の12歳以上」
  const month = C.monthOf(tick) % C.MONTHS_PER_YEAR;
  const stormSeason = month >= STORM_FROM && month <= STORM_TO;
  let storms = 0, plagues = 0, fires = 0, beasts = 0;
  const deadList = [];

  // 村ごとの人・働き手を数える
  const pop = new Int32Array(nv), forest = new Int32Array(nv), clean = new Float64Array(nv);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    pop[v]++; clean[v] += A.gene[ID_CLEAN][i] + A.ev[ID_CLEAN][i];
    if (A.job[i] === 2 || A.job[i] === 4) forest[v]++;    // 森／辺境
  }

  for (let v = 0; v < nv; v++) {
    // ★ 4回とも必ず引く。当たらなくても引いて捨てる
    const rStorm = rng.next(), rPlague = rng.next(), rFire = rng.next(), rBeast = rng.next();
    if (!VA.alive[v] || pop[v] === 0) continue;
    const n = pop[v], cleanAvg = clean[v] / n;

    // ---- 嵐 ----
    if (stormSeason && rStorm < STORM_MONTH_P) {
      storms++;
      VA.food[v] *= (1 - STORM_STORE);
      const hurtHouses = Math.max(1, Math.ceil(VA.houses[v] * STORM_HOUSES));
      let broken = 0;
      for (let i = 0; i < A.len && broken < hurtHouses; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        // 損壊家の住人：間借り＝疲労の段を1つ押し上げる／1名が負傷（軽・w=1）
        A.fatigue[i] += 3;                                   // 段が1つ上がる量
        if (!A.hurtStage[i]) {
          A.hurtStage[i] = 1; A.hurtPart[i] = PART_ARM;
          A.hurtHeal[i] = healMonths(P, i, 1);
        }
        if (old12(i)) { onX(i, STORM_X_HOUSE[0], S_GOD); onX(i, STORM_X_HOUSE[1], S_RULE); }
        broken++;
      }
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        if (A.job[i] === 2 || A.job[i] === 4) {
          // ★ 掟：ストリーム内では、分岐で呼び出し回数を変えない。
          //   死んだ人で continue すると負傷の抽選が飛ぶので、**先に2回とも引く**
          const rDead = rng.next(), rHurt = rng.next();
          if (rDead < STORM_FIELD_DEAD) { P.kill(i, tick, DEATH_ACCIDENT); deadList.push(i); continue; }
          if (rHurt < STORM_FIELD_HURT && !A.hurtStage[i]) {
            A.hurtStage[i] = 2; A.hurtPart[i] = PART_LEG; A.hurtHeal[i] = healMonths(P, i, 2);
          }
        }
        if (old12(i)) { onX(i, STORM_X_OTHER[0], S_GOD); onX(i, STORM_X_OTHER[1], S_RULE); }
      }
    }

    // ---- 疫病 ----。人口密度 ×（100 − 潔癖の平均）÷100 × 基準
    const pPlague = (n / 100) * ((100 - cleanAvg) / 100) * PLAGUE_BASE / 12;
    if (rPlague < pPlague) {
      plagues++;
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        if (rng.next() < PLAGUE_SICK_SHARE) {
          A.sickStage[i] = PLAGUE_STAGE;
          A.sickHeal[i] = sickMonths(P, i, PLAGUE_STAGE);   // ★ 治る道（B-26）
        }
        if (old12(i)) onX(i, PLAGUE_X, S_GOD_OUT);   // X=20 S={⑤,⑥}
      }
    }

    // ---- 火災 ----
    const pFire = (VA.houses[v] / 30) * (FIRE_PER_YEAR / 12);
    if (rFire < pFire) {
      fires++;
      VA.food[v] *= (1 - FIRE_STORE);
      // どの家が焼けたか。★ 分岐の中で1回だけ引く（当たった月にしか要らない）
      const pick = Math.floor(rng.next() * n);
      let seen = 0, burned = -1;
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        if (seen++ === pick) { burned = A.house[i]; break; }
      }
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v || !old12(i)) continue;
        // ★ 焼失した家の本人 X=10 S={⑤,①}／それ以外の村民 X=3 S={⑤}
        //   ①は「相手のいない①は絶対に作らない」（allocate 段2）ので t=0 で自然に落ちる
        if (burned >= 0 && A.house[i] === burned) onX(i, FIRE_X_HOUSE, S_GOD_PERSON);
        else onX(i, FIRE_X_VILLAGE, S_GOD);
      }
    }

    // ---- 獣害 ----。森で働く人数に比例（10人で年1回）
    const pBeast = forest[v] * BEAST_PER_WORKER_YEAR / 12;
    if (forest[v] > 0 && rBeast < pBeast) {
      beasts++;
      // ★★ 正典は「何が起きるか＝**個人の**死」「**軽い**負傷」と単数で書いている。
      //   頻度のほうが既に「森で働く人数に比例」なので、
      //   当たった月に**森の働き手を全員**負傷させると人数を二重に数えることになる。
      //   （実測：全員版は 120年の立ち上がり失敗率を 13%→36% に押し上げた。
      //     森の働き手が常時 負傷 で埋まり、産出が落ちて飢えに繋がっていた）
      //   → 当たった月に **1人だけ** 襲われる。X=6 S={⑥} は「森に出た者」全員に積む
      const pick = Math.floor(rng.next() * forest[v]);
      let seen = 0;
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        if (A.job[i] !== 2 && A.job[i] !== 4) continue;
        if (seen++ === pick) {
          if (rng.next() < BEAST_DEAD) { P.kill(i, tick, DEATH_ACCIDENT); deadList.push(i); }
          else if (!A.hurtStage[i]) {
            A.hurtStage[i] = 1; A.hurtPart[i] = PART_LEG; A.hurtHeal[i] = healMonths(P, i, 1);
          }
        }
        if (old12(i)) onX(i, BEAST_X, S_OUT);   // X=6 S={⑥} 森に出た者
      }
    }
  }
  return { storms, plagues, fires, beasts, dead: deadList.length, deadList };
}

// ---------------------------------------------------------------------------
/**
 * その月・その村の族を決める（#9-D）。**1月1族。**
 * 最多の死因の族を採る。**同数で並んだら族番号の小さいほうを採る**（決定性のため）。
 * ★ 老衰・難産・産褥・乳幼児 は族を持たない（数えない）。
 */
export function kinOfMonth(counts) {
  const byKin = new Int32Array(7);
  for (let d = 1; d < DEATH_COUNT; d++) {
    const k = DEATH_KIN[d];
    if (k !== KIN_NONE) byKin[k] += counts[d];
  }
  let best = KIN_NONE, bestN = 0;
  for (let k = 1; k < byKin.length; k++) {
    if (byKin[k] > bestN) { bestN = byKin[k]; best = k; }   // 同数なら先に見た（小さい番号）が勝つ
  }
  return best;
}

export { KIN_CAN_ORIGIN, DEATH_ACCIDENT, DEATH_KIN, KIN_NONE };

// ---------------------------------------------------------------------------
// 9-E の台帳 ── 「大きな災い」の判定に要る2つを、村ごとに12ヶ月ぶん持つ
// ---------------------------------------------------------------------------
//
// 正典 9-E【大きな災いの定義】
//   (a) 直近12ヶ月の死者数 ≥ 12ヶ月前の村人口 × 10%  かつ  死者数 ≥ 5人
//   ★ 同じ村で一度発火したら、次の発火まで12ヶ月あける
//   ★ 判定は村ごと。国全体で一斉には判定しない
//
// ★ 宗派（#8）はまだ無い。だが台帳はここ（#9）の持ち物なので先に立てる。
//   #8 が入る日に、この r と 族 をそのまま読めばいい。

export const BIG_DEAD_SHARE = 0.10;    // 12ヶ月前の村人口の10%
export const BIG_DEAD_MIN = 5;         // かつ 5人以上
export const BIG_COOLDOWN = 12;        // 次の発火まで12ヶ月あける

export class Calamity {
  constructor(cap = 8) { this.cap = cap; this._alloc(cap); }
  _alloc(n) {
    this.deaths = new Int32Array(n * 12);   // 月ごとの死者数（12ヶ月の輪）
    this.pops = new Int32Array(n * 12);    // 月ごとの村人口（12ヶ月の輪）
    this.byCause = new Int32Array(n * DEATH_COUNT);   // ★ その月の死因（村ごと）
    this.kinRing = new Int32Array(n * 12 * 7);        // 月ごとの族の数（12ヶ月の輪・村ごと）
    this.cap = n;
  }
  grow(nv) {
    if (nv <= this.cap) return;
    const d = this.deaths, p = this.pops, k = this.kinRing, old = this.cap;
    this._alloc(Math.max(nv, old * 2));
    this.deaths.set(d); this.pops.set(p); this.kinRing.set(k);   // ★ 輪の位相は月で決まるので詰め直し不要
  }

  /** その月の死因を1つ数える（村ごと）。世界で1本だった byCause を村ごとにする */
  count(v, cause) { if (v >= 0 && v < this.cap) this.byCause[v * DEATH_COUNT + cause]++; }

  /** その村・その月の死因の並びを取り出す */
  causes(v, out) {
    const base = v * DEATH_COUNT;
    for (let d = 0; d < DEATH_COUNT; d++) out[d] = this.byCause[base + d];
    return out;
  }

  /** 月の終い。輪を1つ進め、その月の死因を0に戻す */
  close(V, tick, monthIndex) {
    const nv = V.a.len; this.grow(nv);
    const slot = monthIndex % 12;
    const tmp = new Int32Array(DEATH_COUNT);
    for (let v = 0; v < nv; v++) {
      let dead = 0;
      const base = v * DEATH_COUNT;
      for (let d = 0; d < DEATH_COUNT; d++) dead += this.byCause[base + d];
      this.deaths[v * 12 + slot] = dead;
      this.pops[v * 12 + slot] = V.a.pop[v];
      // ---- 族（#9-D）。1月1族。老衰・難産・産褥・乳幼児 は数えない
      this.causes(v, tmp);
      V.a.kin[v] = kinOfMonth(tmp);
      // 12ヶ月の窓ぶんの族も持つ（#6-C 条件B・条件C は12ヶ月で見るため）
      const kb = (v * 12 + slot) * 7;
      for (let g = 0; g < 7; g++) this.kinRing[kb + g] = 0;
      for (let dd = 1; dd < DEATH_COUNT; dd++) {
        const kk = DEATH_KIN[dd];
        if (kk !== KIN_NONE) this.kinRing[kb + kk] += tmp[dd];
      }
      // ---- 死者率 r ＝ 直近12ヶ月の死者数 ÷ 12ヶ月前の村人口
      let sum = 0;
      for (let k = 0; k < 12; k++) sum += this.deaths[v * 12 + k];
      const back = this.pops[v * 12 + (slot + 1) % 12];      // 12ヶ月前の枠＝次に上書きされる枠
      V.a.kinRate[v] = back > 0 ? sum / back : 0;
      for (let d = 0; d < DEATH_COUNT; d++) this.byCause[base + d] = 0;
    }
  }

  /** 直近12ヶ月の死者数 */
  deaths12(v) {
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += this.deaths[v * 12 + k];
    return sum;
  }

  /**
   * 直近12ヶ月の族（#6-C 条件B の「その災いの族」）。
   * ★ 1ヶ月ぶんの族（V.a.kin）ではなく**窓ぜんぶ**で最多の族を採る。
   *   条件B が12ヶ月窓で判定するので、族も同じ窓で見ないと
   *   「災いは12ヶ月前、族は今月の1件」という食い違いが起きる。
   * ★ 同数なら族番号の小さいほう（#9-D と同じ決定性の規則）
   */
  kin12(v) {
    let best = KIN_NONE, bestN = 0;
    for (let g = 1; g < 7; g++) {
      let n = 0;
      for (let m = 0; m < 12; m++) n += this.kinRing[(v * 12 + m) * 7 + g];
      if (n > bestN) { bestN = n; best = g; }
    }
    return best;
  }

  /** 9-E(a)：大きな災いか。★ 発火したら 12ヶ月あける */
  isBig(V, v, tick) {
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += this.deaths[v * 12 + k];
    if (sum < BIG_DEAD_MIN) return false;
    const back = this.pops[v * 12 + ((tick / 30 | 0) + 1) % 12];
    if (back <= 0 || sum < back * BIG_DEAD_SHARE) return false;
    const since = V.a.bigSince[v];
    if (since >= 0 && (tick - since) < BIG_COOLDOWN * 30) return false;
    return true;
  }
}

// ---------------------------------------------------------------------------
/**
 * 年の収穫係数から出る厄災の点（正典 2384-2385）。
 *   厳冬（0.70未満）X=8 S={⑤}／凶作（0.85未満）X=5 S={⑤,③}。どちらも村の12歳以上。
 * ★ 乱数を1回も引かない（作柄はもう引かれている）。
 */
export function harvestX(P, harvest, onX) {
  const A = P.a;
  const X = harvest < 0.70 ? HARSH_X : harvest < 0.85 ? POOR_X : 0;
  if (!X) return 0;
  const set = harvest < 0.70 ? S_GOD : S_GOD_RULE;
  let n = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < X_AGE) continue;
    if (A.village[i] === NO_VILLAGE) continue;
    onX(i, X, set); n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 9-B　確定イベント（正典3-7 の直訳。2件だけ）
// ---------------------------------------------------------------------------
//
// | 人口が10人に届いた月の翌月（導入の終わり） | 嵐（導入版） | 天（台帳で決め打ち） |
// | 人口が100人に届いた月（フェーズ2の入口）   | 疫病         | 疫（台帳で決め打ち） |
// | それ以降 | 乱数のみ。確定イベントは無い | 死因から引く（9-D） |
//
// ★ **これが無いと宗教が一度も起きない。**#6-C の平常の門は T_i=35 で、
//   ヘッドレスでは未叙爵の村長が 33.3 で止まる（正典 5334）。
//   確定イベントの門（T_i=25・p0=0.90）だけが最初の1件を通す。
//   正典 4426：「**オーナーが1人も呼ばなくても宗教は生える。**」
//
// ★ 導入版の嵐は **死者ゼロの軽い版に固定する。蔵にも収穫係数にも触れない。**
//   正典 6705：M-33 の「8人＋台本・守りなし 1.8%」は嵐なしで測った値なので、
//   人口10人の村（4軒）から蔵を抜くと A-25b の採用根拠が測り直しになる。
//   **導入版から蔵と収穫係数を外せば、絶滅率の実測に一切影響しない。**

export const SCRIPT_POP_STORM = 10;    // 人口10人に届いた月の翌月
export const SCRIPT_POP_PLAGUE = 100;  // 人口100人に届いた月

/** 確定イベントの進行状態。ワールドが1つ持つ */
export const EVENT_WINDOW_MONTHS = 12;   // #6-C 条件B「**直近12ヶ月に**大きな災いがあった」

export class Script {
  constructor() {
    this.stormAt = -1; this.stormDone = false; this.plagueDone = false;
    // ★ 確定イベントは**12ヶ月ぶん生きる**。1ヶ月だけにすると、正典の検算
    //   「村長 信心66 → 12ヶ月で80%」が「1ヶ月で12.6%」になり、宗教がほぼ起きない
    this.liveKin = new Map();        // 村 → 族
    this.liveUntil = -1;             // この tick まで条件Bが立つ
  }
  /** その村で確定イベントの窓が生きているなら台帳の族、無ければ0 */
  kinAt(v, tick) { return tick <= this.liveUntil ? (this.liveKin.get(v) ?? 0) : 0; }
  open(villages, kin, tick) {
    this.liveKin = new Map(villages.map((v) => [v, kin]));
    this.liveUntil = tick + EVENT_WINDOW_MONTHS * 30;
  }
  save() {
    return { stormAt: this.stormAt, stormDone: this.stormDone, plagueDone: this.plagueDone,
             liveKin: [...this.liveKin], liveUntil: this.liveUntil };
  }
  load(o) { Object.assign(this, o); this.liveKin = new Map(o.liveKin ?? []); return this; }
}

/**
 * 確定イベントを回す。★ 乱数を1回も引かない（確定だから）。
 * @returns {{kind:0|1|2, villages:number[], kin:number}} kind 0=無し 1=導入の嵐 2=フェーズ2の疫病
 */
export function scriptedEvent(P, V, H, pop, tick, script, rng, onX) {
  const A = P.a, VA = V.a, nv = VA.len;

  // ---- 導入の嵐（人口10人に届いた月の**翌月**）----
  if (!script.stormDone) {
    if (script.stormAt < 0 && pop >= SCRIPT_POP_STORM) script.stormAt = tick;
    else if (script.stormAt >= 0 && tick >= script.stormAt + 30) {
      script.stormDone = true;
      // 家1軒だけが損壊（住人は3ヶ月 間借り＝疲労 段+1）／森・辺境の1名が負傷（軽・w=1）
      let lodged = 0, hurt = 0;
      for (let i = 0; i < A.len && (lodged < 1 || hurt < 1); i++) {
        if (!A.alive[i]) continue;
        if (lodged < 1) { A.fatigue[i] += 3; lodged++; }
        if (hurt < 1 && (A.job[i] === 2 || A.job[i] === 4) && !A.hurtStage[i]) {
          A.hurtStage[i] = 1; A.hurtPart[i] = PART_ARM; A.hurtHeal[i] = healMonths(P, i, 1); hurt++;
        }
      }
      // ★ 蔵に触れない。収穫係数に触れない。死者を出さない。
      //   ★ 不満の X も出さない ── 正典 6699 が導入版の中身を3つに**限定して列挙**しており、
      //     X はその中に無い。「厄災という種類のものがある」だけを教える行事
      const vs = [];
      for (let v = 0; v < nv; v++) if (VA.alive[v]) { VA.kin[v] = KIN_HEAVEN; vs.push(v); }
      script.open(vs, KIN_HEAVEN, tick);
      return { kind: 1, villages: vs, kin: KIN_HEAVEN };
    }
  }

  // ---- フェーズ2の入口の疫病（人口100人に届いた月）----
  if (!script.plagueDone && pop >= SCRIPT_POP_PLAGUE) {
    script.plagueDone = true;
    // ★★ B-27：正典は「**その村**に宗派が1つも無ければ何も起きない」と**単数**で書いている（6709行）。
    //   だが「人口が100人に届いた月」は国の目盛りなので、どの村かが書かれていない。
    //   → **いちばん人の多い村1つ**に落とす。疫病の式そのものが `人口密度 × …` で
    //     密度に比例すると決まっている（正典2367）ので、最大の村が最も素直な既定。
    //   ★ 全村に落とすと国ぜんぶが同月に段3（からだ×0.52）になり、
    //     実測で人口117→2 まで潰れた。「宗教を起こさせたいタイミング」が
    //     「国が滅ぶタイミング」になってしまう。
    let big = -1, bigN = -1;
    for (let v = 0; v < nv; v++) if (VA.alive[v] && VA.pop[v] > bigN) { bigN = VA.pop[v]; big = v; }
    const vs = [];
    for (let v = 0; v < nv; v++) {
      if (v !== big || !VA.alive[v]) continue;
      vs.push(v); VA.kin[v] = KIN_PLAGUE;
      for (let i = 0; i < A.len; i++) {
        if (!A.alive[i] || A.village[i] !== v) continue;
        // ★ **確定なのは「疫病が来ること」であって「全員がかかること」ではない。**
        //   正典の検算は「確定疫病（村の12%が死ぬ）」なので、かかる割合は乱数版と同じ器を使う
        if (rng.next() < PLAGUE_SICK_SHARE && !A.sickStage[i]) {
          A.sickStage[i] = PLAGUE_STAGE;
          A.sickHeal[i] = sickMonths(P, i, PLAGUE_STAGE);
        }
        if ((A.ageMonths[i] / 12 | 0) >= X_AGE) onX(i, PLAGUE_X, S_GOD_OUT);
      }
    }
    script.open(vs, KIN_PLAGUE, tick);
    return { kind: 2, villages: vs, kin: KIN_PLAGUE };
  }
  return { kind: 0, villages: [], kin: KIN_NONE };
}
