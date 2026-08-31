// 戦争（O-27）。**乱数は戦闘のストリーム（10番）だけを引く。**
//
// ★ 正典 391 が旧 `sim/battle.js` を「**設計の看板**」と名指ししている：
//     「**団結が折れる崩壊**、逃走の頻度依存カスケード」
//   骨格はそこから移す（docs/v3/実装の順番.md「旧 battle.js 805行から骨格を移す」）。
//   数字（流れ矢10% / 傷病40% / 40ラウンド）も旧実装のものをそのまま使う ＝ 発明しない。
//
// ★ **勝敗は殲滅ではなく団結の崩壊。先に折れたほうが敗走する。**
//   逃走が増えるほど部隊全体が斬られやすくなる（exposure）。
//   少数の逃走は個人にとって得だが、多数になると敗走カスケードで全滅する ＝ 頻度依存（正典 575）。
//
// ★ **戦死はステ由来90% / 完全ランダム10%（流れ矢）。**
//   これが「ステ依存の確率数学だが、わんちゃん一発逆転もある」の本体。
//   誰がどちらで死んだかを残さないと 90/10 が検証できないので、死因の内訳を数える。
//
// ★ **逃げた個体は生き延びるが戦功が付かない**（社会的コスト）。
//   だから「逃げる」は常に得ではない ── 叙爵の道が閉じる。

import * as S from '../core/stats.js';
import { DEATH_WAR, NO_VILLAGE, SEX_FEMALE, SEX_MALE, lifespanOf} from './people.js';
import { PART_ARM, PART_LEG, healMonths } from './condition.js';
import * as REP from './reputation.js';
import { foundGenome } from './genetics.js';
import { MODE_LAY, RANK_COMMON } from './people.js';

// ---- 旧 battle.js の定数（1つも作っていない）--------------------------------
export const LUCK_SHARE = 0.10;    // 戦死のうち完全ランダム（流れ矢）の割合
export const WOUND_SHARE = 0.40;   // 致命打のうち傷病で済む割合
export const MAX_ROUNDS = 40;
export const FIRST_WAR_SIZE = 5;   // 最初の戦（フェーズ1の「隣の村」）の規模

// 逃走の頻度依存。逃げる者が増えるほど部隊が斬られやすくなる
export const EXPOSURE_FLED = 1.6;
export const COH_DROP_DEAD = 1.25, COH_DROP_FLED = 1.85, COH_DROP_BASE = 0.018;
export const COH_GAIN_LEAD = 0.07;
export const FEAR_BASE = 0.12, FEAR_HURT = 0.35, FEAR_LOSS = 0.35, FEAR_SCALE = 0.45, FEAR_MAX = 0.55;

const ID = {};
for (const n of ['最大筋力', '瞬発力', 'リーチ', '打たれ強さ', '体幹', '持久力',
                 '手先の器用さ', '反射', '敏捷', '度胸', '気分の振れ幅', '保身',
                 '誇り', '人をまとめる素質', '郷土愛']) ID[n] = S.needId(n);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

/**
 * 戦の能力を 106ステから読む。★ 旧 battle.js の式の**形をそのまま保ち**、
 *   小さな遺伝子セット（0〜1）を 実効値/100 に置き換えただけ。
 * ★ 正典「**戦の技はスキルであってステではない**」（O-27）。
 *   スキルの器はまだ無いので `skill = 0` で通す。入った日にここへ足す。
 */
export function combatOf(P, i) {
  const e = (n) => P.effective(i, ID[n]) / 100;
  const 攻撃 = (e('最大筋力') + e('瞬発力') + e('リーチ')) / 3;
  const 頑健 = (e('打たれ強さ') + e('体幹') + e('持久力')) / 3;
  const 器用 = (e('手先の器用さ') + e('反射') + e('敏捷')) / 3;
  const 胆力 = e('度胸'), 感受性 = e('気分の振れ幅'), 保身 = e('保身'), 誇り = e('誇り');
  const skill = 0;                                   // ★ 戦技スキルの器はまだ無い
  const atk = (0.15 + 攻撃) * 1.0;
  const def = (0.30 + 0.55 * 頑健) * (0.75 + 0.25 * skill);
  const hp = 18 + 55 * 頑健 + 22 * skill;
  const acc = clamp(0.45 + 0.45 * 器用, 0.2, 0.95);
  const crit = clamp(0.04 + 0.16 * 器用, 0.02, 0.28);
  // 恐怖耐性は練度が本命。素質（胆力）だけでは足りない
  const nerve = clamp01(0.6 * skill + 0.4 * 胆力);
  // 逃走率：感受性で振れ幅、保身で方向、誇りが引き留める
  const flee = clamp01((1 - nerve) * (0.45 + 0.55 * 感受性) * (0.55 + 0.75 * 保身) * (1 - 0.35 * 誇り));
  const lead = e('人をまとめる素質');
  const bond = clamp01(0.35 + 0.5 * e('郷土愛'));
  return { atk, def, hp, acc, crit, nerve, flee, lead, bond };
}

// ---------------------------------------------------------------------------
// 部隊
// ---------------------------------------------------------------------------
function unit(id, stats, side) {
  return { id, side, stats, hp: stats.hp, maxHp: stats.hp,
           dead: false, fled: false, wounded: false, kills: 0, byLuck: false };
}

function side(key, units) {
  let c = 0; for (const u of units) c += u.stats.bond;
  const c0 = Math.max(0.5, c / Math.max(1, units.length) * units.length * 0.5);
  return { key, units, start: units.length, cohesion: c0, c0, deadThis: 0, fledThis: 0, exposure: 1 };
}

/**
 * ゴースト（対戦相手）。★ **同じ確率分布から引く。**
 *   旧 battle.js の makeGhost と同じ趣旨：相手も「その国で生き延びた者」なので、
 *   こちらの働き手の能力分布から引き直す（無淘汰の新規生成にすると相手が弱すぎる）。
 * @param sample こちら側の combatOf の配列。ここから引き直す
 */
export function makeGhost(sample, n, rng) {
  const units = [];
  for (let k = 0; k < n; k++) {
    const src = sample[Math.floor(rng.next() * sample.length)] ?? sample[0];
    // ±15% の揺らぎ。相手の国も別の育ち方をしている
    const j = 0.85 + 0.30 * rng.next();
    const st = { ...src, atk: src.atk * j, def: src.def * j, hp: src.hp * j };
    units.push(unit(-1 - k, st, 'away'));
  }
  return side('away', units);
}

const active = (s) => s.units.filter((u) => !u.dead && !u.fled);
const fledRatio = (s) => (s.start ? s.units.filter((u) => u.fled).length / s.start : 0);

// ---------------------------------------------------------------------------
/**
 * 1ラウンド。★ 旧 battle.js の stepBattle をそのまま移した。
 * @returns 'home' | 'away' | null（まだ続く）
 */
export function stepBattle(b, rng) {
  b.round++;
  const { home, away } = b;
  home.deadThis = 0; home.fledThis = 0; away.deadThis = 0; away.fledThis = 0;
  const A = active(home), B = active(away);
  if (!A.length || !B.length) return !A.length ? 'away' : 'home';

  // 逃走が増えるほど部隊全体が斬られやすくなる（頻度依存の本体）
  home.exposure = 1 + fledRatio(home) * EXPOSURE_FLED;
  away.exposure = 1 + fledRatio(away) * EXPOSURE_FLED;

  // ---- 攻撃 ----
  for (const [attackers, defenders, defSide] of [[A, B, away], [B, A, home]]) {
    for (const u of attackers) {
      if (u.dead || u.fled) continue;
      const live = defenders.filter((d) => !d.dead && !d.fled);
      if (!live.length) continue;
      const t = live[Math.floor(rng.next() * live.length)];
      // ★ 掟：分岐で回数を変えない。命中・会心を先に2回引く
      const rAcc = rng.next(), rCrit = rng.next();
      if (rAcc > u.stats.acc) continue;
      const crit = rCrit < u.stats.crit ? 1.8 : 1;
      t.hp -= 12 * u.stats.atk * crit / (0.55 + t.stats.def) * defSide.exposure;
      if (t.hp <= 0 && !t.dead) {
        down(b, t, u, rng);
        // 流れ矢：戦死のうち約10%はステと無関係な完全ランダム抽選
        if (!t.wounded && rng.next() < LUCK_SHARE / (1 - LUCK_SHARE)) {
          const vs = defSide.units.filter((v) => !v.dead && !v.fled && v !== t);
          if (vs.length) {
            const v = vs[Math.floor(rng.next() * vs.length)];
            v.hp = 0; down(b, v, null, rng, true);
          }
        }
      }
    }
  }

  // ---- 恐怖と逃走 ----
  for (const s of [home, away]) {
    const base = FEAR_BASE + clamp(1 - s.cohesion / s.c0, 0, 1.4);
    const loss = s.start ? s.units.filter((u) => u.dead).length / s.start : 0;
    for (const u of s.units) {
      if (u.dead || u.fled) continue;
      const hurt = u.hp / u.maxHp < 0.42 ? FEAR_HURT : 0;
      const p = clamp(u.stats.flee * (base + hurt + loss * FEAR_LOSS) * FEAR_SCALE, 0, FEAR_MAX);
      if (rng.next() < p) { u.fled = true; s.fledThis++; }
    }
  }

  // ---- 団結 ----
  for (const s of [home, away]) {
    const n0 = Math.max(1, s.start);
    const cmd = active(s).sort((a, c) => c.stats.lead - a.stats.lead)[0];
    const gain = cmd ? COH_GAIN_LEAD * cmd.stats.lead : 0;
    const drop = (s.deadThis / n0) * COH_DROP_DEAD + (s.fledThis / n0) * COH_DROP_FLED + COH_DROP_BASE;
    s.cohesion = clamp(s.cohesion - drop + gain, -1, s.c0 * 1.15);
  }

  // ---- 崩壊判定：先に折れたほうが敗走する ----
  const hb = home.cohesion <= 0 || !active(home).length;
  const ab = away.cohesion <= 0 || !active(away).length;
  if (hb && ab) return home.cohesion >= away.cohesion ? 'home' : 'away';
  if (hb) return 'away';
  if (ab) return 'home';
  if (b.round >= MAX_ROUNDS) return home.cohesion >= away.cohesion ? 'home' : 'away';
  return null;
}

function down(b, t, killer, rng, luck = false) {
  const s = t.side === 'home' ? b.home : b.away;
  if (!luck && rng.next() < WOUND_SHARE) {
    t.wounded = true; t.hp = t.maxHp * 0.25;
    return;
  }
  t.dead = true; t.byLuck = luck; s.deadThis++;
  if (killer) killer.kills++;
  b.deaths[luck ? 'luck' : 'stat']++;
}

/** 戦を最後まで解く。★ 乱数は戦闘のストリームだけ */
export function runBattle(home, away, rng) {
  const b = { home, away, round: 0, deaths: { stat: 0, luck: 0 } };
  let winner = null;
  while (!(winner = stepBattle(b, rng))) { /* ラウンドを回す */ }
  b.winner = winner;
  b.loser = winner === 'home' ? 'away' : 'home';
  return b;
}

// ---------------------------------------------------------------------------
// 徴兵と戦果の反映
// ---------------------------------------------------------------------------
//
// ★★ B-34：**ヘッドレスの開戦の頻度が正典に無い。**
//   正典3155「**敵からの宣戦は来る**」／2993「国力差 ±20% 以内なら受ける／
//   格上からの宣戦は常に受ける」とは書いてあるが、**何年に1回来るかがどこにも無い。**
//   → 厄災の並びに合わせて置いた。嵐24年・疫病20年・火災30年・厳冬43年・凶作6年 の中で、
//     **戦は「働き盛りの40年に1〜2回」＝ 24年に1回**（嵐と同じ位置）を既定にする。
//     新しい数字を作らず、正典が「その位置」と決めた頻度を借りている。
export const WAR_PER_YEAR = 1 / 24;

// ★★ **戦が来る線 ＝ 人口100（フェーズ3「国」の入口）。**
//   正典 10-3 の表：フェーズ1 村 8→10 ／ フェーズ2 **部族** 10→100 ／ フェーズ3 **国** 100→1,000。
//   正典4-6「**相手選びは国力だけ**」。部族には国力でマッチングする相手がいない。
//   正典3626「人口900未満では公爵が0人なので**局が座れない**」＝ 軍務局も座らない。
//   正典601「局長が全部決める」／2107「戦争は局長が宣戦布告する」＝ 局が無ければ戦は起きない。
//
//   ★ **これを外すと国が滅ぶ。**実測：人口20から戦を来させると、
//     400年の人口が **1,724 → 38**（種29）／**2,677 → 275**（種3）。
//     46人の戦死が45倍の差を作るのは、戦が**16〜50歳＝産む側と作る側だけ**を抜くから。
//     指数成長の初期に繰り返し抜くと、複利がまるごと消える。
//     9-B の導入の嵐を「死者ゼロ」に固定したのと同じ理由（正典6705）。
export const WAR_MIN_POP = 100;

// 部隊の規模。
// ★★ 2026-08-31：**上限40 を外した。**★★
//   40 は旧 battle.js の makeGhost（フェーズ1の相手が「隣の村」だった頃）の数字で、
//   **世界が育っても兵は40人までだった。**人口6,000の世界の徴兵対象は約2,000人なので、
//   **1人が戦に出る確率が 40/2000 ＝ 2%**。16〜50歳の34年で参戦の期待値は
//   1/24年 × 34年 × 2% ＝ **0.028回**。正典3719「**戦功3回で rank1**」に
//   構造的に永久に届かず、騎士→局長→祭祀局長→異端審問会 の鎖が全部詰まっていた
//   （実測：400年で戦11回・討取38・討取3回に届いた者1人／異端狩り 40種300年で0件）。
//   → 正典が言っているのは「**出せるのは働き盛りの◯割まで**」だけ。**割合で決める。**
//   ★ 下限12（兵が12人に満たない世界では戦にならない）は残す。
export const FORCE_MIN = 12;
export const LEVY_SHARE = 0.30;       // 兵に出せるのは働き盛りの何割か（既定。カードで動く）
export const LEVY_MIN_AGE = 16, LEVY_MAX_AGE = 50;

// 戦果の代金（正典3-2 の評判表そのまま。1点も足さない）
export const REP_WIN = REP.REP_EVENT.戦の手柄;    // +15
export const REP_FLED = REP.REP_EVENT.戦で逃げた;  // −20

/**
 * 戦を1つ解いて、世界へ結果を書き戻す。★ 乱数は戦闘のストリーム（10番）だけ。
 * @returns {{fought, dead, kills, fled, won, byStat, byLuck}}
 */
export function warMonth(P, pop, tick, rng, onFamilyDeath, levyShare = 0) {
  const A = P.a;
  // ---- 掟：開戦の抽選は毎月必ず1回引く ----
  const r = rng.next();
  const levy = [];
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const y = (A.ageMonths[i] / 12) | 0;
    if (y < LEVY_MIN_AGE || y > LEVY_MAX_AGE) continue;
    if (A.village[i] === NO_VILLAGE) continue;
    levy.push(i);
  }
  if (r >= WAR_PER_YEAR / 12 || pop < WAR_MIN_POP || levy.length < FORCE_MIN) {
    return { fought: 0, dead: 0, deadList: [], kills: 0, fled: 0, won: 0, byStat: 0, byLuck: 0 };
  }

  // ---- 徴兵。★ 出せるのは働き盛りの3割まで。部隊は 12〜40（旧 battle.js の規模）
  // ★ 徴兵率は #18 §1 のカード（軍務局・既定0.20・0〜0.40）。読まずに 0.30 を焼き込んでいた
  const share = levyShare > 0 ? levyShare : LEVY_SHARE;
  const n = Math.max(FORCE_MIN, Math.floor(levy.length * share));
  if (levy.length < n) return { fought: 0, dead: 0, deadList: [], kills: 0, fled: 0, won: 0, byStat: 0, byLuck: 0 };
  // ★★ **籤で引く。**添字の順にすると「いつも同じ最年長者だけが戦に出る」ことになり、
  //   戦果＝叙爵の道が一部の者に固定される。誰が引かれるかは運、
  //   引かれてからどうなるかはステ ── オーナー裁定「ステ依存の確率数学のはずなので
  //   **わんちゃん一発逆転**もあると思う」がここで形になる。
  //   （誰を出すかは本来 軍務局＝オーナーの動詞。空席のあいだの既定として籤を置く）
  for (let k = levy.length - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1));
    const t = levy[k]; levy[k] = levy[j]; levy[j] = t;
  }
  const force = levy.slice(0, n);
  force.sort((a, b) => a - b);           // ★ 以後の走査を決定的にする
  const stats = force.map((i) => combatOf(P, i));
  const home = side('home', force.map((i, k) => unit(i, stats[k], 'home')));
  const away = makeGhost(stats, n, rng);

  const b = runBattle(home, away, rng);
  const won = b.winner === 'home';

  let kills = 0, fled = 0;
  const deadList = [];
  for (const u of home.units) {
    const i = u.id;
    if (A.battles[i] < 255) A.battles[i]++;
    if (u.dead) {
      // ★ 2026-08-31：**戦死した者の討取を世界の台帳に入れる。**
      //   本人はもう叙爵されないので `A.kills` には積まないが、
      //   数えないと「戦死819・討取128」のように**敵の死者が消える**
      kills += u.kills;
      P.kill(i, tick, DEATH_WAR); deadList.push(i);
      if (onFamilyDeath) onFamilyDeath(i);
      continue;
    }
    if (u.fled) {
      // ★★ 2026-08-31：**討ち取りは事実として残す。名誉だけを取り上げる。**★★
      //   旧実装は逃げた者の `u.kills` を丸ごと捨てていた。だが実測で
      //   **兵の64%が逃げる**（16戦・1,760人中1,129人。逃走の機構そのものは
      //   旧 battle.js からの移植で正しい）ので、討取374 のうち**集計に残るのが169**
      //   ＝ 正典3719「戦功3回で rank1」に届く者が構造的に出ない。
      //   オーナー裁定 B-33「**目に見えてわかる戦果**」に照らすと、
      //   討ち取りは**事実**、評判は**名誉**。逃げた者も討ち取った事実は消えない。
      //   → `kills` は積む。**評判 +15 は付けない**（名誉は取り上げる）うえに **−20**。
      fled++;
      if (A.routed[i] < 255) A.routed[i]++;
      if (u.kills > 0) { A.kills[i] = Math.min(65535, A.kills[i] + u.kills); kills += u.kills; }
      REP.award(P, i, REP_FLED);                       // 評判 −20
      continue;
    }
    if (u.wounded && !A.hurtStage[i]) {
      A.hurtStage[i] = 2; A.hurtPart[i] = PART_ARM; A.hurtHeal[i] = healMonths(P, i, 2);
    }
    if (u.kills > 0) {
      A.kills[i] = Math.min(65535, A.kills[i] + u.kills);
      kills += u.kills;
      REP.award(P, i, REP_WIN);                        // 評判 +15（戦の手柄）
    }
  }
  return { fought: 1, dead: deadList.length, deadList, kills, fled, won: won ? 1 : 0,
           byStat: b.deaths.stat, byLuck: b.deaths.luck };
}

// ---------------------------------------------------------------------------
// 捕虜（正典 4-5・4-6・#8 §9・#7）
// ---------------------------------------------------------------------------
//
// ★ **外から血は入らない。入るのは捕虜だけ**（正典658）。
//   「世界に共存する血統は**戦争でしか増えない**（開拓も移住も血を増やさない）」（正典1405）。
//   だから敵国は**自国の分布から作ってはいけない** ── それでは血が増えない。
//   旧 battle.js の makeGhost が「国ごとに遺伝子の狙いを振る＝国の性格」と書いているとおり、
//   **戦ごとに別の狙い（targets）を引いて、そこから捕虜の遺伝子を作る。**
//
// ★ **戦利品は捕虜と物。土地は動かない**（正典519）。終戦の処理は「捕虜にするか誅殺するか」。
//   **送還は無い。**国境で選別するのは無料、帰化させてから殺すと粛清（正典 4-5）。
//
// ★ 捕虜は**農奴にしない。**rank=1（平民）から始める（正典1852）。
//   評判 R ← 0（正典4-4「②③④はゼロから始まる」）。つながりの網に繋がっていない。
//
// ★ 「**入れた世代は異物、その子は自国民**」が構造から出る ──
//   本人は異国の宗派（d=40 固定・#7 の最優先の異端候補）のまま同化しないが、
//   子は7歳の継承規則で自国の宗派に入りうる。

export const CAPTIVE_SHARE = 0.5;      // 敗走した側の生き残りのうち捕虜にできる割合
export const CAPTIVE_FAITH = 40;       // 帰化した月の faith（段2）
export const FOREIGN_SPREAD = 0.22;    // 敵国の遺伝のばらつき（自国の創世と同じ桁）
export const FOREIGN_TARGET_LO = 0.20, FOREIGN_TARGET_HI = 0.80;   // 国ごとの狙いの幅

// 帰化の拒否（正典3-6「信仰で安定を買うと、血が腐る」の数値化）
export const REFUSE_BASE = 50, REFUSE_DIV = 55, REFUSE_CAP = 0.9;
export const REFUSE_INQ_MUL = 1.5;     // 異端審問会が在れば

/** 帰化の拒否率。★ 疫病から起きた宗教は排他性 +15 なので、疫病を経験した国ほど外の血を入れない */
export function refuseP(exclusive, hasInquisition) {
  const v = (exclusive - REFUSE_BASE) / REFUSE_DIV * (hasInquisition ? REFUSE_INQ_MUL : 1);
  return v < 0 ? 0 : v > REFUSE_CAP ? REFUSE_CAP : v;
}

/** 敵国の遺伝の狙いを1つ引く。★ 国ごとに性格が違う（同じ相手ばかりにならない） */
export function foreignTargets(rng, S_, SCALE = 100) {
  const t = new Float32Array(S_.COUNT);
  for (let s = 0; s < S_.COUNT; s++) {
    t[s] = (FOREIGN_TARGET_LO + (FOREIGN_TARGET_HI - FOREIGN_TARGET_LO) * rng.next()) * SCALE;
  }
  return t;
}

/**
 * 捕虜を取る（正典 4-5・4-6）。★ 乱数は戦闘のストリーム（10番）だけ。
 *
 * ★ **選べるのは「取る」か「殺す」の二択。送還は無い。**
 *   戦争終了時に実施するので国民への通達はなく、感情は動かない（正典 4-5）。
 *   一度国に入れたあとに殺すのは**粛清**で、いつも通りの恨みが返る。
 *
 * @param spawn (P) → 新しい添字を1つ確保して返す関数（世界側が持っている）
 * @param villageOf () → 置き先の村（国境の村）。無ければ −1
 * @param exclusiveOf (v) → その村で信者が最も多い宗派の排他性。信者がいなければ 0
 * @param hasInq  異端審問会が在るか
 * @returns {{taken, refused}}
 */
export const CAPTIVE_AGE_MIN = 16, CAPTIVE_AGE_MAX = 40;   // 連れて来られる帯（産める・働ける）
export function takeCaptives(P, n, tick, rng, spawn, villageOf, exclusiveOf, hasInq, foreignSect) {
  const A = P.a;
  let taken = 0, refused = 0;
  // ★ 戦ごとに敵国の遺伝の狙いを1つ引く（国ごとに性格が違う）
  const targets = foreignTargets(rng, S, 100);
  for (let k = 0; k < n; k++) {
    const v = villageOf();
    // ★ 掟：分岐で回数を変えない。拒否の抽選は必ず引く
    const r = rng.next();
    // ★★ 2026-08-31（別セッションの精査で発見）：**捕虜が全員「生後0ヶ月の男児」だった**
    //   （男23／女0）。`sex`／`ageMonths`／`lifespan`／`blood` をどこにも書いていなかったので、
    //   spawn の既定値（0）のままだった。柱3「他の遊び手が新しい血の供給元」は
    //   **産める大人**が入って初めて成立する（M-35：捕虜が入ると劣性ホモ15.6%→11.8%）。
    //   ★ 掟どおり**当たらなくても必ず引く**ので、拒否の判定より前に置く
    const rSex = rng.next(), rAge = rng.next();
    if (v < 0) { refused++; continue; }
    // 帰化の拒否（受け入れ先の村で信者が最も多い宗派の排他性で決まる）
    if (r < refuseP(exclusiveOf(v), hasInq)) { refused++; continue; }   // 拒めば「殺す」しかない

    const i = spawn();
    if (i < 0) { refused++; continue; }
    foundGenome(P, i, rng, targets, FOREIGN_SPREAD * 100);
    A.village[i] = v;
    // ★ 男女は半々、年齢は 16〜40（産める・働ける帯）。連れて来られるのは戦のあとの村人なので
    //   兵の帯（16〜50の男）ではなく**男女の大人**。血の旗は「外から来た」を1本立てる
    A.sex[i] = rSex < 0.5 ? SEX_FEMALE : SEX_MALE;
    A.ageMonths[i] = Math.round((CAPTIVE_AGE_MIN + rAge * (CAPTIVE_AGE_MAX - CAPTIVE_AGE_MIN)) * 12);
    // ★ 生年も実年齢に合わせる。ここを書かないと `birthTick` が「連れて来られた日」の
    //   ままになり、子の年齢計算が壊れる（検査「出産は18〜40歳のあいだだけ」が
    //   2.75歳で産んだと出た）
    A.birthTick[i] = tick - A.ageMonths[i] * 30;
    A.lifespan[i] = lifespanOf(P, i);
    A.blood[i] = 0;                   // 創世の十匹の血は1本も持たない＝外から来た者の印
    A.rank[i] = RANK_COMMON;          // ★ 捕虜は農奴にしない（正典1852）
    A.rep[i] = 0;                     // ★ ②③④はゼロから始まる（正典4-4）
    A.sect[i] = foreignSect;          // 異国の宗派（自国に無い宗派は全部これ1つに畳む）
    A.faith[i] = CAPTIVE_FAITH; A.mode[i] = MODE_LAY; A.sectMon[i] = 0;
    taken++;
  }
  return { taken, refused };
}
