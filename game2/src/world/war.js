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
import { DEATH_WAR, NO_VILLAGE } from './people.js';
import { PART_ARM, PART_LEG, healMonths } from './condition.js';
import * as REP from './reputation.js';

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

// 部隊の規模。旧 battle.js の makeGhost がそのまま持っている数字：
//   フェーズ1の相手は「隣の村」であって国ではない → FIRST_WAR_SIZE(5)＋0〜3
//   それ以降 → 12 + 0〜27 ＝ **12〜40**
export const FORCE_MIN = 12, FORCE_MAX = 40;
export const LEVY_SHARE = 0.30;       // 兵に出せるのは働き盛りの何割か
export const LEVY_MIN_AGE = 16, LEVY_MAX_AGE = 50;

// 戦果の代金（正典3-2 の評判表そのまま。1点も足さない）
export const REP_WIN = REP.REP_EVENT.戦の手柄;    // +15
export const REP_FLED = REP.REP_EVENT.戦で逃げた;  // −20

/**
 * 戦を1つ解いて、世界へ結果を書き戻す。★ 乱数は戦闘のストリーム（10番）だけ。
 * @returns {{fought, dead, kills, fled, won, byStat, byLuck}}
 */
export function warMonth(P, pop, tick, rng, onFamilyDeath) {
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
  const n = Math.min(FORCE_MAX, Math.max(FORCE_MIN, Math.floor(levy.length * LEVY_SHARE)));
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
      P.kill(i, tick, DEATH_WAR); deadList.push(i);
      if (onFamilyDeath) onFamilyDeath(i);
      continue;
    }
    if (u.fled) {
      // ★ 逃げた個体は生き延びるが**戦功が付かない**（社会的コスト）
      fled++;
      if (A.routed[i] < 255) A.routed[i]++;
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
