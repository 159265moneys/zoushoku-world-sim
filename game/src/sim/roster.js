// 10国のライバル・ロスター。
//
// プレイヤーの世界とまったく同じ createWorld / advanceGeneration で並行に走らせる。
// 作者が書いたCPUではなく「同じルールで実際に走った世界」であることが要件なので、
// ここでは特別扱いを一切しない（同じ遺伝・同じ戦闘・同じ怨恨・同じ具申）。
//
// 副次的に、これは設計主張の実測装置になる：
//   purist vs melting → 近親交配で腐るか／雑種強勢が効くか
//   terror            → 3世代後に謀反が返ってくるか
//   merit vs dynastic → 透過率が血統構造を変えるか
//   10国全部          → オーナーごとにクラスタへ分化するか

import { RNG } from '../core/rng.js';
import { GENE_NAMES } from '../core/genes.js';
import { PHASE } from '../core/model.js';
import { createWorld, advanceGeneration, recomputeAggregates } from './world.js';
import {
  PROFILE_IDS, PROFILES, makeRivalOwner, applyProfileToWorld, runRivalTurn,
  borderPolicy, wantsSurrender,
} from './rival.js';
import {
  startWar, stepBattle, runBattle, surrender, settleWar, applySideLosses, applyRout,
  takeCaptives, borderDecision, rankNation,
} from './battle.js';
import { citizenPower, clamp01 } from './derive.js';
import { kill } from './world.js';

const NATION_NAMES = {
  martial: 'アガルタ', agrarian: 'デメテル', fecund: 'ミレト', purist: 'スパルティ',
  melting: 'アレクサ', terror: 'アッシュル', laissez: 'ノーラ', pious: 'ヒエラ',
  merit: 'テクネ', dynastic: 'ハプス',
};

// 抜擢の基準に合わせて、捕虜を引く軸も変える
const AXIS_OF = {
  martial: '武', agrarian: '器用', fecund: '繁殖', purist: '総合', melting: '知',
  terror: '頑健', laissez: '総合', pious: '総合', merit: '知', dynastic: '統率',
};

export function createRoster(seed) {
  const base = (seed >>> 0) || 1;
  const nations = [];

  // 10国は「経営思想だけを変えた対照実験」である。
  // 国ごとに違う初期回答を与えていたときは、創始者2体のくじ運が
  // 思想の差を丸ごと呑み込んでいた（クラスタ内分散 > クラスタ間距離）。
  // 同じ元手を10人のオーナーに渡して、200世代後に何が違うかを見る形にする。
  // 創始者はロスター間でも共通にする。10国 × 10ロスターの全100世界が
  // 同じ2体から始まるので、200世代後の差はすべて「誰が統治したか」に帰属する。
  // ロスターの種は歴史（乱数列）の側だけを動かす。
  const answers = new Array(12).fill(0.5);
  const FOUND_SEED = 0x5eed1234;

  PROFILE_IDS.forEach((pid, i) => {
    const nseed = (base ^ (0x9e3779b9 * (i + 1))) >>> 0;
    const world = createWorld(nseed, answers, { foundSeed: FOUND_SEED });
    const owner = makeRivalOwner(pid);
    applyProfileToWorld(world, owner);
    world.originKey = pid;
    world.origins = new Map([[pid, { key: pid, name: NATION_NAMES[pid], hue: (i * 36) / 360 }]]);
    for (const p of world.people.values()) { p.origin = pid; p.lineage = { [pid]: 1 }; }
    nations.push({
      id: pid, name: NATION_NAMES[pid], profile: pid, label: PROFILES[pid].label,
      world, owner, seed: nseed, hue: (i * 36) / 360, wars: 0, wins: 0,
    });
  });
  return { seed: base, gen: 0, nations, wars: [], byId: new Map(nations.map((n) => [n.id, n])) };
}

export function advanceRoster(roster, rng, gens = 1) {
  const reports = [];
  for (let g = 0; g < gens; g++) {
    for (const n of roster.nations) {
      if (!n.world.people.size) continue;
      runRivalTurn(n.world, n.owner, rng);
      const { report } = advanceGeneration(n.world, rng);
      n.lastReport = report;
    }
    roster.gen++;
    // 戦争。フェーズ2に入った国どうしが、たまにぶつかる
    maybeWars(roster, rng);
    reports.push(snapshot(roster));
  }
  return reports;
}

function maybeWars(roster, rng) {
  // 小さすぎる国は戦争に出さない。人口8で戦をすると、勝っても負けても
  // 働き手が消えて次の世代が来ない（実測でロスターの絶滅の大半がこれだった）
  const ready = roster.nations.filter(
    (n) => n.world.people.size >= 25 && (roster.gen - (n.lastWar ?? -99)) >= 4
  );
  if (ready.length < 2) return;
  const nWars = 1 + rng.int(2);
  for (let i = 0; i < nWars; i++) {
    const a = ready[rng.int(ready.length)];
    const pool = ready.filter((x) => x !== a);
    if (!pool.length) break;
    const b = pool[rng.int(pool.length)];
    const appetite = (PROFILES[a.profile].warAppetite + PROFILES[b.profile].warAppetite) / 2;
    if (!rng.bool(clamp01(appetite))) continue;
    warBetween(roster, a, b, rng);
  }
}

/** 国と国をぶつける。両側の世界に損耗が書き戻され、両側が捕虜を引く。 */
export function warBetween(roster, a, b, rng) {
  const view = nationView(b);
  const battle = startWar(a.world, rng, view);
  battle.homeName = a.name;
  battle.opponentRuthless = PROFILES[b.profile].surrenderAt === 0;
  // away 側の個体は b の world の実体そのもの（参照）なので損耗がそのまま伝わる
  runBattleWithSurrender(battle, rng, a, b);

  applyRout(battle, rng);
  // home（a）側は通常の戦後処理、away（b）側は損耗だけ書き戻す
  settleWar(a.world, battle, rng);
  const bLoss = applySideLosses(b.world, battle, 'away', rng);
  b.world.lastWarGen = b.world.gen;

  // 捕虜：勝者は軸を1つ選んで上位プールから、敗者は全プールから
  const aCaps = takeCaptives(a.world, battle, AXIS_OF[a.profile], rng, 'home');
  const bCaps = takeCaptives(b.world, battle, AXIS_OF[b.profile], rng, 'away');
  transfer(a, b, aCaps, rng);
  transfer(b, a, bCaps, rng);

  a.wars++; b.wars++;
  a.lastWar = roster.gen; b.lastWar = roster.gen;
  const won = battle.outcome?.winner === 'home';
  if (won) a.wins++; else b.wins++;
  roster.wars.push({
    gen: roster.gen, a: a.id, b: b.id, winner: won ? a.id : b.id,
    kind: battle.outcome?.kind, rounds: battle.round,
    aDead: battle.summary?.dead ?? 0, bDead: bLoss.dead,
    aCaptives: aCaps.length, bCaptives: bCaps.length,
  });
  recomputeAggregates(a.world);
  recomputeAggregates(b.world);
  return battle;
}

function runBattleWithSurrender(battle, rng, a, b) {
  const pfA = PROFILES[a.profile];
  let guard = 60;
  while (!battle.over && guard-- > 0) {
    // 降伏はオーナー裁定。武断（surrenderAt=0）は絶対に折らない
    if (!battle.surrenderOffered && wantsSurrender(pfA, battle)) {
      surrender(battle);
      if (battle.over) break;
    }
    stepBattle(battle, rng);
  }
  if (!battle.outcome) runBattle(battle, rng);
}

/** 捕虜を移す。国境処理は受け入れ側のプロファイルが決める。 */
function transfer(taker, source, caps, rng) {
  const pf = PROFILES[taker.profile];
  for (const cap of caps) {
    // 捕らえられた個体は元の国から実際に消える（誅殺なら永久に、送還なら戻る）
    const src = source.world.people.get(cap.sourceId);
    const decision = borderPolicy(pf, cap, taker.world, rng);
    if (decision === 'return') {
      taker.world.border.delete(cap.id);
      borderDecision(taker.world, cap.id, 'return');
      continue; // 送還：相手の人口は減らない
    }
    if (src) kill(source.world, src, '捕縛', null);
    borderDecision(taker.world, cap.id, decision);
  }
}

/** 相手を「国」として見せるビュー。ゴーストと同じ形にする。 */
export function nationView(n) {
  const people = [...n.world.people.values()].filter((p) => p.age >= 2);
  rankNation(people);
  const strength = people.reduce((s, p) => s + citizenPower(p), 0);
  return {
    key: n.id, name: n.name, people, strength,
    deployTop: PROFILES[n.profile].deployTop,
    ruthless: PROFILES[n.profile].surrenderAt === 0,
    powerIndex: n.world.powerIndex,
  };
}

/** マッチング画面に見せてよいのは国力だけ。内訳は peek（開発用）でしか見えない。 */
export function listOpponents(roster) {
  return roster.nations
    .filter((n) => n.world.people.size > 0)
    .map((n) => ({
      id: n.id, name: n.name, profile: n.profile,
      power: n.world.powerIndex, hue: n.hue,
    }));
}

/** 開発用デバッグ。通常UIからは呼ばない。 */
export function peek(roster, id) {
  const n = roster.byId.get(id);
  return n ? n.world : null;
}

function snapshot(roster) {
  return roster.nations.map((n) => {
    const st = n.world.stats[n.world.stats.length - 1] || {};
    return {
      id: n.id, gen: n.world.gen, pop: n.world.people.size,
      power: n.world.powerIndex, morale: n.world.morale,
      homoz: st.homoz ?? 0, foreign: st.foreign ?? 0, grudge: st.grudge ?? 0,
      rebellions: n.world.rebellions, purged: n.owner.purged,
    };
  });
}

/** 分化の測定。テストのコーパスとして使う。 */
export function rosterReport(roster) {
  const rows = roster.nations.map((n) => {
    const w = n.world;
    const st = w.stats[w.stats.length - 1] || {};
    return {
      id: n.id, name: n.name, gen: w.gen, phase: w.phase,
      pop: w.people.size, power: w.powerIndex, morale: +w.morale.toFixed(3),
      food: +w.food.toFixed(1),
      homoz: +(st.homoz ?? 0).toFixed(3),
      foreign: +(st.foreign ?? 0).toFixed(3),
      grudge: +(st.grudge ?? 0).toFixed(3),
      rebellions: w.rebellions, purged: n.owner.purged,
      wars: n.wars, wins: n.wins,
      genes: st.genes || {},
    };
  });
  // 国間の遺伝子距離。平均に潰れていれば柱が1本折れている
  const dist = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      dist.push({ a: rows[i].id, b: rows[j].id, d: geneDistance(rows[i].genes, rows[j].genes) });
    }
  }
  dist.sort((x, y) => y.d - x.d);
  const meanDist = dist.length ? dist.reduce((s, x) => s + x.d, 0) / dist.length : 0;
  return { gen: roster.gen, rows, meanGeneDistance: +meanDist.toFixed(4), pairs: dist, wars: roster.wars };
}

function geneDistance(a, b) {
  let s = 0, n = 0;
  for (const g of GENE_NAMES) {
    if (a[g] == null || b[g] == null) continue;
    s += (a[g] - b[g]) ** 2; n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export { PHASE };
