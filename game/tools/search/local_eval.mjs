// local_eval.mjs — tools/eval.js が現れるまでの**代役の本物**。
//
// tools/eval.js は別担当が実装中なので触らない。ただし探索は本物の src/sim を
// 叩かないと意味がないので（Python側でゲームを再実装しない＝SEARCH.md の絶対規則）、
// 探索器の担当領域である tools/search/ の中に、同じ契約の評価器を置く。
// src/ test/ tools/eval.js は一切変更していない。import しかしていない。
//
// 契約（tools/SEARCH.md）：
//   stdin  {policies:[{id,cards,captiveAxis,border,promote,warAppetite}], seeds:[], gens, opponents:[]}
//   stdout {results:[{id,seed,opponent,power,pop,gens,extinct,wins,losses,
//                     admixture,morale,regimeGrudge,yieldRate}]}
//
// ---------------------------------------------------------------------------
// 何を「プレイヤーの一手」として渡しているか（ここが評価の前提そのもの）
// ---------------------------------------------------------------------------
// プレイヤーの世界は、ライバル10国とまったく同じ createWorld / runRivalTurn /
// advanceGeneration で走る。違うのはプロファイルの中身だけで、それを12枚の
// カードと4つの選択から組み立てる。特別扱いはしない（roster.js と同じ思想）。
//
//   src/sim が直接読むカード（7枚）
//     deploy_top spare_old raise_young guards  … battle.js の派遣選抜
//     drill hunt_ratio                          … world.js の配役
//     mix_policy                                … world.js が foreignBias を動かす
//
//   オーナー層に同じ意味の受け口があるカード（3枚）＝ライバル国と対称にするため接続
//     surrender_at → pf.surrenderAt   （UIの説明文が「不在時の応戦方針」＝まさに無人運転）
//     frontier     → pf.frontier      （rival が毎世代 setDistrict している比率そのもの）
//     hereditary   → pf.transparency = 1 - h/100（世襲⇔透過率。merit と dynastic の差）
//
//   受け口がどこにも無いカード（2枚）
//     stockpile ration_equal … src/sim にも PROFILES にも読み手がいない。**現状は無効**。
//     この2枚は探索でも必ず平坦に出る。それは設計が平坦なのではなく未接続だという意味。
//     （--wire=sim を渡すと上の3枚も切って、sim が読む7枚だけで測れる）
//
// 粛清は撃たない（プレイヤーの方針空間に粛清カードが無いため）。
import { RNG } from '../../src/core/rng.js';
import { PHASE } from '../../src/core/model.js';
import {
  createWorld, advanceGeneration, recomputeAggregates, setCard, kill,
} from '../../src/sim/index.js';
import {
  PROFILES, makeRivalOwner, applyProfileToWorld, runRivalTurn, borderPolicy, wantsSurrender,
} from '../../src/sim/rival.js';
import {
  startWar, stepBattle, runBattle, surrender, settleWar, applySideLosses, applyRout,
  takeCaptives, borderDecision, rankNation,
} from '../../src/sim/battle.js';
import { citizenPower, clamp01 } from '../../src/sim/derive.js';

const FOUND_SEED = 0x5eed1234;   // 創始者は固定。差はすべて「誰が統治したか」に帰属させる
const NEUTRAL_ANSWERS = new Array(12).fill(0.5);

// SEARCH.md の表記（ラベル）→ battle.js の CAPTIVE_AXES.key
const AXIS_KEY = {
  '総合': '総合', '武力': '武', '武': '武', '知性': '知', '知': '知',
  '統率': '統率', '繁殖性': '繁殖', '繁殖': '繁殖', '器用': '器用', '頑健': '頑健',
};

function playerProfile(policy, wire) {
  const c = policy.cards || {};
  const num = (k, d) => (Number.isFinite(+c[k]) ? +c[k] : d);
  const owner = wire !== 'sim';
  return {
    id: 'player', name: 'プレイヤー', label: '探索中の方針',
    // roleMix はカード（drill/hunt_ratio）が world.js 側で直接効くので使われない
    roleMix: { hunt: num('hunt_ratio', 30) / 100, drill: num('drill', 10) / 100 },
    frontier: owner ? num('frontier', 20) / 100 : 0.2,
    promote: policy.promote || 'merit',
    captive: policy.border || 'accept',
    // 粛清しない（方針空間に無い）
    purgeThreshold: 9, purgeRate: 0, purgeTrigger: 9,
    transparency: owner ? 1 - num('hereditary', 50) / 100 : 0.5,
    surrenderAt: owner ? num('surrender_at', 0) / 100 : 0,
    // mix_policy カードが world.js 側で foreignBias を動かすので 0 のまま触らない
    foreignBias: 0, inbreedGuard: 0.1, fertBias: 1,
    prefer: null,
    deployTop: num('deploy_top', 40) / 100,
    warAppetite: Number.isFinite(+policy.warAppetite) ? +policy.warAppetite : 0.5,
    cards: {
      deploy_top: num('deploy_top', 40), spare_old: num('spare_old', 7),
      raise_young: num('raise_young', 20), guards: num('guards', 0),
      drill: num('drill', 10), surrender_at: num('surrender_at', 0),
      hunt_ratio: num('hunt_ratio', 30), stockpile: num('stockpile', 15),
      frontier: num('frontier', 20), ration_equal: num('ration_equal', 50),
      hereditary: num('hereditary', 50), mix_policy: num('mix_policy', 50),
    },
  };
}

function makeNation(id, name, profile, seed, hue) {
  const world = createWorld(seed, NEUTRAL_ANSWERS, { foundSeed: FOUND_SEED });
  const owner = { profile, id: profile.id, purged: 0, appointed: 0, wars: 0 };
  applyProfileToWorld(world, owner);
  world.originKey = id;
  world.origins = new Map([[id, { key: id, name, hue }]]);
  for (const p of world.people.values()) { p.origin = id; p.lineage = { [id]: 1 }; }
  return { id, name, profile, world, owner, wars: 0, wins: 0, losses: 0, lastWar: -99 };
}

function nationView(n) {
  const people = [...n.world.people.values()].filter((p) => p.age >= 2);
  rankNation(people);
  const strength = people.reduce((s, p) => s + citizenPower(p), 0);
  return {
    key: n.id, name: n.name, people, strength,
    deployTop: n.profile.deployTop, ruthless: n.profile.surrenderAt === 0,
    powerIndex: n.world.powerIndex,
  };
}

// roster.js の warBetween と同じ手順。捕虜の軸だけ方針から取る。
function warBetween(a, b, rng, gen, axisA, axisB) {
  const battle = startWar(a.world, rng, nationView(b));
  battle.homeName = a.name;
  battle.opponentRuthless = b.profile.surrenderAt === 0;
  let guard = 60;
  while (!battle.over && guard-- > 0) {
    if (!battle.surrenderOffered && wantsSurrender(a.profile, battle)) {
      surrender(battle);
      if (battle.over) break;
    }
    stepBattle(battle, rng);
  }
  if (!battle.outcome) runBattle(battle, rng);
  applyRout(battle, rng);
  settleWar(a.world, battle, rng);
  applySideLosses(b.world, battle, 'away', rng);
  b.world.lastWarGen = b.world.gen;

  const aCaps = takeCaptives(a.world, battle, axisA, rng, 'home');
  const bCaps = takeCaptives(b.world, battle, axisB, rng, 'away');
  transfer(a, b, aCaps, rng);
  transfer(b, a, bCaps, rng);

  a.wars++; b.wars++; a.lastWar = gen; b.lastWar = gen;
  const won = battle.outcome?.winner === 'home';
  if (won) { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  recomputeAggregates(a.world);
  recomputeAggregates(b.world);
}

function transfer(taker, source, caps, rng) {
  for (const cap of caps) {
    const src = source.world.people.get(cap.sourceId);
    const decision = borderPolicy(taker.profile, cap, taker.world, rng);
    if (decision === 'return') {
      taker.world.border.delete(cap.id);
      borderDecision(taker.world, cap.id, 'return');
      continue;
    }
    if (src) kill(source.world, src, '捕縛', null);
    borderDecision(taker.world, cap.id, decision);
  }
}

/** 1本の対戦（方針 × 種 × 相手）。プレイヤー国と相手国を並走させて戦わせる。 */
export function runOne(policy, seed, opponentId, gens, wire) {
  const base = (seed >>> 0) || 1;
  const rng = new RNG((base ^ 0x2f6a88c5) >>> 0);
  const pf = playerProfile(policy, wire);
  const opf = PROFILES[opponentId] || PROFILES.laissez;

  const me = makeNation('home', '自国', pf, (base ^ 0x9e3779b9) >>> 0, 0.1);
  const foe = makeNation(opponentId, opf.name, opf, (base ^ 0x85ebca6b) >>> 0, 0.6);

  const axisA = AXIS_KEY[policy.captiveAxis] || '総合';
  const axisB = { martial: '武', agrarian: '器用', fecund: '繁殖', purist: '総合',
    melting: '知', terror: '頑健', laissez: '総合', pious: '総合',
    merit: '知', dynastic: '統率' }[opponentId] || '総合';

  // 国力の履歴。最終世代の1点だけを見ると分散が大きすぎて方針の差が埋もれるので、
  // 末尾の平均（powerTail）も返す。契約の power はそのまま最終世代の値。
  const hist = [];
  for (let g = 0; g < gens; g++) {
    for (const n of [me, foe]) {
      if (!n.world.people.size) continue;
      runRivalTurn(n.world, n.owner, rng);
      advanceGeneration(n.world, rng);
    }
    hist.push(me.world.powerIndex || 0);
    if (!me.world.people.size) break;
    // 開戦。roster.maybeWars と同じ条件（小国は出さない／間隔4世代）
    const ready = [me, foe].every(
      (n) => n.world.people.size >= 25 && (g - n.lastWar) >= 4
    );
    if (ready) {
      const appetite = clamp01((pf.warAppetite + opf.warAppetite) / 2);
      if (rng.bool(appetite)) warBetween(me, foe, rng, g, axisA, axisB);
    }
  }

  const w = me.world;
  const st = w.stats[w.stats.length - 1] || {};
  const tailN = Math.max(1, Math.min(hist.length, Math.round(gens * 0.25)));
  const tail = hist.slice(hist.length - tailN);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  return {
    seed, opponent: opponentId,
    power: w.powerIndex || 0,
    powerTail: Math.round(mean(tail)),          // 末尾25%世代の平均国力（低分散版）
    powerMean: Math.round(mean(hist)),          // 全世代平均（持続の指標）
    powerMin: hist.length ? Math.min(...hist) : 0,
    pop: w.people.size,
    gens: w.gen,
    extinct: w.people.size === 0,
    wins: me.wins, losses: me.losses,
    admixture: +(st.admixture ?? 0).toFixed(4),
    morale: +(w.morale ?? 0).toFixed(4),
    regimeGrudge: +(w.regimeGrudge ?? 0).toFixed(4),
    yieldRate: +(w.yieldRate ?? 0).toFixed(2),
    foreign: +(st.foreign ?? 0).toFixed(4),
    homoz: +(st.homoz ?? 0).toFixed(4),
    oppPower: foe.world.powerIndex || 0,
  };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const req = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const gens = req.gens ?? 200;
  const seeds = req.seeds ?? [1];
  const opponents = req.opponents?.length ? req.opponents : ['martial'];
  const wire = process.env.EVAL_WIRE || 'owner';
  const results = [];
  for (const pol of req.policies || []) {
    for (const seed of seeds) {
      for (const opp of opponents) {
        let row;
        try {
          row = runOne(pol, seed, opp, gens, wire);
        } catch (e) {
          row = { seed, opponent: opp, power: 0, pop: 0, gens: 0, extinct: true,
                  wins: 0, losses: 0, admixture: 0, morale: 0, regimeGrudge: 0,
                  yieldRate: 0, error: String(e && e.message || e) };
        }
        results.push({ id: pol.id, ...row });
      }
    }
  }
  process.stdout.write(JSON.stringify({ results, evaluator: 'tools/search/local_eval.mjs', wire }));
}

// 非ASCIIのパスだと import.meta.url が percent-encode されて素朴な比較が落ちるので、
// 実行ファイル名で判定する（このファイルはCLIとしてしか使わない）。
if ((process.argv[1] || '').endsWith('local_eval.mjs')) main();
