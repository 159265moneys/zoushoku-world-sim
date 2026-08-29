// 宗派（正典3-6 ＋ #6-C ＋ #8）。**乱数は宗教のストリーム（7番）だけを引く。**
//
// ★ ここに来るまでに正典が「順番を間違えると起きない」と名指しした前提が3つあった：
//     影響力（#6-B）… 発起の門 T_i に要る。役職が無いと立場が0で永久に届かない
//     族（#9-D）    … origin に要る。厄災が無いと族が立たない
//     死者率 r（#9-E）… 条件B と 重さ係数 W に要る
//   3つとも #6-B・#9 で入ったので、ここで初めて宗教が起きる。
//
// ★ **教義を用意しない。**発起人のステと、起源の災いから読み出す（正典 2190）。
//   だから「万民平等の宗教」も「焚刑教団」も、教義表を書かずに人から出てくる。
//
// ★ **階層性と布教は差で取る。**信心・序列意識・郷土愛は同じ腕（13番B・M-42）にあるので、
//   そのまま使うと**すべての宗教が階層的で内向きになり、「万民平等」も「布教する宗教」も
//   出なくなる。**この2行だけ 50 ＋ 差÷2 の形をしているのはそのため。

import * as S from '../core/stats.js';
import { make } from '../core/arrays.js';
import {
  SECT_NONE, MODE_LAY, MODE_ZEALOT, MODE_RESIGNED,
  faithStep, STEP_DIVERT, DIVERT_CAP,
  KIN_PLAGUE, KIN_FAMINE, KIN_HEAVEN, KIN_WAR, KIN_PUNISH, KIN_NONE, KIN_NAMES,
  NO_VILLAGE,
} from './people.js';

// ---------------------------------------------------------------------------
// 教義の軸（正典 2196-2215 の表そのまま。1行も足していない）
// ---------------------------------------------------------------------------
// ★ 基（ステから直に読む）と 派生（他の軸から作る）を分ける。順番が要るのは派生のほう。
const ID = {};
for (const n of ['信心','執念','弁舌','残酷さ','規範意識','従順','誇り','情',
                 '論理','潔癖','貪欲','勤勉','序列意識','郷土愛']) ID[n] = S.needId(n);

/** 基の軸：その人ひとりから読める値 */
export const BASE_AXES = [
  '信仰性', '教義の硬さ', '伝播の速さ', '異端狩りの激しさ', '異端狩りの厳格さ',
  '異端の処し方', '排他性', '慰霊の厚さ', '体系化', '戒律の細かさ',
  '蓄財', '労働倫理', '階層性', '布教するか', '儀礼の頻度', '死の受容', '団結',
];
/** 派生の軸：基が確定してから作る */
export const DERIVED_AXES = ['恐怖への耐性', '恨みの風化率', '帰属の付け替え', '解釈分派の率'];
export const AXES = [...BASE_AXES, ...DERIVED_AXES];
export const AX = {};
AXES.forEach((n, k) => { AX[n] = k; });

/** その人ひとりから基の軸を読む。★ 実効値ではなく現在値（gene+ev）を使う ── 教義は
 *  「その人がどういう人間か」であって「いま病んでいるか」ではない */
function readBase(P, i, out) {
  const A = P.a;
  const v = (n) => A.gene[ID[n]][i] + A.ev[ID[n]][i];
  const 信心 = v('信心'), 情 = v('情'), 潔癖 = v('潔癖'), 弁舌 = v('弁舌');
  out[AX.信仰性] = 信心;
  out[AX.教義の硬さ] = v('執念');
  out[AX.伝播の速さ] = 弁舌;
  out[AX.異端狩りの激しさ] = v('残酷さ') * 信心 / 100;          // 狂信の側
  out[AX.異端狩りの厳格さ] = v('規範意識') * v('従順') / 100;    // 秩序の側
  out[AX.異端の処し方] = v('残酷さ');
  out[AX.排他性] = v('誇り');
  out[AX.慰霊の厚さ] = 情;
  out[AX.体系化] = v('論理');
  out[AX.戒律の細かさ] = 潔癖;
  out[AX.蓄財] = v('貪欲');
  out[AX.労働倫理] = v('勤勉');
  // ★ この2行だけ差で取る（同じ腕にあるステを素で使わないため）
  out[AX.階層性] = 50 + (v('序列意識') - 情) / 2;
  out[AX.布教するか] = 50 + (弁舌 - v('郷土愛')) / 2;
  out[AX.儀礼の頻度] = (潔癖 + 信心) / 2;
  out[AX.死の受容] = (信心 + 情) / 2;
  out[AX.団結] = (v('郷土愛') + 信心) / 2;
  return out;
}

/** 派生の軸。★ 基（＝補正を当てたあと）から作る */
function fillDerived(d) {
  d[AX.恐怖への耐性] = d[AX.信仰性] * d[AX.死の受容] / 100;
  d[AX.恨みの風化率] = d[AX.慰霊の厚さ] * d[AX.儀礼の頻度] / 100;
  // ★ 天井 0.6。正典3-16c「4割は必ず統治に残る」は絶対
  d[AX.帰属の付け替え] = d[AX.信仰性] * d[AX.体系化] / 100 * DIVERT_CAP;
  d[AX.解釈分派の率] = d[AX.体系化] / 100 * (1 - d[AX.教義の硬さ] / 100) * 0.02;
}

// ---- 起源の族の補正（正典 2232-2240 の表そのまま）---------------------------
// ★ 族の番号は people.js の 1起点（0=なし）。正典の 0起点とは1ずれるが並びは同じ
export const ORIGIN_FIX = {
  [KIN_PLAGUE]: [['戒律の細かさ', 20], ['排他性', 15]],
  [KIN_FAMINE]: [['蓄財', -20], ['慰霊の厚さ', 10]],
  [KIN_WAR]:    [['死の受容', 25], ['恐怖への耐性', 15]],
  [KIN_PUNISH]: [['異端狩りの激しさ', 20], ['教義の硬さ', 15]],
  [KIN_HEAVEN]: [['信仰性', 15], ['儀礼の頻度', 15]],
};

const clamp100 = (v) => (v < 0 ? 0 : v > 100 ? 100 : v);

/**
 * 教義を作る（正典 2194）。
 *   教義の項目 ＝ 発起人の値 × 0.7 ＋ 初期の信徒の平均 × 0.3 ＋ 起源の災いの補正
 * ★ 派生の軸は「基に補正を当てたあと」に作る。そうしないと
 *   戦の「死の受容 +25」が 恐怖への耐性 に伝わらない（恐怖 ＝ 信仰性 × 死の受容 ÷100）。
 * ★ 乱数を1回も引かない。
 */
export const FOUNDER_W = 0.7, FOLLOWER_W = 0.3;

export function makeDoctrine(P, founder, followers, origin) {
  const d = new Float64Array(AXES.length);
  const f = new Float64Array(AXES.length);
  readBase(P, founder, d);
  if (followers.length) {
    const acc = new Float64Array(AXES.length);
    for (const j of followers) {
      readBase(P, j, f);
      for (let k = 0; k < BASE_AXES.length; k++) acc[k] += f[k];
    }
    for (let k = 0; k < BASE_AXES.length; k++) {
      d[k] = d[k] * FOUNDER_W + (acc[k] / followers.length) * FOLLOWER_W;
    }
  }
  // 起源の補正（基に当たるぶん）
  for (const [name, delta] of ORIGIN_FIX[origin] ?? []) {
    if (AX[name] < BASE_AXES.length) d[AX[name]] += delta;
  }
  for (let k = 0; k < BASE_AXES.length; k++) d[k] = clamp100(d[k]);
  fillDerived(d);
  // 起源の補正（派生に当たるぶん。いまは 戦の「恐怖への耐性 +15」だけ）
  for (const [name, delta] of ORIGIN_FIX[origin] ?? []) {
    if (AX[name] >= BASE_AXES.length) d[AX[name]] += delta;
  }
  for (let k = BASE_AXES.length; k < AXES.length; k++) {
    d[k] = k === AX.解釈分派の率 ? d[k] : clamp100(d[k]);
  }
  return d;
}

/**
 * 代替わり（正典 2246）。
 *   新しい値 ＝ 古い値 ×（教義の硬さ÷100）＋ 新しい教主の値 ×（1 − 教義の硬さ÷100）
 * ★ 硬さ100なら1も動かない。0なら教主が代わるたびに別の宗教になる。
 *   **硬い教義に合わない教主が就いたとき、動かせない側が出ていく。それが分派。**
 */
export function succeedDoctrine(P, doctrine, newHead) {
  const h = doctrine[AX.教義の硬さ] / 100;
  const n = new Float64Array(AXES.length);
  readBase(P, newHead, n);
  for (let k = 0; k < BASE_AXES.length; k++) {
    doctrine[k] = clamp100(doctrine[k] * h + n[k] * (1 - h));
  }
  fillDerived(doctrine);
  return doctrine;
}

// ---------------------------------------------------------------------------
// 宗派の台帳
// ---------------------------------------------------------------------------
export const SECT_SPEC = {
  origin: 'u8',        // 族 1疫 2飢 3天 4兵 5罰。★ 6内 は永久に origin になれない
  village: 'u16',      // 発祥の村
  founder: 'i32',
  founded: 'i32',      // 発起した tick
  lastRate: 'f32',     // #9-E：前に的中したときの死者率。次のハードル
  followers: 'i32',    // 信者の数（月ごとに数え直す）
  lowMonths: 'u16',    // 信者10人未満が続いた月数（60で消滅）
  hardBonus: 'u8',     // 狂信が積んだ「教義の硬さ +1」の通算（15まで）
  alive: 'u8',
};

export const DISSOLVE_MIN = 10;      // 信者10人未満が
export const DISSOLVE_MONTHS = 60;   // 60ヶ月続いたら消滅（★これが無いとIDが爆発する）

export class Sects {
  constructor(cap = 16) {
    this.a = make(cap, SECT_SPEC);
    this.doctrine = [null];          // 添字0は無信仰。宗派IDは1から
    this.a.len = 1;                  // ID 0 を無信仰として埋めておく
    this.a.alive[0] = 0;
  }
  get len() { return this.a.len; }

  /** 新しい宗派を1つ立てる。★ 廃絶したIDは再利用しない（年代記に残る） */
  create(origin, village, founder, tick, doctrine) {
    const A = this.a;
    A.ensure(A.len + 1);
    const id = A.len++;
    A.origin[id] = origin; A.village[id] = village; A.founder[id] = founder;
    A.founded[id] = tick; A.lastRate[id] = 0; A.followers[id] = 0;
    A.lowMonths[id] = 0; A.hardBonus[id] = 0; A.alive[id] = 1;
    this.doctrine[id] = doctrine;
    return id;
  }

  ax(id, name) { return this.doctrine[id]?.[AX[name]] ?? 0; }

  /** 実効の帰属の付け替え率（#8 §3）。★ 天井 0.60 は破らない */
  divertRate(id, sect, faith) {
    if (!id) return 0;
    const v = this.ax(id, '帰属の付け替え') / 100 * STEP_DIVERT[faithStep(sect, faith)];
    return v > DIVERT_CAP ? DIVERT_CAP : v;
  }
}

// ---------------------------------------------------------------------------
// 発起（#6-C）── 正典3-6「信心が高い × 影響力がある × 大きな災いの直後」、かつ
//   「なぜ起きたのかに**誰も答えられていない**状態で、答えを出せる者が現れる」
// ---------------------------------------------------------------------------
//
// ★ 門は2組ある。**確定イベントの厄災だけ別の目盛りを持つのは仕様どおり**（正典 5908）。
//   平常  T_f=60 T_i=35 p0=0.05     ← T_i=35 は「村長格だけが通る」線
//   確定  T_f=50 T_i=25 p0=0.90     ← フェーズ1・2には役職が無いか村長1人しかいないので、
//                                     確定イベントで起こさせるにはここまで下げる必要がある
// ★ **門と分母の目盛りを必ず揃える。**門を下げたら分母も下げる。
//   門のすぐ上で p=0、100 で p=p0×W。**確率が負になる区間が生まれない。**

export const T_FAITH = 60, T_INFL = 35, P0 = 0.05;              // 平常
export const T_FAITH_EVENT = 50, T_INFL_EVENT = 25, P0_EVENT = 0.90;   // 確定イベント

// ★★ **最初の1つが根付くまでは、確定イベントの門をそのまま使う**（オーナー裁定 2026-08-29）
//   オーナー：「宗教は大事なので、**最初期の宗教＝種のきっかけは有り余っていい**」
//
//   ★ 新しい門を発明していない。正典が既に持っている2つ目の門を、
//     正典自身が書いた理由の範囲まで広げただけ：
//     正典5907「T_i=25（確定）は…**フェーズ1・2には役職が無いか村長1人しかいない**ので、
//               確定イベントで宗教を起こさせるにはここまで下げる必要がある」
//     ── この理由は確定イベントの2ヶ月だけでなく**序盤ぜんぶ**に当てはまる。
//
//   ★ 実測でここが漏斗だった（種3・400年）：
//       条件B（災い）  860村・回 → ＋条件C（空白）582 → ＋条件A（資格者がその村にいる）**26**
//       → 400年の期待発起数 0.43件。
//     災いの村と資格者が同じ村に居合わせる確率が小さいのが本体。
//
//   ★ **根付いたら平常へ戻る。**「有り余る」のは最初の1つまで。
export const ROOTED_FOLLOWERS = DISSOLVE_MIN;   // 消滅しない大きさ＝根付いた

/** 世界にまだ根付いた宗派が1つも無いか（＝序盤の門を使うか） */
export function isEarly(sects) {
  const SA = sects.a;
  for (let s = 1; s < SA.len; s++) if (SA.alive[s] && SA.followers[s] >= ROOTED_FOLLOWERS) return false;
  return true;
}

export const BIG_DEAD_SHARE_FOUND = 0.08;   // 条件B(b1)：直近12ヶ月の死者 ≥ 村の人口の8%
export const W_BASE_RATE = 3, W_DIV = 5, W_MIN = 1.0, W_MAX = 3.0;
export const FOUND_AGE = 12;                // その村の12歳以上ひとりずつ
export const SEED_FAITH_MIN = 60;           // 初期の信徒：信心 ≥ 60
export const SEED_MAX = 12;                 // 最大12人（発起人を除く）
export const FOUNDER_FAITH = 100, SEED_FAITH = 60;

/** 重さ係数 W = clamp(1.0, 3.0, 1 + (直近12ヶ月の村の死亡率[%] − 3) / 5) */
export function weightOf(rate) {
  const w = 1 + (rate * 100 - W_BASE_RATE) / W_DIV;
  return w < W_MIN ? W_MIN : w > W_MAX ? W_MAX : w;
}

/** 発起の確率／月／人。★ 門のすぐ上で0、100で p0×W */
export function foundP(faithStat, infl, w, event) {
  const tf = event ? T_FAITH_EVENT : T_FAITH, ti = event ? T_INFL_EVENT : T_INFL;
  if (faithStat < tf || infl < ti) return 0;
  const p0 = event ? P0_EVENT : P0;
  return p0 * (faithStat - tf) / (100 - tf) * (infl - ti) / (100 - ti) * w;
}

const ID_PIETY = S.needId('信心');

/**
 * 宗教が起きる月次。★ 乱数は宗教のストリーム（7番）だけを引く。
 * ★ 掟：**その村の12歳以上ひとりずつ必ず1回引く。**条件を満たさなくても引いて捨てる。
 *
 * @param cal   厄災の台帳（Calamity）。条件B と W の入力
 * @param eventKin (v) → その村で確定イベントの厄災が起きたなら**台帳で決め打ちの族**、無ければ 0。
 *   ★ 9-D「確定イベント（9-B）の月だけは、**台帳の族で上書きする**」。
 *     ここを死因から引くと、確定疫病の月に誰も死んでいなければ族が立たず、
 *     「宗教を起こさせたいタイミング」に条件Cが評価できない
 * @returns {{founded:number, ids:number[]}}
 */
export function foundMonth(P, V, sects, cal, tick, rng, eventKin = () => 0) {
  // ★ まだ1つも根付いていないあいだは、確定イベントの門で通す（上の裁定）
  const early = isEarly(sects);
  const A = P.a, VA = V.a, nv = VA.len;
  const out = { founded: 0, ids: [] };

  // 村ごとに、生きている12歳以上を添字の順に集める（決定的）
  const byV = new Array(nv);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < FOUND_AGE) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    (byV[v] ||= []).push(i);
  }

  for (let v = 0; v < nv; v++) {
    const list = byV[v];
    if (!VA.alive[v] || !list || !list.length) continue;

    // ---- 条件B（災い）----
    const dead12 = cal.deaths12(v);
    const pop = VA.pop[v] || list.length;
    const scriptKin = eventKin(v);
    const event = scriptKin > 0 || early;      // ★ 序盤は確定イベントと同じ門
    const b1 = pop > 0 && dead12 >= pop * BIG_DEAD_SHARE_FOUND;
    const bigNow = b1 || event;

    // ---- 条件C（空白）その災いの族に、答えている宗派が村内に無い ----
    // ★ 確定イベントの月は台帳の族で上書き（9-D）。それ以外は12ヶ月窓の死因から引く
    const kin = scriptKin > 0 ? scriptKin : cal.kin12(v);
    let answered = false;
    if (kin !== KIN_NONE) {
      for (const i of list) {
        const sid = A.sect[i];
        if (sid && sects.a.alive[sid] && sects.a.origin[sid] === kin) { answered = true; break; }
      }
    }
    // ★ 6内 は永久に origin になれない（正典 5867）
    const canOrigin = kin >= KIN_PLAGUE && kin <= KIN_PUNISH;
    const live = bigNow && !answered && canOrigin;
    const w = weightOf(pop > 0 ? dead12 / pop : 0);
    let bornHere = false;

    for (const i of list) {
      // ★ 掟：条件を満たさなくても必ず1回引く
      const r = rng.next();
      if (!live || bornHere) continue;                     // ★ 1つの村で1月に2つは起きない（村ごと）
      const piety = A.gene[ID_PIETY][i] + A.ev[ID_PIETY][i];
      if (r >= foundP(piety, A.infl[i], w, event)) continue;

      // ---- 初期の信徒：信心 ≥ 60 の者を信心の高い順に 最大12人（発起人を除く）----
      const seeds = [];
      for (const j of list) {
        if (j === i || A.sect[j] !== SECT_NONE) continue;
        const pj = A.gene[ID_PIETY][j] + A.ev[ID_PIETY][j];
        if (pj >= SEED_FAITH_MIN) seeds.push([pj, j]);
      }
      // ★ 1人も居なければ発起は起きない（誰も聞かない教えは宗教にならない）
      if (!seeds.length) continue;
      seeds.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      const chosen = seeds.slice(0, SEED_MAX).map((x) => x[1]);

      const id = sects.create(kin, v, i, tick, makeDoctrine(P, i, chosen, kin));
      A.sect[i] = id; A.faith[i] = FOUNDER_FAITH; A.mode[i] = MODE_LAY; A.sectMon[i] = 0;
      for (const j of chosen) {
        A.sect[j] = id; A.faith[j] = SEED_FAITH; A.mode[j] = MODE_LAY; A.sectMon[j] = 0;
      }
      out.founded++; out.ids.push(id); bornHere = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
/**
 * 宗派の消滅（★これが無いとIDが爆発する）。
 *   信者が10人未満の状態が60ヶ月続いた宗派は消滅する。
 * ★ 正典3-6「少数派はゼロにならない」と衝突しない ── あちらは**迫害で絶滅しない**ことを
 *   言っており、こちらは10人を5年間下回る＝**そもそも成立しなかった教えを畳む**だけ。
 * ★ 宗派レコードは年代記に残す（消えるのは「生きている宗派」の一覧からだけ）。
 * ★ 乱数を引かない。
 */
export function sectMonth(P, sects) {
  const A = P.a, SA = sects.a;
  for (let s = 1; s < SA.len; s++) SA.followers[s] = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const s = A.sect[i];
    if (s && s < SA.len) SA.followers[s]++;
  }
  let dissolved = 0;
  for (let s = 1; s < SA.len; s++) {
    if (!SA.alive[s]) continue;
    if (SA.followers[s] < DISSOLVE_MIN) {
      if (++SA.lowMonths[s] >= DISSOLVE_MONTHS) {
        SA.alive[s] = 0; dissolved++;
        for (let i = 0; i < A.len; i++) {
          if (A.alive[i] && A.sect[i] === s) {
            A.sect[i] = SECT_NONE; A.faith[i] = 0; A.mode[i] = MODE_LAY; A.sectMon[i] = 0;
          }
        }
      }
    } else SA.lowMonths[s] = 0;
  }
  return { dissolved };
}

// ---------------------------------------------------------------------------
// §4  faith の毎月の動き（★飽和させる）
// ---------------------------------------------------------------------------
//   faith ← clamp(0, 100, faith + 流入 × (1 − faith/100) − 流出 × (faith/100))
//
// ★★ B-31：**正典の更新式と、正典自身の平衡表が食い違っている。**
//   正典が書いた更新式   faith + 流入×(1−faith/100) − 流出        → 平衡 100×(1 − 流出/流入)
//   正典が書いた平衡の式 faith* = 100 × 流入 ÷ (流入 + 流出)
//   この2つが一致するのは、**流出にも ×(faith/100) が掛かるとき**だけ：
//     f + i(1−f/100) − o(f/100) = f  ⇔  i = f(i+o)/100  ⇔  f = 100 i/(i+o) ✓
//   → **平衡表（6行の実データ）のほうを採る。**字面どおりに実装すると
//     流入0.314・流出0.220 で 58.8 ではなく 30.0 に落ち、実測で faith が
//     60→20 へ沈み、段2（faith≥35）が村から消えて**伝播が永久に止まった**
//     （500年で改宗のべ2件・宗派3件すべて消滅・信者0）。
//   ★ 流出を「持っている量の割合」で引くのは減衰の自然な形でもあり、faith が負にならない。
//     流入 = 0.35 ×(信心/60)× 村の同宗派率 ×(1 + 伝播の速さ/100) + 0.40 × 儀礼の頻度/100
//     流出 = 0.35 ×(1 − 信心/100) + 0.40 ×(V⑤/100)
//
// ★ 信心で割るのは 60（レア度F の中央）。50 で割ると流入が2割高く出る。
// ★ **5段すべてに人が残る。**深さを決めているのは「こころ（信心）」「社会（同宗派率・儀礼）」
//   「⑤の高さ」の3つで、どれか1つでは決まらない。
//   少数派に居ても faith は 44〜58 あり、棄教の門（faith<50）をぎりぎり跨ぐ位置。
//   **「勝てないが消えない」がここから出る。**

export const IN_SOCIAL = 0.35, IN_RITE = 0.40, PIETY_DIV = 60;
export const OUT_PIETY = 0.35, OUT_GOD = 0.40;

/** 月次の更新。★ 流出も faith に比例する（B-31。平衡表と一致させるため） */
export function faithStep1(faith, inflow, outflow) {
  const f = faith + inflow * (1 - faith / 100) - outflow * (faith / 100);
  return f < 0 ? 0 : f > 100 ? 100 : f;
}

export function faithFlow(piety, sameRate, spread, rite, v5) {
  const inflow = IN_SOCIAL * (piety / PIETY_DIV) * sameRate * (1 + spread / 100)
               + IN_RITE * (rite / 100);
  const outflow = OUT_PIETY * (1 - piety / 100) + OUT_GOD * (v5 / 100);
  return { inflow, outflow };
}
/** 平衡 faith* = 100 × 流入₀ ÷ (流入₀ + 流出₀) */
export const faithEq = (i0, o0) => (i0 + o0 > 0 ? 100 * i0 / (i0 + o0) : 0);

// ---- 年次の跳ね（正典2-1「信心は飢饉や疫病を越えた年に跳ね」）------------
export const F_SURVIVED = 8, F_SURVIVED_DRIFT = 6, PIETY_DRIFT_CAP = 40;
export const F_LOST_FAMILY = -10, F_WRONG_KIN = -15, F_BURNED = -25;
export const F_HERETIC = -20, F_HERETIC_ZEALOT = 10;

// ---------------------------------------------------------------------------
// §5  継承 ── ★ 信仰は血ではなく育ちで伝わる
// ---------------------------------------------------------------------------
// ★ 継承率を 1.0 にしない理由：完全に継がせると無信仰層が1世代で消え、審問会の獲物が絶える。
//   **0.75 なら、完全に改宗した村でも子の4分の1が毎世代 無信仰として供給される。**
//   これが正典3-6「少数派はゼロにならない」の供給源。
export const INHERIT_AGE = 7;
export const INHERIT_BOTH = 0.75, INHERIT_ONE = 0.40;
export const INHERIT_BASE = 20, INHERIT_SHARE = 0.3;

/** 7歳の誕生月に1回だけ。★ その月の7歳ちょうどの子について、必ず1回引く */
export function inheritMonth(P, rng) {
  const A = P.a;
  let moved = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || A.ageMonths[i] !== INHERIT_AGE * 12) continue;
    const m = A.mother[i], f = A.father[i];
    const ms = m >= 0 && m < A.len && A.alive[m] ? A.sect[m] : SECT_NONE;
    const fs = f >= 0 && f < A.len && A.alive[f] ? A.sect[f] : SECT_NONE;
    const r = rng.next();                       // ★ 親が無信仰でも必ず引く
    if (ms && fs && ms === fs) {
      if (r < INHERIT_BOTH) {
        A.sect[i] = ms;
        A.faith[i] = INHERIT_BASE + INHERIT_SHARE * (A.faith[m] + A.faith[f]) / 2;
        moved++;
      }
    } else if (ms || fs) {
      const p = ms ? m : f, s = ms || fs;
      if (r < INHERIT_ONE) {
        A.sect[i] = s; A.faith[i] = INHERIT_BASE + INHERIT_SHARE * A.faith[p];
        moved++;
      }
    }
    if (A.sect[i]) { A.mode[i] = MODE_LAY; A.sectMon[i] = 0; }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// §6  伝播（入信・改宗）
// ---------------------------------------------------------------------------
// ★ 多数派ほど増えやすい（正典3-6 の収束力1本目）。それでも少数派は0にならない。
//   実測の想定：多数派＋局長の後押しで年5.7%＝半減期12年、少数派へは 0.45%（**8倍有利**）。
export const SPREAD_P0 = 0.010;
export const CREDULITY_DIV = 66;     // 信じやすさ レア度N・中央66
export const SPREAD_DIV = 34;        // 伝播の速さ＝弁舌 レア度B・中央34
export const EXCLUSIVE_DIV = 200;
export const CHIEF_BONUS = 0.6;      // 祭祀局長が同じ宗派なら（収束力2本目）
export const INVITE_LIKE = 55;       // 誘い手：好き嫌い[→i] が 55 以上
export const INVITE_FAITH = 35;      // 誘い手は faith ≥ 35（段2以上）
export const RESIST_FAITH_DIV = 120, RESIST_GRIT_DIV = 150;
export const JOIN_FAITH = 25, CONVERT_FAITH = 40;   // 入信 25／改宗 40
export const V5_ON_JOIN = 0.6;                       // V⑤ ← V⑤ × 0.6
export const CONVERT_HATE = -20;                     // 旧宗派の信徒からの好き嫌いが本人へ −20
export const SECTMON_LOCK = 12;                      // sectMon<12 は改宗の判定を回さない

const ID_CREDULITY = S.needId('信じやすさ');
const ID_GRIT = S.needId('執念');

export function spreadP(credulity, inviteShare, spread, exclusive, chief, faith, grit) {
  const resist = (1 - faith / RESIST_FAITH_DIV) * (1 - grit / RESIST_GRIT_DIV);
  return SPREAD_P0
    * (credulity / CREDULITY_DIV)
    * inviteShare
    * (spread / SPREAD_DIV)
    * (1 - exclusive / EXCLUSIVE_DIV)
    * (1 + CHIEF_BONUS * (chief ? 1 : 0))
    * resist;
}

// ---------------------------------------------------------------------------
// §7  ⑤の4つの出口（正典3-5 の⑤の行動「棄教・狂信・諦観」そのまま）
// ---------------------------------------------------------------------------
// ★ 判定は毎月、**上から順に、最初に当たった1つだけ**実行。
// ★ 掟：**4つとも必ず引いてから**、当たった最初の1つを実行する。
//   （途中で return すると分岐で乱数の回数が変わる）
//
// ★ **⑤に逃がした不満は消えていない。**
//   爆発（③への一括返却）か、緩慢な沈下（④）か、迫害（①）で必ず戻ってくる。

// (1) 諦観 ── ★ 無条件の出口。これが無いと⑤が100に飽和する
export const RESIGN_V5 = 85, RESIGN_P = 0.06, RESIGN_GRIT_DIV = 200;
export const RESIGN_V5_AFTER = 60, RESIGN_SELF_MONTH = 0.5, RESIGN_SELF_AGAIN = 5;
export const RESIGN_WORK = 0.85, RESIGN_CONCEIVE = 0.7, RESIGN_SUICIDE = 1.5;
export const RESIGN_FREE = 0.02;          // 月0.02 で自然に解ける
// ★ 図太さを門にしない。門にすると 信心50〜59・faith>40・図太さ≥40 の層（人口の1〜2割）に
//   どの出口も当たらず、⑤が単調増加で100に張り付く。**図太さは門ではなく速さの倍率。**

// (2) 狂信
export const ZEAL_V5 = 70, ZEAL_FAITH = 70, ZEAL_PIETY = 60, ZEAL_P = 0.10;
export const ZEAL_V5_AFTER = 40, ZEAL_DRIFT = 10, ZEAL_HARD = 1, ZEAL_HARD_CAP = 15;
export const ZEAL_FAITH_FLOOR = 70;       // 以後 faith は 70 未満にならない
export const ZEAL_RELEASE_V5 = 30, ZEAL_RELEASE_MONTHS = 12;

// (3) 棄教
export const APOST_V5 = 70, APOST_FAITH = 50, APOST_P = 0.05;
export const APOST_TO_GRUDGE = 0.40;      // V⑤ の40%を恨み[③]へ、残り60%は捨てる
export const APOST_DRIFT = -10, APOST_REP = -5;
// ★ 全消しにしない理由：⑤には減衰が無いので、棄教で全部消えると
//   **宗教が不満の完全な捨て場になる。**栓が抜けたら中身は③へ流れる。

export function resignP(grit) { return RESIGN_P * (1 - grit / RESIGN_GRIT_DIV); }
export function apostP(v5, piety) {
  return APOST_P * (v5 - APOST_V5) / 30 * (1 - piety / 100);
}

// ---------------------------------------------------------------------------
// §8  好き嫌いへの反映（正典3-2「同じ信仰／違う信仰 ＋／−（団結・排他性で倍率）」）
// ---------------------------------------------------------------------------
// ★ 毎年（誕生月）、同じ村にいて**既に線がある相手**（しがらみの上位20本）についてだけ。
//   40年で最大 ±20。相性（25〜50）と同じ桁になるので、**信仰が派閥の線に乗る。**
export const TIE_SAME = 0.5, TIE_DIFF = 0.5, TIE_TO_NONE = 0.25;
export const UNITY_DIV = 63;      // 団結＝(郷土愛N + 信心F)/2 → 中央63。50で割ると2割強く出る
export const EXCL_DIV = 60;       // 排他性＝誇り（F）→ 中央60

// ---------------------------------------------------------------------------
// §9-E  大きな災いが来たときの3分岐（正典 6770-6790）
// ---------------------------------------------------------------------------
// ★ 分岐3（族が起源と違う）＝「答えられない」。⑤が**全額**③へ返る。
//   これが「⑤に逃がした不満は消えていない」の本体。
export const HIT_FAITH = 5, HIT_SHARE = 3, HIT_DEEP = 10, HIT_RATE_MUL = 1.5;
export const HIT_DIVERT_BONUS = 1.25, HIT_DIVERT_MONTHS = 12;
export const PART_RETURN = 0.30, PART_FAITH = -8, PART_HARD = 60;
export const PART_HUNT = 10, PART_SPLIT_MUL = 3;
export const MISS_FAITH = -15, MISS_DEEP = -15, MISS_QUIT_MUL = 3;
export const MISS_FULL_RATE = 0.20;
export const BRANCH_HIT = 1, BRANCH_PARTIAL = 2, BRANCH_MISS = 3;

/**
 * 9-E の分岐を1つ決める。★ 乱数を引かない。
 * @returns {{branch, ret}} ret ＝ 返還率 T（⑤ から ③ へ返す割合）
 */
export function calamityBranch(kin, origin, rate, lastRate, event, systemized, piety) {
  if (kin === origin) {
    if (rate <= lastRate * HIT_RATE_MUL) return { branch: BRANCH_HIT, ret: 0 };      // 教義が的中した
    return { branch: BRANCH_PARTIAL, ret: PART_RETURN };                             // 部分的な失効
  }
  // 分岐3：族 != origin（族6『内』は常にここ）── 答えられない
  if (event || rate >= MISS_FULL_RATE) return { branch: BRANCH_MISS, ret: 1.0 };     // 全額
  const t = (100 - (systemized + piety) / 4) / 100;
  return { branch: BRANCH_MISS, ret: t < 0.30 ? 0.30 : t > 0.90 ? 0.90 : t };
}

// ---------------------------------------------------------------------------
// 月次 ── faith・⑤の出口・伝播 をこの順で1周する
// ---------------------------------------------------------------------------
import * as DIS from './discontent.js';
import { T_FAITH as TIE_FAITH } from './ties.js';   // 線の種類3（信仰・宗派）。門の T_f とは別物

const ID_GRIT2 = S.needId('図太さ');

/**
 * 信仰の月次。★ 乱数は宗教のストリーム（8番）だけを引く。
 * ★ 掟：12歳以上の生存者ひとりにつき、引く回数を**常に一定**にする。
 *   出口4つ（諦観・狂信・棄教・自然解除）＝ 4回。伝播は「候補の宗派の数」だけ。
 * @param chiefSect 祭祀局長の宗派（まだ局が無いので 0）
 */
export function beliefMonth(P, V, sects, ties, tick, rng, chiefSect = SECT_NONE) {
  const A = P.a, SA = sects.a, nv = V.a.len, mon = (tick / 30) | 0;
  const st = { zealots: 0, resigned: 0, apostates: 0, converted: 0, joined: 0 };

  // ---- 村ごとの宗派の頭数（同宗派率・誘い手の分母に要る）----
  const pop12 = new Int32Array(nv);
  const bySect = new Map();                        // `${v},${s}` → 人数
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < FOUND_AGE) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    pop12[v]++;
    const s = A.sect[i];
    if (s) bySect.set(`${v},${s}`, (bySect.get(`${v},${s}`) ?? 0) + 1);
  }

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < FOUND_AGE) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    const s = A.sect[i];
    const piety = A.gene[ID_PIETY][i] + A.ev[ID_PIETY][i];
    const v5 = A.dis[DIS.D_GOD][i];

    // ---- §4 faith の月次。★飽和させる ----
    if (s && SA.alive[s]) {
      const same = (bySect.get(`${v},${s}`) ?? 0) / Math.max(1, pop12[v]);
      const { inflow, outflow } = faithFlow(
        piety, same, sects.ax(s, '伝播の速さ'), sects.ax(s, '儀礼の頻度'), v5);
      let f = faithStep1(A.faith[i], inflow, outflow);
      if (A.mode[i] === MODE_ZEALOT && f < ZEAL_FAITH_FLOOR) f = ZEAL_FAITH_FLOOR;
      A.faith[i] = f < 0 ? 0 : f > 100 ? 100 : f;
      if (A.sectMon[i] < 65535) A.sectMon[i]++;
    }

    // ---- §7 ⑤の出口。★ 4つとも先に引いてから、当たった最初の1つだけ実行 ----
    const rRes = rng.next(), rZeal = rng.next(), rApo = rng.next(), rFree = rng.next();
    let done = false;

    // (1) 諦観 ── 無条件の出口。★ sect は問わない（無信仰でも諦観する）
    if (v5 >= RESIGN_V5 && A.mode[i] !== MODE_ZEALOT && rRes < resignP(A.gene[ID_GRIT2][i] + A.ev[ID_GRIT2][i])) {
      if (A.mode[i] === MODE_RESIGNED) DIS.addDiscontent(P, i, DIS.D_SELF, RESIGN_SELF_AGAIN);
      A.mode[i] = MODE_RESIGNED;
      A.dis[DIS.D_GOD][i] = RESIGN_V5_AFTER;       // 下がるが消えない
      st.resigned++; done = true;
    }
    // (2) 狂信
    if (!done && s && SA.alive[s] && v5 >= ZEAL_V5 && A.faith[i] >= ZEAL_FAITH
        && piety >= ZEAL_PIETY && rZeal < ZEAL_P) {
      A.mode[i] = MODE_ZEALOT; A.faith[i] = 100;
      A.dis[DIS.D_GOD][i] = ZEAL_V5_AFTER;
      A.ev[ID_PIETY][i] = Math.min(PIETY_DRIFT_CAP, A.ev[ID_PIETY][i] + ZEAL_DRIFT);
      if (SA.hardBonus[s] < ZEAL_HARD_CAP) {
        SA.hardBonus[s] += ZEAL_HARD;
        sects.doctrine[s][AX.教義の硬さ] = Math.min(100, sects.doctrine[s][AX.教義の硬さ] + ZEAL_HARD);
      }
      st.zealots++; done = true;
    }
    // (3) 棄教。★ 条件「直近12ヶ月に起源と違う族の大きな災い」は #9-E 側で立てた印を使う
    if (!done && s && SA.alive[s] && A.mode[i] !== MODE_ZEALOT
        && v5 >= APOST_V5 && A.faith[i] < APOST_FAITH
        && rApo < apostP(v5, piety)) {
      // ★ V⑤ の40%を恨み[③]へ移し、残り60%は捨てる。全消しにすると宗教が完全な捨て場になる
      DIS.addGrudge(P, i, DIS.D_RULE, v5 * APOST_TO_GRUDGE);
      A.dis[DIS.D_GOD][i] = 0;
      A.sect[i] = SECT_NONE; A.faith[i] = 0; A.mode[i] = MODE_LAY; A.sectMon[i] = 0;
      A.ev[ID_PIETY][i] = Math.max(-PIETY_DRIFT_CAP, A.ev[ID_PIETY][i] + APOST_DRIFT);
      A.rep[i] = Math.max(-100, A.rep[i] + APOST_REP);
      st.apostates++; done = true;
    }
    // (4) 諦観の自然解除
    if (!done && A.mode[i] === MODE_RESIGNED && rFree < RESIGN_FREE) A.mode[i] = MODE_LAY;
    // 諦観のあいだ、毎月 不満④ +0.5（緩慢な沈下）
    if (A.mode[i] === MODE_RESIGNED) DIS.addDiscontent(P, i, DIS.D_SELF, RESIGN_SELF_MONTH);
  }

  // ---- §6 伝播（入信・改宗）----
  //   ★ 狂信は動かない。sectMon<12 のあいだは改宗の判定を回さない
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < FOUND_AGE) continue;
    if (A.mode[i] === MODE_ZEALOT) continue;
    const v = A.village[i];
    if (v === NO_VILLAGE || v >= nv) continue;
    const cur = A.sect[i];
    if (cur && A.sectMon[i] < SECTMON_LOCK) continue;
    const credulity = A.gene[ID_CREDULITY][i] + A.ev[ID_CREDULITY][i];
    const grit = A.gene[ID_GRIT][i] + A.ev[ID_GRIT][i];
    let bestS = 0, bestInvite = -1;
    for (let s = 1; s < SA.len; s++) {
      if (!SA.alive[s] || s === cur) continue;
      if (!(bySect.get(`${v},${s}`) > 0)) continue;
      // 誘い手：同じ村の s の信徒（faith ≥ 35）のうち、i への好き嫌い[→i] が 55 以上 の人数
      let invite = 0;
      for (let j = 0; j < A.len; j++) {
        if (!A.alive[j] || A.village[j] !== v || A.sect[j] !== s) continue;
        if (A.faith[j] < INVITE_FAITH) continue;
        if (ties.feel(P, j, i) >= INVITE_LIKE) invite++;
      }
      const r = rng.next();                       // ★ 候補の宗派ごとに必ず1回引く
      if (!invite) continue;                      // 線の無い相手からは伝わらない
      const p = spreadP(credulity, invite / Math.max(1, pop12[v]),
        sects.ax(s, '伝播の速さ'), sects.ax(s, '排他性'), chiefSect === s, A.faith[i], grit);
      if (r < p && invite > bestInvite) { bestS = s; bestInvite = invite; }
    }
    if (!bestS) continue;
    if (cur) {
      A.faith[i] = CONVERT_FAITH; st.converted++;
      for (let j = 0; j < A.len; j++) {           // 旧宗派の信徒からの好き嫌いが本人へ −20
        if (A.alive[j] && A.village[j] === v && A.sect[j] === cur) ties.link(j, i, CONVERT_HATE, TIE_FAITH, mon);
      }
    } else { A.faith[i] = JOIN_FAITH; st.joined++; }
    A.sect[i] = bestS; A.mode[i] = MODE_LAY; A.sectMon[i] = 0;
    A.dis[DIS.D_GOD][i] *= V5_ON_JOIN;
  }
  return st;
}

/**
 * §8 好き嫌いへの反映。毎年（誕生月）、**既に線がある相手だけ**。
 * ★ 40年で最大 ±20。相性（25〜50）と同じ桁になるので、信仰が派閥の線に乗る。
 * ★ 乱数を引かない。
 */
export function beliefYear(P, sects, ties, tick = 0) {
  const A = P.a, TA = ties.a, mon = (tick / 30) | 0;
  let touched = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || (A.ageMonths[i] / 12 | 0) < FOUND_AGE) continue;
    const s = A.sect[i];
    for (let k = 0; k < 20; k++) {
      const j = TA.to[k][i];
      if (j < 0 || !A.alive[j] || A.village[j] !== A.village[i]) continue;
      const t = A.sect[j];
      let d = 0;
      if (s && t && s === t) d = TIE_SAME * (sects.ax(s, '団結') / UNITY_DIV);
      else if (s && t) d = -TIE_DIFF * (sects.ax(s, '排他性') / EXCL_DIV);
      else if (s && !t) d = -TIE_TO_NONE * (sects.ax(s, '排他性') / EXCL_DIV);
      if (d) { ties.link(i, j, d, TIE_FAITH, mon); touched++; }
    }
  }
  return touched;
}
