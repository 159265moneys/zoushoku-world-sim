#!/usr/bin/env node
// ============================================================================
// run.js — 増殖 ヘッドレス検証ランナー
//
//   node test/run.js                 標準（不変条件バッチ + 1000世代の頻度依存 + 10国分化）
//   node test/run.js --quick         数十秒で一周する縮小版
//   node test/run.js --seeds 300     不変条件バッチを300種で回す
//   node test/run.js --gens 1000     1世界あたりの世代数
//   node test/run.js --selftest      検査器が「空振りでない」ことを故意のバグで証明する
//   node test/run.js --deep          頻度依存・近親交配の種数を大幅に増やす（分解能を上げる）
//   node test/run.js --json          test/report.json も出す
//   node test/run.js --out path.md   レポートの出力先
//
// 絶対規則：Math.random() を書かない / Date.now() に依存しない / 出力は決定的。
// ============================================================================

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RNG } from '../src/core/rng.js';
import { GENE_NAMES, MIND_GENES } from '../src/core/genes.js';

// 潜伏の観測対象。全部見ると読めないので心系の先頭8本に絞る。
const DEFAULT_TRACKED_MIND = MIND_GENES.slice(0, 8);
import { loadSim } from './sim-adapter.js';
import { Observer } from './observer.js';
import { Violations, checkWorld, worldHash, eventHash, POP_CEILING, TICK_LIMIT } from './invariants.js';
import * as C from './checks.js';
import { runIntegration, renderIntegration, selfCheckIntegration } from './integration.js';
import { playP1, checkP1, selfCheckP1 } from './p1.js';
import { viabilityOf, corpusSummary, viableOnly, MIN_BREEDING_GENS, BREEDING_POP, EARLY_DEATH_GENS } from './viability.js';
import { mean, sd, round, pct, lineChart, barChart, histogram, maxOf, minOf, padTo, strWidth } from './lib/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const [k, vInline] = t.slice(2).split('=');
      const next = argv[i + 1];
      if (vInline !== undefined) a[k] = vInline;
      else if (next !== undefined && !next.startsWith('--')) { a[k] = next; i++; }
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}
const ARG = parseArgs(process.argv.slice(2));
const num = (k, d) => (ARG[k] !== undefined ? Number(ARG[k]) : d);

const QUICK = !!ARG.quick;
// --deep : 閾値付近で PASS/WARN が入れ替わる項目（頻度依存・近親交配）の種数を増やす。
//          「本当に綱引きなのか、単に種が足りないのか」を判定するための分解能。
//          標準の run は重くしたくないので、増やすのはこのフラグのときだけ。
const DEEP = !!ARG.deep;
const CONF = {
  seeds:       num('seeds',       QUICK ? 8   : 24),   // 不変条件バッチの本数
  gens:        num('gens',        QUICK ? 120 : 200),  // 1本あたりの世代数
  freqSeeds:   num('freq-seeds',  QUICK ? 2   : (DEEP ? 32 : 3)),
  freqGens:    num('freq-gens',   QUICK ? 300 : (DEEP ? 600 : 1000)), // AAA-3 は1000世代
  rosterSeeds: num('roster-seeds',QUICK ? 2   : 10),
  rosterGens:  num('roster-gens', QUICK ? 120 : 200),
  inbreedSeeds:num('inbreed-seeds',QUICK ? 3  : (DEEP ? 32 : 5)),
  inbreedGens: num('inbreed-gens', QUICK ? 120 : 200),
  p1Seeds:     num('p1-seeds',    QUICK ? 8   : 24),    // 序盤の体験は種ごとのばらつきが大きい
  deep:        DEEP,
  strict:      !!ARG.strict,                            // 毎tick全件検査
};

// ---------------------------------------------------------------------------
// 1世界を回す
// ---------------------------------------------------------------------------
function runWorld(api, o) {
  const {
    seed, gens, answers = {}, trackedMind = [], keepBirths = true,
    inject = null,              // {atGen, n} 外来血の注入（近親交配の回復テスト）
    collectViolations = true,
  } = o;
  const TPG = api.TICKS_PER_GEN ?? 8;
  const world = api.createWorld(seed, answers);
  const rng = new RNG(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
  const obs = new Observer({ trackedMind, keepBirths , keepZygo: o.keepZygo !== false });
  const v = new Violations();
  let ticks = 0, aborted = null;
  const genHashes = [];

  if (collectViolations) checkWorld(world, v, 'init');
  obs.observe(world);

  for (let g = 0; g < gens; g++) {
    for (let t = 0; t < TPG; t++) {
      try {
        api.stepTick(world, rng);
      } catch (e) {
        aborted = 'sim-threw';
        v.add('sim-threw', `stepTick が例外: ${e?.message ?? e}`,
          { where: 'tick', gen: world.gen, tick: world.tick, stack: firstFrames(e) });
        break;
      }
      ticks++;
      if (ticks > TICK_LIMIT) { aborted = 'tick-limit'; break; }
      if (collectViolations) checkWorld(world, v, 'tick', { light: !CONF.strict });
    }
    if (aborted) break;
    try {
      api.advanceGeneration(world, rng);
    } catch (e) {
      // sim が例外を投げたらランナーごと止まるのではなく、赤い実測として記録する。
      aborted = 'sim-threw';
      v.add('sim-threw', `advanceGeneration が例外: ${e?.message ?? e}`,
        { where: 'gen', gen: world.gen, tick: world.tick, stack: firstFrames(e) });
      break;
    }
    if (collectViolations) checkWorld(world, v, 'gen');
    obs.observe(world);
    genHashes.push(worldHash(world));

    // 戦争を撃つ。公開APIだけで回すので fake でも本物でも同じ経路になる。
    // 戦死の内訳検査と「外来血の流入」はどちらもここが供給源。
    if (o.war && world.gen > 2 && world.gen % o.war.every === 0) {
      driveWar(api, world, rng, o.war);
    }
    if (inject && world.gen === inject.atGen) {
      injectForeignBlood(api, world, rng, inject.n);
    }
    if (world.people.size === 0) { aborted = 'extinct'; break; }
    if (world.people.size > POP_CEILING) { aborted = 'pop-explosion'; break; }
  }

  const death = obs.deathBreakdown(world);
  return {
    seed, world, obs, violations: v, ticks, aborted, death,
    hash: hashList(genHashes), events: eventHash(world),
    injectAt: inject?.atGen ?? null,
    gens: obs.series.length - 1,
    requestedGens: gens,
    viability: viabilityOf(obs, gens),
  };
}


/**
 * 1戦だけ撃つ。sim の公開APIしか使わない。
 * どれか1本でも欠けていたら黙って何もしない（＝対応する検査は SKIP / INCONCLUSIVE になる）。
 */
function driveWar(api, world, rng, policy) {
  if (!api.makeGhost || !api.startWar || !api.settleWar) return null;
  try {
    const ghost = api.makeGhost((world.seed ^ (world.gen * 2654435761)) >>> 0, world.phase ?? 1, 1);
    const battle = api.startWar(world, rng, ghost);
    if (!battle) return null;
    if (api.runBattle) api.runBattle(battle, rng);
    else if (api.stepBattle) { let g = 200; while (!battle.over && g-- > 0) api.stepBattle(battle, rng); }
    api.settleWar(world, battle, rng);
    // 捕虜。勝者だけが軸を選べる（設計文書「勝者は軸を1つ選んで上位プールから抽選」）
    if (policy.captive && api.takeCaptives && api.borderDecision) {
      const caps = api.takeCaptives(world, battle, policy.axis ?? '総合', rng) ?? [];
      for (const c of caps) api.borderDecision(world, c.id ?? c, policy.captive);
    }
    return battle;
  } catch { return null; }
}

/** 外来血の注入。近親交配からの「回復」を測るための一手。 */
function injectForeignBlood(api, world, rng, n) {
  for (let i = 0; i < Math.max(1, Math.ceil(n / 3)); i++) {
    driveWar(api, world, rng, { captive: 'accept', axis: '総合' });
  }
  if (world.mating) world.mating.foreignBias = 0.9;   // 本物のsimの混血レバー
  world.closed = false; world.outsideBlood = 0.9;     // fake-sim のレバー
}

/** 例外の発生箇所を数フレームだけ。レポートに貼れる長さに畳む。 */
function firstFrames(e, n = 3) {
  return String(e?.stack ?? '').split('\n').slice(1, 1 + n)
    .map(s => s.trim().replace(process.cwd() + '/', '').replace(/file:\/\/\S*?game\//, ''))
    .join(' / ');
}

function hashList(list) {
  // 世代ごとのハッシュをさらに畳む
  let h = 0x811c9dc5;
  for (const s of list) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// ---------------------------------------------------------------------------
// ロスター（10国）を回す
// ---------------------------------------------------------------------------
/**
 * ロスターの1要素からプロファイルidを取り出す。
 * **必ず文字列であること**を確かめる。sim によっては `profile` がプロファイル
 * オブジェクトそのものなので、素直に拾うと全10国が同じキー "[object Object]" に
 * 潰れて「分化していない」という嘘の実測が出る。
 */
function profileIdOf(n, i) {
  const w = n.world ?? n;
  for (const cand of [n.id, n.profile, w.profileId, w.profileID, n.key]) {
    if (typeof cand === 'string' && cand) return cand;
  }
  for (const cand of [n.profile?.id, n.profile?.label, w.profile?.id, w.profile?.label]) {
    if (typeof cand === 'string' && cand) return cand;
  }
  return `#${i}`;
}

function runRoster(api, seed, gens, trackedMind) {
  const TPG = api.TICKS_PER_GEN ?? 8;
  const roster = api.createRoster(seed);
  const rng = new RNG(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
  const nations = roster.nations ?? roster.worlds ?? [];
  const per = nations.map((n, i) => ({
    nation: n,
    world: n.world ?? n,
    profileId: profileIdOf(n, i),
    name: n.name ?? null,
    // 出生レコードはバッチ側で十数万件取れているのでロスターでは持たない。
    // 10国×種数ぶんの世界を全部抱えるとヒープが尽きる。
    obs: new Observer({ trackedMind, keepBirths: false, keepZygo: false }),
    violations: new Violations(),
    seed,
  }));
  for (const p of per) { checkWorld(p.world, p.violations, 'init'); p.obs.observe(p.world); }

  // advanceRoster があれば必ずそれを使う。
  // 自前で stepTick/advanceGeneration を回すと runRivalTurn（＝10の経営思想そのもの）を
  // 素通りしてしまい、「オーナーごとに分化しない」という嘘の実測が出る。
  const useRoster = typeof api.advanceRoster === 'function';
  let rosterThrew = null;
  for (let g = 0; g < gens; g++) {
    try {
      if (useRoster) {
        api.advanceRoster(roster, rng, 1);
      } else {
        for (const p of per) {
          if (!p.world.people.size) continue;
          for (let t = 0; t < TPG; t++) api.stepTick(p.world, rng);
          api.advanceGeneration(p.world, rng);
        }
        roster.gen++;
      }
    } catch (e) {
      // ロスターが落ちてもランナーは止めない。赤い実測として残して次へ進む。
      rosterThrew = { gen: g, msg: e?.message ?? String(e), stack: firstFrames(e) };
      per[0]?.violations.add('sim-threw',
        `advanceRoster が第${g}世代で例外: ${rosterThrew.msg}`,
        { where: 'roster', gen: g, tick: 0, stack: rosterThrew.stack });
      break;
    }
    for (const p of per) {
      checkWorld(p.world, p.violations, 'gen');
      p.obs.observe(p.world);
    }
  }
  for (const p of per) {
    p.death = p.obs.deathBreakdown(p.world);
    p.hash = worldHash(p.world);
    p.gens = p.obs.series.length - 1;
    p.viability = viabilityOf(p.obs, gens);
    releaseWorld(p.world);
  }
  return { roster, per, drivenByRoster: useRoster, rosterThrew };
}

/**
 * 走り終わった世界から、以降の検査が使わない重いものを捨てる。
 * ロスターは 10国 × 種数ぶんの世界を同時に抱えるので、これがないとヒープが尽きる。
 * 残すのは年代記（遡行の検査）と局長ログ（透過率の検査）だけ。
 */
function releaseWorld(w) {
  try {
    w.people?.clear?.();
    w.dead?.clear?.();
    w.foreign?.clear?.();
    w.border?.clear?.();
    if (Array.isArray(w.battles)) w.battles.length = 0;
    if (Array.isArray(w.ledger)) w.ledger.length = 0;
    if (Array.isArray(w.stats)) w.stats.length = 0;
  } catch { /* 解放は best effort。失敗しても検査結果は変わらない */ }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
async function main() {
  const sim = await loadSim(ARG.impl ?? 'auto');
  if (!sim.api) { console.error(`sim を読み込めない: ${sim.error}`); process.exit(2); }
  const api = sim.api;
  // 潜伏を追う心系遺伝子。sim が指定しなければ心系の先頭8本を使う。
  // ここが空配列になると劣性の潜伏検査が黙って0件になるので既定値を必ず入れる。
  const trackedMind = (api.TRACKED_MIND && api.TRACKED_MIND.length)
    ? api.TRACKED_MIND : DEFAULT_TRACKED_MIND;
  const log = s => process.stderr.write(s + '\n');

  log(`[増殖:test] sim = ${sim.impl}${sim.isReal ? '' : '（src/sim/ が未実装のため代替実装）'}`);
  if (sim.missing.length) log(`[増殖:test] 未実装のAPI: ${sim.missing.join(', ')}`);

  const report = { sim, conf: CONF, sections: [], checks: [] };

  // ===== フェーズ1：不変条件バッチ + 決定性 ================================
  log(`[1/5] 不変条件バッチ: ${CONF.seeds}種 × ${CONF.gens}世代`);
  const batch = [];
  for (let i = 0; i < CONF.seeds; i++) {
    const seed = 1000 + i * 7919;
    // 4世代に1度は戦争を撃つ。戦死の内訳を測る母集団はここで作る。
    batch.push(runWorld(api, { seed, gens: CONF.gens, trackedMind, war: { every: 4, captive: 'accept', axis: '総合' } }));
  }
  const allV = new Violations(60);
  for (const r of batch) allV.merge(r.violations);
  const aborted = batch.filter(r => r.aborted);

  log(`[2/5] 決定性: 同じ種で2周し歴史ハッシュを突き合わせ`);
  const detN = Math.min(6, CONF.seeds);
  const det = [];
  for (let i = 0; i < detN; i++) {
    const seed = 1000 + i * 7919;
    const again = runWorld(api, {
      seed, gens: CONF.gens, trackedMind, collectViolations: false,
      war: { every: 4, captive: 'accept', axis: '総合' },
    });
    det.push({
      seed,
      a: batch[i].hash, b: again.hash,
      ea: batch[i].events, eb: again.events,
      ok: batch[i].hash === again.hash && batch[i].events === again.events,
    });
  }
  // 種が違えば歴史も違う（ハッシュが潰れていないことの確認）
  const distinct = new Set(batch.map(r => r.hash)).size;

  // ===== フェーズ2：頻度依存（1000世代）====================================
  log(`[3/5] 頻度依存: ${CONF.freqSeeds}種 × ${CONF.freqGens}世代`);
  const freq = [];
  for (let i = 0; i < CONF.freqSeeds; i++) {
    // 出生レコードはバッチ側で十分に取れている。--deep で32本回すときに
    // 全部保持するとヒープが尽きるので、先頭3本だけ残す。
    const r = runWorld(api, {
      seed: 424242 + i * 104729, gens: CONF.freqGens, trackedMind,
      keepBirths: i < 3, keepZygo: i < 3,
    });
    allV.merge(r.violations);
    // 頻度依存の検査が見るのは obs.series だけ。世界の中身はもう要らない。
    releaseWorld(r.world);
    freq.push(r);
  }

  // ===== フェーズ3：10国ロスター ==========================================
  log(`[4/5] 10国ロスター: ${CONF.rosterSeeds}種 × ${CONF.rosterGens}世代`);
  const byProfile = {};
  const rosterRuns = [];
  for (let i = 0; i < CONF.rosterSeeds; i++) {
    const rr = runRoster(api, 90001 + i * 15485863, CONF.rosterGens, trackedMind);
    rosterRuns.push(rr);
    for (const p of rr.per) {
      (byProfile[p.profileId] ||= []).push(p);
      allV.merge(p.violations);
    }
  }
  const opponents = typeof api.listOpponents === 'function' && rosterRuns.length
    ? api.listOpponents(rosterRuns[0].roster) : [];

  // ===== フェーズ4：近親交配 ==============================================
  log(`[5/5] 近親交配: 閉鎖/開放/回復 各${CONF.inbreedSeeds}種 × ${CONF.inbreedGens}世代`);
  const closed = [], open = [], recovery = [];
  // 検査が見るのは obs.series だけなので、1本走らせるたびにその場で世界を解放する。
  // 最後にまとめて解放すると、--deep では96個の世界（と数十万の死者）が同時に生きてヒープが尽きる。
  const inbreed = (bucket, o) => {
    const r = runWorld(api, o);
    allV.merge(r.violations);
    releaseWorld(r.world);
    bucket.push(r);
  };
  for (let i = 0; i < CONF.inbreedSeeds; i++) {
    const s = 777001 + i * 32452843;
    // 閉鎖＝一度も外の血を入れない（戦争もしない）。開放＝戦うたびに捕虜を受け入れる。
    // fake-sim は answers のフラグで、本物の sim は「捕虜を受け入れるかどうか」で同じ状態になる。
    inbreed(closed, {
      seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false, keepZygo: false,
      answers: { closed: true, outsideBlood: 0 },
    });
    inbreed(open, {
      seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false, keepZygo: false,
      answers: { closed: false, outsideBlood: 0.9 },
      war: { every: 3, captive: 'accept', axis: '総合' },
    });
    inbreed(recovery, {
      seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false, keepZygo: false,
      answers: { closed: true, outsideBlood: 0 },
      inject: { atGen: Math.floor(CONF.inbreedGens / 2), n: 8 },
    });
  }

  // ===== 序盤の体験（第1フェーズ）=========================================
  // 10体到達 → 初戦 → 戦後処理 → フェーズ2 という順序と、5対5・捕虜1体・3〜4世代。
  // バランスの数字ではなく「体験の形」なので、崩れたら看板の場面が成立しなくなる。
  log(`[P1] 始まりの村: ${CONF.p1Seeds}種を10体到達＋初戦まで`);
  const p1Runs = [];
  for (let i = 0; i < CONF.p1Seeds; i++) {
    p1Runs.push(playP1(api, 31337 + i * 6151, { maxGens: 40 }));
  }
  const p1Checks = checkP1(p1Runs);

  // ===== 設計主張の検証 ===================================================
  const allRuns = [...batch, ...freq];
  const rosterFlat = Object.values(byProfile).flat();
  const checks = [
    C.checkLinkage([...allRuns, ...rosterFlat], api.ARM_EXEMPT),
    C.checkFrequency(freq),
    C.checkRecessiveLatency(allRuns, trackedMind),
    C.checkInbreeding(closed, open, recovery),
    C.checkDivergence(byProfile),
    C.checkSkillHeritability([...allRuns, ...rosterFlat]),
    C.checkWarDeath([...allRuns, ...rosterFlat]),
    C.checkPuristVsMelting(byProfile),
    C.checkTerrorLag(byProfile),
    C.checkMeritVsDynastic(byProfile),
    C.checkMartialVsAgrarian(byProfile),
    C.checkChronicleTrace(rosterFlat.length ? rosterFlat : allRuns, api),
    ...p1Checks,
  ];

  // ===== 統合スモーク：UI と sim の継ぎ目 ==================================
  // sim単体とUI単体が両方緑でも、繋いだ状態は誰も見ていない。ここがその1本。
  log(`[統合] UI が呼ぶ名前の突き合わせ + 導線のヘッドレス一周`);
  let integration = null;
  try {
    integration = await runIntegration(sim, { seed: 20250819, gens: 20 });
  } catch (e) {
    integration = {
      status: 'FAIL', summary: `統合スモーク自体が落ちた: ${e.message}`,
      audit: { rows: [] }, walk: { steps: [] }, counts: {},
    };
  }

  // ===== 検査器の自己検証（--selftest）====================================
  let selftest = null;
  if (ARG.selftest) {
    // selftest は必ず fake-sim の上で走らせる。
    // 故意のバグ（サボタージュ）を注入できるのは参照実装だけで、
    // ここで確かめたいのは sim の正しさではなく「検査器が空振りでないこと」。
    log(`[+] selftest: 参照実装に故意のバグを入れて、検査がちゃんと落ちるか確かめる`);
    const fakeSim = await loadSim('fake');
    selftest = await runSelfTest(fakeSim.api, fakeSim.api.TRACKED_MIND ?? trackedMind);
    // 統合スモークが空振りでないことも同じ場で確かめる
    const ic = await selfCheckIntegration(sim);
    selftest.push({
      sabotage: 'mock専用の名前', expect: 'integration',
      got: ic.ok === null ? 'N/A' : (ic.ok ? 'FAIL(検出)' : 'PASS(見逃し)'),
      caught: ic.ok !== false,
      detail: ic.note,
    });
    // P1 の検査も、壊れた序盤を捏造して落ちることを確かめる
    const pc = selfCheckP1();
    selftest.push({
      sabotage: '壊れた序盤(4対19/捕虜3体/第6世代)', expect: 'p1',
      got: pc.ok ? 'FAIL(4項目とも検出)' : `見逃し ${JSON.stringify(pc.statuses)}`,
      caught: pc.ok, detail: pc.note,
    });
  }

  // ===== レポート =========================================================
  const md = renderReport({
    sim, conf: CONF, batch, allV, aborted, det, distinct, freq,
    byProfile, opponents, closed, open, recovery, checks, selftest, api, integration,
  });
  const out = ARG.out ? resolve(String(ARG.out)) : join(HERE, 'report.md');
  writeFileSync(out, md, 'utf8');
  log(`\nレポート: ${out}`);

  if (ARG.json) {
    const jsonOut = out.replace(/\.md$/, '') + '.json';
    writeFileSync(jsonOut, JSON.stringify({
      impl: sim.impl, missing: sim.missing, conf: CONF,
      invariants: { violations: Object.fromEntries(allV.counts), aborted: aborted.map(r => ({ seed: r.seed, why: r.aborted })) },
      determinism: det.map(d => ({ seed: d.seed, ok: d.ok, a: d.a, b: d.b })),
      checks: checks.map(c => ({ id: c.id, status: c.status, summary: c.summary, numbers: c.numbers })),
      integration: integration && {
        status: integration.status, summary: integration.summary, counts: integration.counts,
        symbols: integration.audit.rows.map(r => ({ name: r.name, status: r.status, alias: r.alias })),
        steps: integration.walk.steps.map(s => ({ label: s.label, status: s.status, note: s.note })),
      },
      selftest,
    }, null, 2), 'utf8');
    log(`JSON:      ${jsonOut}`);
  }

  // ===== 標準出力に要約 ===================================================
  const line = (s, t) => `${String(s).padEnd(13)} ${t}`;
  const allWorlds = [...batch, ...freq, ...rosterFlat, ...closed, ...open, ...recovery];
  const corpus = corpusSummary(allWorlds);
  console.log('');
  console.log(`sim: ${sim.impl}`);
  const hardAborts = aborted.filter(r => r.aborted !== 'extinct');
  const hardOk = allV.ok && hardAborts.length === 0;
  const earlyOk = corpus.earlyDeathRate <= 0.10;
  console.log(line(hardOk ? 'PASS' : 'FAIL',
    `不変条件a NaN/範囲/負値/人口爆発/無限ループ  違反=${allV.total} 強制終了=${hardAborts.length}`));
  console.log(line(earlyOk ? 'PASS' : 'FAIL',
    `不変条件b 即死しない  ${EARLY_DEATH_GENS}世代以内の絶滅=${corpus.earlyDeaths}/${corpus.worlds} (${pct(corpus.earlyDeathRate)})`));
  console.log(line(det.every(d => d.ok) ? 'PASS' : 'FAIL', `決定性 (${det.length}種を2周)  異なる歴史=${distinct}/${batch.length}`));
  if (integration) console.log(line(integration.status, `統合 UI↔sim — ${oneLine(integration.summary)}`));
  console.log(line(corpus.viableWorlds ? 'INFO' : 'BLOCKED',
    `判定可能な世界 ${corpus.viableWorlds}/${corpus.worlds}（絶滅 ${corpus.extinctWorlds}／平均繁殖可能 ${corpus.meanBreedingGens}世代）`));
  console.log('');
  for (const c of checks) console.log(line(c.status, `${c.title} — ${oneLine(c.summary)}`));
  if (selftest) {
    console.log('');
    for (const s of selftest) console.log(line(s.caught ? 'PASS' : 'FAIL', `selftest[${s.sabotage}] → ${s.expect} が ${s.got}`));
  }
  const nInc = checks.filter(c => c.status === 'INCONCLUSIVE').length;
  if (nInc) {
    console.log('');
    console.log(`※ INCONCLUSIVE ${nInc}件は「主張が偽」ではなく「世界が続かないので測れていない」。FAILと混同しないこと。`);
  }

  // 終了コード：設計主張の INCONCLUSIVE では落とさない（測れていないだけ）。
  // 落とすのは 不変条件・決定性・実測で否定された主張・検査器の空振り。
  const hardFail = !hardOk || !earlyOk || det.some(d => !d.ok)
    || checks.some(c => c.status === 'FAIL') || (selftest ?? []).some(s => !s.caught)
    || (integration && integration.status === 'FAIL');
  process.exitCode = hardFail ? 1 : 0;
}

function histogramText(values) {
  if (!values.length) return '(none)';
  const hi = maxOf(values, 1);
  return histogram(values, { bins: Math.min(10, Math.max(3, hi)), lo: 0, hi: Math.max(10, hi), width: 34 });
}

function oneLine(s) {
  const t = String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 150 ? t.slice(0, 147) + '…' : t;
}

// ---------------------------------------------------------------------------
// selftest：故意のバグを入れて、対応する検査が FAIL するかを見る。
// 検査が「何をやってもPASS」なら、その検査には価値がない。
// ---------------------------------------------------------------------------
async function runSelfTest(api, trackedMind) {
  const G = 160, S = 8;
  const cases = [
    { sabotage: 'linkage',         expect: 'linkage',        run: 'plain' },
    { sabotage: 'heritable-skill', expect: 'skill',          run: 'plain' },
    { sabotage: 'luck50',          expect: 'wardeath',       run: 'plain' },
    { sabotage: 'no-recessive',    expect: 'recessive',      run: 'plain' },
    { sabotage: 'no-nfd',          expect: 'frequency',      run: 'freq'  },
    { sabotage: 'uniform-policy',  expect: 'divergence',     run: 'roster'},
  ];
  const out = [];
  for (const c of cases) {
    let res;
    if (c.run === 'roster') {
      const by = {};
      for (let i = 0; i < 4; i++) {
        const TPG = api.TICKS_PER_GEN ?? 8;
        const roster = api.createRoster(90001 + i * 15485863, { sabotage: c.sabotage });
        const rng = new RNG(((90001 + i * 15485863) ^ 0x85ebca6b) >>> 0);
        const nations = roster.nations ?? roster.worlds ?? [];
        const per = nations.map((n, k) => ({
          world: n.world ?? n,
          profileId: profileIdOf(n, k),
          obs: new Observer({ trackedMind }),
        }));
        for (let g = 0; g < G; g++) {
          for (const p of per) {
            if (!p.world.people.size) continue;
            for (let t = 0; t < TPG; t++) api.stepTick(p.world, rng);
            api.advanceGeneration(p.world, rng);
          }
          for (const p of per) p.obs.observe(p.world);
        }
        for (const p of per) {
          p.viability = viabilityOf(p.obs, G);
          (by[p.profileId] ||= []).push(p);
        }
      }
      res = C.checkDivergence(by);
    } else {
      const runs = [];
      const gens = c.run === 'freq' ? 420 : G;
      for (let i = 0; i < S; i++) {
        runs.push(runWorld(api, {
          seed: 5150 + i * 7907, gens, trackedMind,
          answers: { sabotage: c.sabotage }, collectViolations: false,
          war: { every: 3, captive: 'accept', axis: '総合' },
        }));
      }
      res = c.expect === "linkage" ? C.checkLinkage(runs, api.ARM_EXEMPT)
        : c.expect === 'skill' ? C.checkSkillHeritability(runs)
        : c.expect === 'wardeath' ? C.checkWarDeath(runs)
        : c.expect === 'recessive' ? C.checkRecessiveLatency(runs, trackedMind)
        : C.checkFrequency(runs);
    }
    out.push({
      sabotage: c.sabotage, expect: c.expect, got: res.status,
      caught: res.status === 'FAIL' || res.status === 'WARN',
      detail: res.summary,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// レポート
// ---------------------------------------------------------------------------
const BADGE = {
  PASS: '✅ PASS',
  FAIL: '❌ FAIL（実測で否定された）',
  WARN: '⚠️ WARN',
  SKIP: '⏭ SKIP（simがデータを出していない）',
  INCONCLUSIVE: '🚧 INCONCLUSIVE（測れていない・否定ではない）',
};
const SHORT = { PASS: '✅', FAIL: '❌', WARN: '⚠️', SKIP: '⏭', INCONCLUSIVE: '🚧' };

function renderReport(d) {
  const { sim, conf, batch, allV, aborted, det, distinct, freq, byProfile, opponents,
          closed, open, recovery, checks, selftest, api, integration } = d;
  const L = [];
  const P = s => L.push(s);

  P('# 増殖 — ヘッドレス検証レポート');
  P('');
  P('`node test/run.js` が生成。**このファイルは手で編集しない。**');
  P('');
  P(`- 検査対象 sim: **${sim.impl}**${sim.isReal ? '' : '　← `src/sim/` を使えなかったので `test/fake-sim.js`（参照実装）を検査している'}`);
  P(`- 読み込み元: \`${sim.from}\``);
  if (!sim.isReal) {
    P('');
    P('  > **重要**: 以下の結果は参照実装が設計どおりに書かれていることしか示さない。');
    P('  > 本物の `src/sim/` が読めるようになれば sim-adapter が自動でそちらに切り替わる。');
  }
  for (const n of sim.notes ?? []) P(`- 注記: ${n}`);
  if (sim.missing?.length) {
    P(`- sim が出していない関数（対応する検査は SKIP）: \`${sim.missing.join('`, `')}\``);
  }
  P(`- 実行パラメータ: 不変条件 ${conf.seeds}種×${conf.gens}世代 / 頻度依存 ${conf.freqSeeds}種×${conf.freqGens}世代 / ロスター ${conf.rosterSeeds}種×${conf.rosterGens}世代 / 近親交配 ${conf.inbreedSeeds}種×${conf.inbreedGens}世代`);
  P('');

  // ---- 結果の読み方（ここを先に置く。FAIL と INCONCLUSIVE の混同が一番の事故）----
  const allWorlds = [...batch, ...freq, ...Object.values(byProfile).flat(), ...closed, ...open, ...recovery];
  const corpus = corpusSummary(allWorlds);
  P('## この記号の意味');
  P('');
  P('| 記号 | 意味 |');
  P('|---|---|');
  P('| ✅ PASS | 十分な歴史があり、主張どおりの結果が出た |');
  P('| ❌ FAIL | **十分な歴史があり、そのうえで主張と逆の結果が出た**。設計か実装のどちらかが間違っている |');
  P('| 🚧 INCONCLUSIVE | **測れていない。主張が否定されたわけではない。** 世界が続かず、判定に必要な歴史が集まらなかった |');
  P('| ⏭ SKIP | sim がその観測に必要なデータを出していない（データ契約の穴） |');
  P('');
  if (corpus.viableWorlds < corpus.worlds) {
    P('> **🚧 は ❌ ではない。**');
    P('> 世界が10世代もたずに絶滅すると「劣性が数世代潜伏する」も「血が濃くなる」も');
    P('> 原理的に観測できない。それは設計への反証ではなく、測定が成立していないという意味。');
    P('> 経済が直って世界が続くようになれば、検査側は何も変えなくても判定に変わる。');
    P('');
  }

  // ---- サマリ ----
  P('## サマリ');
  P('');
  const hardOk = allV.ok && !aborted.some(r => r.aborted !== 'extinct');
  const earlyOk = corpus.earlyDeathRate <= 0.10;
  const detOk = det.every(x => x.ok);
  P(`検証の母集団: 世界 **${corpus.worlds}本**中、判定に足る歴史を持ったのは **${corpus.viableWorlds}本**`);
  P(`（絶滅 ${corpus.extinctWorlds}本／うち${EARLY_DEATH_GENS}世代以内の即死 ${corpus.earlyDeaths}本 / 平均到達 ${corpus.meanGens}世代 / 繁殖可能な規模で回った平均 ${corpus.meanBreedingGens}世代 / 最大到達人口 ${corpus.peakPop}）`);
  P('');
  P('| | 検査 | 結果 |');
  P('|---|---|---|');
  if (integration) P(`| 統合 | UI↔sim の継ぎ目（名前の突き合わせ＋導線1周） | ${BADGE[integration.status]} |`);
  P(`| AAA-1 | 決定性（同じ種＝同じ歴史） | ${BADGE[detOk ? 'PASS' : 'FAIL']} |`);
  P(`| AAA-2a | 不変条件（NaN・0..1逸脱・負値・人口爆発・無限ループ） | ${BADGE[hardOk ? 'PASS' : 'FAIL']} |`);
  P(`| AAA-2b | 即死しない（${EARLY_DEATH_GENS}世代以内の絶滅が1割以下） | ${BADGE[earlyOk ? 'PASS' : 'FAIL']}　${corpus.earlyDeaths}/${corpus.worlds} = ${pct(corpus.earlyDeathRate)} |`);
  const idToAAA = { frequency: 'AAA-3', linkage: 'AAA-4', recessive: 'AAA-5', chronicle: 'AAA-6' };
  for (const c of checks) P(`| ${idToAAA[c.id] ?? '—'} | ${c.title} | ${BADGE[c.status]} |`);
  P('');
  const fails = checks.filter(c => c.status === 'FAIL');
  const skips = checks.filter(c => c.status === 'SKIP');
  const incs = checks.filter(c => c.status === 'INCONCLUSIVE');
  if (fails.length) {
    P('### ❌ 実測で否定された主張');
    P('');
    P('十分な歴史があったうえで逆の結果が出たもの。ここだけが本当の「設計への反証」。');
    P('');
    for (const c of fails) P(`- **${c.title}** — ${oneLine(c.summary)}`);
    P('');
  } else {
    P('### ❌ 実測で否定された主張');
    P('');
    P('**なし。** 設計主張のうち、十分な歴史のうえで逆の結果が出たものは1つもない。');
    P('');
  }
  if (incs.length) {
    P('### 🚧 まだ測れていない主張');
    P('');
    P('世界が続かないため判定に至っていないもの。**主張が偽だという証拠は何も出ていない。**');
    P('');
    for (const c of incs) P(`- **${c.title}**`);
    P('');
  }
  if (skips.length) {
    P('### ⏭ sim が必要な情報を出していない');
    P('');
    for (const c of skips) P(`- **${c.title}** — ${oneLine(c.summary)}`);
    P('');
  }

  // ---- 統合スモーク ----
  if (integration) {
    P('---');
    P('');
    P(`## 統合スモーク（UI ↔ sim の継ぎ目） — ${BADGE[integration.status]}`);
    P('');
    P('sim単体もUI単体も緑なのに、繋いだ瞬間に落ちる。その穴を塞ぐための検査。');
    P('');
    P(integration.summary);
    P('');
    P(renderIntegration(integration));
    P('');
  }

  // ---- 不変条件 ----
  P('---');
  P('');
  P('## 不変条件');
  P('');
  const totalWorlds = batch.length + freq.length + Object.values(byProfile).flat().length + closed.length + open.length + recovery.length;
  const totalGens = batch.reduce((a, r) => a + r.gens, 0) + freq.reduce((a, r) => a + r.gens, 0);
  P(`検査した世界: **${totalWorlds}本**（うちバッチ ${batch.length}本、1000世代級 ${freq.length}本、10国ロスター ${Object.values(byProfile).flat().length}本）`);
  P(`最長の世界: ${Math.max(...freq.map(r => r.gens), ...batch.map(r => r.gens))}世代 / 総tick ${batch.reduce((a, r) => a + r.ticks, 0) + freq.reduce((a, r) => a + r.ticks, 0)}`);
  P('');
  P(`絶滅した世界: **${corpus.extinctWorlds}/${corpus.worlds}本**`
    + `（うち${EARLY_DEATH_GENS}世代以内の即死 ${corpus.earlyDeaths}本 = ${pct(corpus.earlyDeathRate)}）`);
  if (corpus.deathGens.length) {
    P('');
    P('絶滅した世代の分布:');
    P('```');
    P(histogramText(corpus.deathGens));
    P('```');
  }
  P('');
  if (allV.ok) P('そのほかの不変条件の違反 **0件**。NaN / Infinity / 負の人口 / 負の食料 / 0..1 逸脱 / 死者の混入 / 血統比の破れ、いずれも検出されず。');
  else {
    P(`違反 **${allV.total}件**`);
    P('');
    P('| 種別 | 件数 |'); P('|---|---|');
    for (const [k, v] of [...allV.counts].sort((a, b) => b[1] - a[1])) P(`| ${k} | ${v} |`);
    P('');
    P('最初の数件:');
    P('```');
    for (const x of allV.list.slice(0, 15)) P(`[${x.kind}] gen=${x.gen} tick=${x.tick} (${x.where}) ${x.msg}`);
    P('```');
  }
  P('');
  P(`強制終了（tick上限 ${TICK_LIMIT} / 人口上限 ${POP_CEILING} / 絶滅）: **${aborted.length}本**`);
  if (aborted.length) {
    P('```');
    for (const r of aborted.slice(0, 12)) P(`seed=${r.seed} gen=${r.world.gen} 人口=${r.world.people.size} 理由=${r.aborted}`);
    P('```');
  }
  P('');
  const pops = batch.map(r => r.obs.series.at(-1).pop);
  const popSeries = [];
  { const L0 = Math.min(...freq.map(r => r.obs.series.length));
    for (let i = 0; i < L0; i++) popSeries.push(mean(freq.map(r => r.obs.series[i].pop))); }
  P(`人口: バッチ末尾の平均 ${round(mean(pops), 1)}（最小 ${Math.min(...pops)} / 最大 ${Math.max(...pops)}）、全世界の最大瞬間人口 ${Math.max(...batch.map(r => r.obs.maxPop), ...freq.map(r => r.obs.maxPop))}`);
  P('');
  P(`人口の推移（${freq.length}種平均・${freq[0].gens}世代）:`);
  P('```');
  P(lineChart(popSeries, { width: 68, height: 10, lo: 0, hi: Math.max(...popSeries) * 1.2, xlabel: `gen 0 .. ${popSeries.length}` }));
  P('```');
  P('');
  const foodSeries = [];
  { const L0 = Math.min(...freq.map(r => r.obs.series.length));
    for (let i = 0; i < L0; i++) foodSeries.push(mean(freq.map(r => r.obs.series[i].food))); }
  P('食料ストックの推移:');
  P('```');
  P(lineChart(foodSeries, { width: 68, height: 8, lo: Math.min(0, Math.min(...foodSeries)), hi: Math.max(...foodSeries) * 1.1, xlabel: `gen 0 .. ${foodSeries.length}` }));
  P('```');
  P('');

  // ---- 決定性 ----
  P('---');
  P('');
  P('## 決定性 — 同じ種から同じ歴史が出るか');
  P('');
  P('各種について世界を2回まるごと作り直し、全世代の状態ハッシュ（個体ID・年齢・配役・33遺伝子・5練度）と事件ログのハッシュを突き合わせる。');
  P('');
  P('| seed | 1周目 | 2周目 | 事件ログ | 一致 |');
  P('|---|---|---|---|---|');
  for (const x of det) P(`| ${x.seed} | \`${x.a}\` | \`${x.b}\` | \`${x.ea}\`/\`${x.eb}\` | ${x.ok ? '✅' : '❌'} |`);
  P('');
  P(`種を変えれば歴史も変わることの確認: ${batch.length}種で **${distinct}通り** の歴史ハッシュ（潰れていたらハッシュが効いていない）。`);
  P('');

  // ---- 10国ロスター ----
  if (opponents.length) {
    P('---');
    P('');
    P('## 10国ロスター');
    P('');
    P(`\`createRoster\` → \`advanceRoster\` を ${CONF.rosterGens}世代。\`listOpponents\` が返す国力（通常はこれしか見えない）:`);
    P('');
    P('| id | 名 | 国力 | 階級 |');
    P('|---|---|---|---|');
    for (const o of opponents) P(`| \`${o.id}\` | ${o.name} | ${round(o.power, 1)} | ${o.tier} |`);
    P('');
    const ids = Object.keys(byProfile);
    P('| 国 | 末尾人口 | 産出 | 民心 | 劣性ホモ | 外来比 | 戦死 | 粛清/世代 | 謀反/世代 |');
    P('|---|---|---|---|---|---|---|---|---|');
    for (const id of ids) {
      const rs = byProfile[id];
      const t = f => round(mean(rs.map(r => f(r.obs.series.at(-1)))), 3);
      const s = f => round(mean(rs.map(r => mean(r.obs.series.map(f)))), 3);
      P(`| \`${id}\` | ${round(mean(rs.map(r => r.obs.series.at(-1).pop)), 1)} | ${t(x => x.yieldRate)} | ${t(x => x.morale)} | ${t(x => x.homo)} | ${t(x => x.foreignFrac)} | ${round(mean(rs.map(r => (r.death?.stat ?? 0) + (r.death?.luck ?? 0))), 1)} | ${s(x => x.purges)} | ${s(x => x.rebels)} |`);
    }
    P('');
  }

  // ---- 各主張 ----
  P('---');
  P('');
  P('## 設計主張の検証');
  P('');
  for (const c of checks) {
    P(`### ${BADGE[c.status]} — ${c.title}`);
    P('');
    P(`> 主張: ${c.claim}`);
    P('');
    P(c.summary);
    P('');
    if (c.detail) { P(c.detail); P(''); }
    if (Object.keys(c.numbers).length) {
      P('<details><summary>数値</summary>');
      P('');
      P('```json');
      P(JSON.stringify(c.numbers, null, 2));
      P('```');
      P('</details>');
      P('');
    }
  }

  // ---- selftest ----
  P('---');
  P('');
  P('## 検査器の自己検証');
  P('');
  if (!selftest) {
    P('`node test/run.js --selftest` で実行する。');
    P('');
    P('fake-sim に故意のバグ（腕予算を外す／練度を遺伝させる／運死を50%にする／心系を中間遺伝にする／頻度依存を外す／全プロファイルを同一挙動にする）を注入し、**対応する検査がちゃんと落ちるか**を確かめる。落ちない検査は空振りなので価値がない。');
  } else {
    P('fake-sim に故意のバグを注入し、対応する検査が落ちることを確認する。');
    P('');
    P('| 注入したバグ | 落ちるべき検査 | 結果 | |');
    P('|---|---|---|---|');
    for (const s of selftest) P(`| \`${s.sabotage}\` | ${s.expect} | ${s.got} | ${s.caught ? '✅ 検出' : '❌ 素通り'} |`);
    P('');
    for (const s of selftest.filter(x => !x.caught)) P(`- ⚠️ \`${s.sabotage}\` を入れても ${s.expect} が落ちなかった: ${s.detail}`);
    P('');
  }

  // ---- sim への要求 ----
  P('---');
  P('');
  P('## sim に期待しているデータ契約');
  P('');
  P('検査器が観測に使っているフィールド。ここが欠けると対応する検査は SKIP になり、AAAの項目が確認できないまま残る。');
  P('');
  P('| 使う場所 | 必要なもの | いま観測できているか |');
  P('|---|---|---|');
  const caps = mergeCaps([...batch, ...freq, ...Object.values(byProfile).flat()]);
  const mark = b => b ? '✅' : '❌';
  P(`| 劣性の潜伏・近親交配・雑種強勢 | \`individual.geno[遺伝子] = [{v,rec,load},{v,rec,load}]\`（アレル対）。\`model.js\` の \`genes\`（表現型）だけでは潜伏は原理的に測れない | ${mark(caps.geno)} |`);
  P(`| 近親交配の罰 | \`individual.load\`（劣性ホモで初めて効く遺伝的荷重） | ${mark(caps.load)} |`);
  P(`| 戦死の内訳 90/10 | \`individual.deathCause\` に \`war:stat\` / \`war:luck\` を区別して入れる（または \`world.deathTally\`） | ${mark(caps.deathCause)} |`);
  P(`| 逃走の頻度依存 | \`world.battles[] = {gen,n,deaths,stat,luck,routed,fleeFrac}\` | ${mark(caps.battles)} |`);
  P(`| terror の粛清→謀反 | \`world.purgeLog[gen]\` / \`world.rebelLog[gen]\` | ${mark(caps.purgeLog && caps.rebelLog)} |`);
  P(`| merit vs dynastic | \`world.bureauLog[] = {gen,bureau,id,house,houseRank,noble}\` | ${mark(caps.bureauLog)} |`);
  P(`| 年代記の遡行 | \`event.trueCause\`（上流の事件id）と \`event.claimed\` が別カラム、\`trace(world,eventId)\` | ${mark(caps.events)} |`);
  P('');
  P('また以下は `src/core/model.js` の契約に**まだ存在しない**：');
  P('');
  P('- `makeIndividual` は `genes`（表現型 0..1）しか持たない。**優性/劣性の潜伏を表現する場所がない。** AAA-5「心系の劣性が数世代潜伏して発現する」は、アレル対を持たない限り実装も検証も不可能。');
  P('- `individual.house` / 家系の識別子がない（merit vs dynastic の透過率検証に必要）。');
  P('- `deathCause` の語彙が未定義。テストは `war:stat` / `war:luck` を期待している。');
  P('');

  return L.join('\n') + '\n';
}

function mergeCaps(runs) {
  const out = { geno: false, load: false, deathCause: false, battles: false, purgeLog: false, rebelLog: false, bureauLog: false, events: false };
  for (const r of runs) for (const k of Object.keys(out)) if (r.obs?.caps?.[k]) out[k] = true;
  return out;
}

main().catch(e => { console.error(e); process.exit(2); });
