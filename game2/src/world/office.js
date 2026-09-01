// 身分・爵位・役職（正典 #10 ＋ 正典3-1）。
//
// ★ ここが社会の底。入らないと下が全部止まる：
//     立場 ＝ 爵位の段×10 ＋ 役職の段×15 が常に 0
//       → 傲慢の不満が全員 1.000 に張り付く（満たす道が構造的に存在しない）
//       → 影響力 ＝（評判＋立場＋つながり点）/3 が門35に届かない
//       → 宗教も謀反も一度も起きない
//       → 不満④の出口のうち最大の2本（役職 −25×ΔQ／叙爵 −10×ΔP）が開かない
//
// ★ **乱数を1回も引かない。**昇級も世襲も任命も全部決定論。
//   だから基準線（M-01〜M-08）は、この機構が世界に効いたぶんしか動かない。
//
// ★ 身分と役職は別の軸（#10-D）。
//     身分（rank）… 世襲する。上がるが下がりにくい
//     役職（post）… 世襲しない。席が空いたら誰かが座る
//   そして **役職に就いても自動では叙爵しない**（#10-E）。
//   「無印なのに冠をかぶっている ＝ 平民出身の村長」が盤面の見せ場として名指しされている。

import * as S from '../core/stats.js';
import {
  RANK_SERF, RANK_COMMON, RANK_KNIGHT, RANK_BARON, RANK_DUKE, RANK_NAMES, titleStep,
  POST_NONE, POST_HEADMAN, POST_MAYOR, POST_CHIEF, HEADMAN_HOUSES,
  BUREAUS, BUREAU_MAX, TOWN_VILLAGES, RANK_DUKE as R_DUKE,
  GRADE_MIN, GRADE_MAX, GRADE_YEARS, GRADE_REP, NO_VILLAGE,
} from './people.js';
import { civicTotal } from './condition.js';
import * as REP from './reputation.js';
import * as DIS from './discontent.js';

// ---- 叙爵の代金（#10-E ＋ 第9部 裁定1） -------------------------------------
export const ENNOBLE_AMBITION = 8;      // 野心 drift += 8（叙爵ごと）
export const ENNOBLE_AMBITION_CAP = 40; // 上限 +40。★叙爵は5回なので 5×8 でちょうど上限
export const ENNOBLE_REP = 10;          // 評判 +10
export const ENNOBLE_SELF = 10;         // 不満④ −10 × Δ爵位の段（裁定1。#10-E の「−20」は旧記載）
export const POST_SELF = 25;            // 不満④ −25 × Δ役職の段（#5 §4）

// ---- 世襲（#10-F ＋ B-17 の裁定） -------------------------------------------
export const HEIR_DROP = 1;             // 継ぐ段 ＝ 親の rank − 1（法務局カードの既定）
// ★★ B-17：正典は「次男以降 ＝ rank 0」「下限0」と書いているが、
//   それは農奴を足す前（rank0＝平民）の記述。いまの番号だと rank0＝農奴なので、
//   そのまま実装すると**貴族の次男が全員農奴になり、公爵家が6世代で消える。**
//   正典3-1 は「農奴になる道は2本だけ（飢饉で糧を借りた家／敗戦で焼けた村の生き残り）」
//   と明記しており、真正面から衝突する。→ **下限は 1（平民）。次男以降も 1。**
export const RANK_FLOOR = RANK_COMMON;

const ID_AMBITION = S.needId('野心');

/** その rank に叙せる村の数（#10-A）。治める土地の大きさで爵位が決まる */
export function rankForVillages(n, allFrontier = false) {
  if (n <= 0) return RANK_COMMON;
  if (n >= 9) return RANK_DUKE;                    // 街1つ
  if (n >= 3) return allFrontier ? 6 : 5;          // 侯爵（全部が辺境）／伯爵
  if (n >= 2) return 4;                            // 子爵
  return RANK_BARON;                               // 男爵（村1つ）
}

// ---------------------------------------------------------------------------
/**
 * 叙爵・降爵。★ 乱数を引かない。
 * @returns 動いた段の差（Δ爵位の段）。動かなければ0
 */
export function setRank(P, i, rank, tick) {
  const A = P.a;
  if (rank < RANK_FLOOR) rank = RANK_FLOOR;
  if (rank > RANK_DUKE) rank = RANK_DUKE;
  const before = A.rank[i];
  if (rank === before) return 0;
  const dP = titleStep(rank) - titleStep(before);
  A.rank[i] = rank;
  A.grade[i] = GRADE_MIN;                 // 叙爵で等級はリセット（#10-C）
  A.rankSince[i] = tick;
  if (dP > 0) {
    REP.award(P, i, ENNOBLE_REP);                              // 評判 +10
    DIS.relieveSelf(P, i, ENNOBLE_SELF * dP);                  // 不満④ −10×ΔP
    // ★ 野心は上がるが下がらない（正典3-10）。こころに努力値は積まれないので ev を drift として使う
    //   （正典が要求する drift 列そのものはまだ無い。入った日にここを移す）
    const a = A.ev[ID_AMBITION][i] + ENNOBLE_AMBITION * dP;
    A.ev[ID_AMBITION][i] = a > ENNOBLE_AMBITION_CAP ? ENNOBLE_AMBITION_CAP : a;
  }
  return dP;
}

/** 役職に就ける／外す。★ 乱数を引かない */
export function setPost(P, i, post, village, tick) {
  const A = P.a;
  const before = A.post[i];
  if (post === before) return 0;
  const dQ = post - before;
  A.post[i] = post;
  A.postVillage[i] = post === POST_NONE ? NO_VILLAGE : village;
  if (dQ > 0) {
    REP.award(P, i, REP.REP_EVENT.役職に就いた);               // 評判 +10
    DIS.relieveSelf(P, i, POST_SELF * dQ);                     // 不満④ −25×ΔQ
  } else {
    REP.award(P, i, REP.REP_EVENT.罷免);                       // 評判 −15
  }
  return dQ;
}

// ---------------------------------------------------------------------------
// 席と任命
// ---------------------------------------------------------------------------
//
// ★★ B-15 の裁定：**任命はオーナーの専権**だと正典が3箇所で書いている。
//   だが「オーナーが押さないときに誰が座るか」が正典のどこにも無い。
//   ヘッドレスで回すかぎり席は永久に空で、社会機構が1つも動かない。
//   正典 M-A3 が「1件も止めず1人も呼ばず200年回したときの滅び率を測る」と言っている以上、
//   **オーナーが何もしない世界も回らないと測れない。**
//
//   → 正典 #13-G の「局長の推挙」の4分岐（野心型＝国民力①の降順／保身型＝勤続の長い順／
//     誇り型＝評判の降順／従順型＝身内）を**既定の運転**として流用する。
//     ★ ただし最初の村長には任命者がいない。任命者が居ないあいだは
//       **野心型（国民力①の降順）**を既定にする ── 実力主義がいちばん素直な既定であり、
//       正典が「国民力は誰から見ても同じ公の値」と決めているので恣意が入らない。
//
//   ★ オーナーが動詞「置く（席）」を撃てば、いつでも上書きできる（原理I：宛先は席）。

export const APPOINT_MIN_AGE = 18;

// ---------------------------------------------------------------------------
// 功績で叙する（オーナーの言葉 2026-08-29。起票は B-41。★ B-33 は別の未裁定の議題だった）
// ---------------------------------------------------------------------------
//
// ★ オーナーの答え：「**評判というか功績かな。特に戦果。**
//   あくまでステ依存の確率数学のはずなので**わんちゃん一発逆転**もあると思うし」
//
// ★ #10-E「役職に就いても**自動では**叙爵しない」を壊さない。
//   席に座っただけでは何も起きない。**功績を立てた者だけが叙される。**
//   だから「無印なのに冠をかぶっている ＝ 平民出身の村長」（キャラビジュアル §5 の見せ場）は
//   そのまま盤面に残る ── 手柄を立てていない村長は一生 平民のままだから。
//
// ★ 基準は正典4011「法務局のつまみ：**叙爵の基準「評判 ◯ 以上」**」の既定値。
//   評判は**年−1で0へ戻る**（#6-A）ので、これは「いま手柄が立っている」ことを意味する。
//   ◯ = 20 の根拠：正典3-2 の評判表で 20 に届く道は
//     戦の手柄15 ＋ 役職10 ／ 施し20 ／ 発掘25 ／ 戦の手柄を2回 の4本だけ。
//   **老衰まで生きた（+5）や子を5人育てた（+5）だけでは絶対に届かない。**
//   ＝「長生きしただけの村長は叙されない。手柄を立てた者だけが叙される」が数になる。
export const ENNOBLE_REP_MIN = 20;

// ★★ **戦果は減衰しない。**これが「評判**というか**功績」の意味。
//   正典 #6-A は評判を「年−1で0へ戻る」と決めているので、
//   評判だけを基準にすると、席に就いた者が叙爵に届く窓が**就任後の数年だけ**になる。
//   実測：400年・村120・街13 でも**公爵が1人も生まれず、局が1つも座らなかった。**
//   → **討ち取った者は、いつ討ち取ったかに関わらず功績を持つ。**
//     オーナー裁定「目に見えてわかる戦果」がそのまま叙爵の鍵になる。
export const ENNOBLE_KILLS_MIN = 1;   // 1人でも討ち取っていれば功績
export const ENNOBLE_MIN_POST = POST_HEADMAN;   // 席に就いている者だけ（治める土地が要る）

// ★★ **武功の道（正典3719「平民でも武功で入れる（戦功3回で rank1・#10-A）」）**★★
//   2026-08-31（別セッションの精査で発見）：この経路が**コードに1行も無かった**。
//   上の叙爵は「席に就いている者」だけを見るので、**席の無い平民は何回討ち取っても
//   一生 平民**だった（実測：300年で平民以外 0.44%・子爵0・農奴0）。
//   その先が全部詰まる ── 騎士が生えない → 街長・局長の候補が居ない →
//   **局が300年で最大2** → 祭祀局長が居ない → **異端狩りが40種300年で0件**。
//   ★ 席は要らない。**討ち取り3回で騎士（rank1）**。これが柱3「平民でも武功で入れる」。
export const KNIGHT_KILLS = 3;

/**
 * 席の生成と任命。★ 乱数を1回も引かない。
 * @returns {{seated:number, ennobled:number}}
 */
export function officeMonth(P, V, H, tick) {
  const A = P.a, nv = V.a.len;
  let seated = 0, ennobled = 0, knighted = 0;

  // ---- 武功の道（正典3719）。★ 席を問わない。乱数を引かない ----
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    if (A.rank[i] >= RANK_KNIGHT) continue;
    if (A.kills[i] < KNIGHT_KILLS) continue;
    if (setRank(P, i, RANK_KNIGHT, tick) > 0) { knighted++; ennobled++; }
  }

  // ---- 村ごとに、席が生えているか・埋まっているかを見る ----
  // ★ **1周で済ませる。**村ごとに全人口をなめると O(村数 × 人口) になり、
  //   村278・人口12,000 で月330万回。10万人の世界では動かない（#12 の要件）。
  const cur = new Int32Array(nv).fill(-1);      // その村の村長
  const best = new Int32Array(nv).fill(-1);     // 空席のときの既定の候補
  const bestV = new Float64Array(nv).fill(-1);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const pv = A.postVillage[i];
    if (A.post[i] === POST_HEADMAN && pv < nv) cur[pv] = i;
    const v = A.village[i];
    if (v >= nv) continue;
    if (A.post[i] !== POST_NONE) continue;
    if ((A.ageMonths[i] / 12 | 0) < APPOINT_MIN_AGE) continue;
    const c = civicTotal(P, i);                 // 国民力①の降順。同点は添字の小さい順
    if (c > bestV[v]) { bestV[v] = c; best[v] = i; }
  }
  for (let v = 0; v < nv; v++) {
    if (!V.a.alive[v]) continue;
    if (V.a.houses[v] < HEADMAN_HOUSES) continue;      // まだ席が生えていない（10軒目・#10-D）
    if (cur[v] >= 0) continue;                         // 埋まっている
    if (best[v] < 0) continue;                         // 座れる者がいない
    setPost(P, best[v], POST_HEADMAN, v, tick);
    A.postSince[best[v]] = tick;
    seated++;
    // ★ 役職に就いても自動では叙爵しない（#10-E）。
    //   「無印なのに冠をかぶっている ＝ 平民出身の村長」がそのまま盤面に出る
  }

  // ---- 街長の席（#10-D「村が9つ以上のとき生える」）----
  // ★ 街 ＝ 村 ÷ 9（切り捨て）。人口900 → 村9 → 街1 → 局1（正典 8-3）
  let live = 0;
  for (let v = 0; v < nv; v++) if (V.a.alive[v]) live++;
  const towns = Math.min(BUREAU_MAX, Math.floor(live / TOWN_VILLAGES));

  let mayors = 0, chiefs = 0;
  const taken = new Uint8Array(BUREAUS.length + 1);
  let duke = -1, dukeSince = Infinity, mayorBest = -1, mayorV = -1;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const post = A.post[i];
    if (post === POST_MAYOR) mayors++;
    else if (post === POST_CHIEF) { chiefs++; taken[A.bureau[i]] = 1; }
    // 局長の候補：公爵で、まだ局に就いていない者。在任の長い順
    if (A.rank[i] >= R_DUKE && post !== POST_CHIEF && A.rankSince[i] < dukeSince) {
      dukeSince = A.rankSince[i]; duke = i;
    }
    // 街長の候補。★★ **村長からの昇任を含める。**
    //   無役だけから選ぶと、功績で男爵になった村長が街長に昇れず、
    //   正典 8-3「1つしかない街長の席を**9回まわして**公爵を9人作る」が構造的に回せない。
    //   実測：400年・村120・街13 でも公爵0・局0 のまま。
    //   ★ 既に有爵の者（＝功績を証明済み）を優先する。同格なら国民力①の降順
    if ((post === POST_NONE || post === POST_HEADMAN) && (A.ageMonths[i] / 12 | 0) >= APPOINT_MIN_AGE) {
      const c = A.civicSum[i] + A.rank[i] * 1000;   // 有爵が必ず前に出る
      if (c > mayorV) { mayorV = c; mayorBest = i; }
    }
  }

  // ---- 局の席（正典 8-3「局は街が生えるたびに1つ生える」）----
  // ★ 局長 ＝ **公爵でなければ座れない**（#10-A）。公爵は「街1つ＝村9以上」を治めた者。
  //   だから局を10そろえるには街長の席を9回まわして公爵を9人作るしかない。
  //   ★ そのたびに「**領地を失った公爵**」（P=5・Q=0・I=56.7）が1人生まれ、
  //     #4-(e) の検算で年2.5%の謀反の主役になる。**10局そろった国は必ず謀反層を9人抱える。**
  //   （正典 8-3 が「誰も書いていなかった帰結」として明文化している）
  if (chiefs < towns) {
    const best = duke;                          // 上の1周で見つけた公爵
    if (best >= 0) {
      let slot = 0;
      for (let k = 1; k <= BUREAUS.length; k++) if (!taken[k]) { slot = k; break; }
      if (slot) {
        setPost(P, best, POST_CHIEF, NO_VILLAGE, tick);
        A.bureau[best] = slot; A.postSince[best] = tick;
        chiefs++; seated++;
      }
    }
  }

  // ---- 街長の席。空いていれば埋める ----
  if (mayors < towns && mayorBest >= 0) {
    // ★ 村長から昇るときは村の席が空く。翌月、既定の運転で誰かが座る（B-15）
    setPost(P, mayorBest, POST_MAYOR, NO_VILLAGE, tick);
    A.postSince[mayorBest] = tick; seated++;
  }

  // ---- 功績で叙する（B-41。オーナーの言葉「評判というか功績かな。特に戦果」）----
  // ★ 席に就いていて、いま評判が基準に届いている者だけ。乱数を1回も引かない
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    if (A.post[i] < ENNOBLE_MIN_POST) continue;
    // ★★ **功績の門は「初めて叙されるとき」だけ。**
    //   一度でも叙された者（＝功績を証明済み）は、以後 **爵位が治める土地に従う**（#10-A）。
    //   でなければ、男爵の村長が街長に昇っても公爵になれず、局が永久に座らない。
    //   正典 #10-A「治める土地の大きさで爵位が決まる」がそのまま効く形。
    if (A.rank[i] < RANK_BARON) {
      // 功績 ＝ **戦果（減衰しない）** または **いまの評判**（施し・発掘など戦以外の道）
      if (A.kills[i] < ENNOBLE_KILLS_MIN && A.rep[i] < ENNOBLE_REP_MIN) continue;
    }
    // 治める土地の大きさで爵位が決まる（#10-A）
    //   村長 → 村1つ＝男爵 ／ 街長 → 村9つ＝**公爵** ／ 局長 → 公爵のまま
    const want = A.post[i] === POST_HEADMAN ? rankForVillages(1)
               : rankForVillages(TOWN_VILLAGES);
    if (A.rank[i] >= want) continue;
    if (setRank(P, i, want, tick) > 0) ennobled++;
  }
  return { seated, ennobled, knighted, towns, mayors, chiefs };
}

// ---------------------------------------------------------------------------
/**
 * 年次。等級 g の昇級と、平民の段（村内の財の五分位）。★ 乱数を引かない。
 * @param wealthQuintile (i) → 0..4。呼ぶ側が村ごとに作る
 */
export function officeYear(P, tick, wealthQuintile) {
  const A = P.a;
  let promoted = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;

    // 平民の段 1〜5。★ rank=1（平民）のときだけ出す。毎年引き直すので**下がる**
    A.commonTier[i] = A.rank[i] === RANK_COMMON ? 1 + wealthQuintile(i) : 0;

    // 等級 g。騎士以上だけ。在任年数 ＋ 評判 の2つを満たしたら1段上がる（#10-C）
    if (A.rank[i] < RANK_KNIGHT) { A.grade[i] = GRADE_MIN; continue; }
    if (A.grade[i] < GRADE_MIN) A.grade[i] = GRADE_MIN;
    if (A.grade[i] >= GRADE_MAX) continue;
    const years = (tick - A.rankSince[i]) / 360;
    const g = A.grade[i];
    if (years >= GRADE_YEARS[g] && A.rep[i] >= GRADE_REP[g]) { A.grade[i] = g + 1; promoted++; }
  }
  return { promoted };
}

// ---------------------------------------------------------------------------
/**
 * 世襲（#10-F）。家督を継いだ者が身分を継ぐ。
 * ★ 長男が 親の rank − 1 を継ぐ。次男以降は平民（B-17）。役職 Q は世襲しない。
 * @param heir 家督を継いだ者
 * @param from 前の家長（死んだ者）
 */
export function inherit(P, heir, from, tick) {
  const A = P.a;
  if (from < 0 || from >= A.len) return 0;
  const want = A.rank[from] - HEIR_DROP;
  return setRank(P, heir, want, tick);
}

export { RANK_NAMES, POST_NONE, POST_HEADMAN, POST_MAYOR, POST_CHIEF, titleStep };
