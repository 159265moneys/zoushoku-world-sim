#!/usr/bin/env node
// ============================================================================
// run.js — 増殖 ヘッドレス検証ランナー
//
//   node test/run.js                 標準（不変条件バッチ + 1000世代の頻度依存 + 10国分化）
//   node test/run.js --quick         数十秒で一周する縮小版
//   node test/run.js --seeds 300     不変条件バッチを300種で回す
//   node test/run.js --gens 1000     1世界あたりの世代数
//   node test/run.js --selftest      検査器が「空振りでない」ことを故意のバグで証明する
//   node test/run.js --json          test/report.json も出す
//   node test/run.js --out path.md   レポートの出力先
//
// 絶対規則：Math.random() を書かない / Date.now() に依存しない / 出力は決定的。
// ============================================================================

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RNG } from '../src/core/rng.js';
import { GENE_NAMES } from '../src/core/genes.js';
import { loadSim } from './sim-adapter.js';
import { Observer } from './observer.js';
import { Violations, checkWorld, worldHash, eventHash, POP_CEILING, TICK_LIMIT } from './invariants.js';
import * as C from './checks.js';
import { mean, sd, round, pct, lineChart, barChart, padTo, strWidth } from './lib/util.js';

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
const CONF = {
  seeds:       num('seeds',       QUICK ? 8   : 24),   // 不変条件バッチの本数
  gens:        num('gens',        QUICK ? 120 : 200),  // 1本あたりの世代数
  freqSeeds:   num('freq-seeds',  QUICK ? 2   : 3),
  freqGens:    num('freq-gens',   QUICK ? 300 : 1000), // AAA-3 は1000世代
  rosterSeeds: num('roster-seeds',QUICK ? 2   : 4),
  rosterGens:  num('roster-gens', QUICK ? 120 : 250),
  inbreedSeeds:num('inbreed-seeds',QUICK ? 3  : 5),
  inbreedGens: num('inbreed-gens', QUICK ? 120 : 200),
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
  const obs = new Observer({ trackedMind, keepBirths });
  const v = new Violations();
  let ticks = 0, aborted = null;
  const genHashes = [];

  if (collectViolations) checkWorld(world, v, 'init');
  obs.observe(world);

  for (let g = 0; g < gens; g++) {
    for (let t = 0; t < TPG; t++) {
      api.stepTick(world, rng);
      ticks++;
      if (ticks > TICK_LIMIT) { aborted = 'tick-limit'; break; }
      if (collectViolations) checkWorld(world, v, 'tick', { light: !CONF.strict });
    }
    if (aborted) break;
    api.advanceGeneration(world, rng);
    if (collectViolations) checkWorld(world, v, 'gen');
    obs.observe(world);
    genHashes.push(worldHash(world));

    if (inject && world.gen === inject.atGen) {
      // 外来血の注入は公開APIで行う（fake でも本物でも同じ経路）
      if (typeof api.takeCaptives === 'function') api.takeCaptives(world, rng, inject.n);
      world.closed = false;
      world.outsideBlood = 0.9;
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
  };
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
function runRoster(api, seed, gens, trackedMind) {
  const TPG = api.TICKS_PER_GEN ?? 8;
  const roster = api.createRoster(seed);
  const rng = new RNG(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
  const per = (roster.nations ?? roster.worlds ?? []).map(n => ({
    world: n.world ?? n,
    profile: n.profile ?? n.id ?? null,
    label: n.label ?? n.name ?? null,
    obs: new Observer({ trackedMind, keepBirths: true }),
    violations: new Violations(),
    seed,
  }));
  for (const p of per) { checkWorld(p.world, p.violations, 'init'); p.obs.observe(p.world); }

  for (let g = 0; g < gens; g++) {
    for (const p of per) {
      for (let t = 0; t < TPG; t++) {
        api.stepTick(p.world, rng);
        checkWorld(p.world, p.violations, 'tick', { light: !CONF.strict });
      }
      api.advanceGeneration(p.world, rng);
      checkWorld(p.world, p.violations, 'gen');
      p.obs.observe(p.world);
    }
    roster.gen++;
  }
  for (const p of per) {
    p.death = p.obs.deathBreakdown(p.world);
    p.profileId = p.world.profileId ?? p.world.profile?.label ?? '?';
    p.hash = worldHash(p.world);
  }
  return { roster, per };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
async function main() {
  const sim = await loadSim();
  const api = sim.api;
  const trackedMind = api.TRACKED_MIND ?? [];
  const log = s => process.stderr.write(s + '\n');

  log(`[増殖:test] sim = ${sim.impl}${sim.isReal ? '' : '（src/sim/ が未実装のため代替実装）'}`);
  if (sim.missing.length) log(`[増殖:test] 未実装のAPI: ${sim.missing.join(', ')}`);

  const report = { sim, conf: CONF, sections: [], checks: [] };

  // ===== フェーズ1：不変条件バッチ + 決定性 ================================
  log(`[1/5] 不変条件バッチ: ${CONF.seeds}種 × ${CONF.gens}世代`);
  const batch = [];
  for (let i = 0; i < CONF.seeds; i++) {
    const seed = 1000 + i * 7919;
    batch.push(runWorld(api, { seed, gens: CONF.gens, trackedMind }));
  }
  const allV = new Violations(60);
  for (const r of batch) allV.merge(r.violations);
  const aborted = batch.filter(r => r.aborted);

  log(`[2/5] 決定性: 同じ種で2周し歴史ハッシュを突き合わせ`);
  const detN = Math.min(6, CONF.seeds);
  const det = [];
  for (let i = 0; i < detN; i++) {
    const seed = 1000 + i * 7919;
    const again = runWorld(api, { seed, gens: CONF.gens, trackedMind, collectViolations: false });
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
    freq.push(runWorld(api, { seed: 424242 + i * 104729, gens: CONF.freqGens, trackedMind, keepBirths: true }));
    for (const r of freq) allV.merge(r.violations);
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
  for (let i = 0; i < CONF.inbreedSeeds; i++) {
    const s = 777001 + i * 32452843;
    closed.push(runWorld(api, { seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false, answers: { closed: true, outsideBlood: 0 } }));
    open.push(runWorld(api, { seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false, answers: { closed: false, outsideBlood: 0.9 } }));
    recovery.push(runWorld(api, {
      seed: s, gens: CONF.inbreedGens, trackedMind, keepBirths: false,
      answers: { closed: true, outsideBlood: 0 },
      inject: { atGen: Math.floor(CONF.inbreedGens / 2), n: 8 },
    }));
  }
  for (const r of [...closed, ...open, ...recovery]) allV.merge(r.violations);

  // ===== 設計主張の検証 ===================================================
  const allRuns = [...batch, ...freq];
  const rosterFlat = Object.values(byProfile).flat();
  const checks = [
    C.checkLinkage([...allRuns, ...rosterFlat]),
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
  ];

  // ===== 検査器の自己検証（--selftest）====================================
  let selftest = null;
  if (ARG.selftest) {
    log(`[+] selftest: 故意のバグを入れて、検査がちゃんと落ちるか確かめる`);
    selftest = await runSelfTest(api, trackedMind);
  }

  // ===== レポート =========================================================
  const md = renderReport({
    sim, conf: CONF, batch, allV, aborted, det, distinct, freq,
    byProfile, opponents, closed, open, recovery, checks, selftest, api,
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
      selftest,
    }, null, 2), 'utf8');
    log(`JSON:      ${jsonOut}`);
  }

  // ===== 標準出力に要約 ===================================================
  const line = (s, t) => `${s.padEnd(5)} ${t}`;
  console.log('');
  console.log(`sim: ${sim.impl}`);
  console.log(line(allV.ok && !aborted.length ? 'PASS' : 'FAIL',
    `不変条件 (${CONF.seeds}種×${CONF.gens}世代 + 1000世代 + 10国×${CONF.rosterSeeds})  違反=${allV.total} 中断=${aborted.length}`));
  console.log(line(det.every(d => d.ok) ? 'PASS' : 'FAIL', `決定性 (${det.length}種を2周)  異なる歴史=${distinct}/${batch.length}`));
  for (const c of checks) console.log(line(c.status, `${c.title} — ${c.summary}`));
  if (selftest) {
    console.log('');
    for (const s of selftest) console.log(line(s.caught ? 'PASS' : 'FAIL', `selftest[${s.sabotage}] → ${s.expect} が ${s.got}`));
  }

  const hardFail = !allV.ok || aborted.length > 0 || det.some(d => !d.ok) || checks.some(c => c.status === 'FAIL')
    || (selftest ?? []).some(s => !s.caught);
  process.exitCode = hardFail ? 1 : 0;
}

// ---------------------------------------------------------------------------
// selftest：故意のバグを入れて、対応する検査が FAIL するかを見る。
// 検査が「何をやってもPASS」なら、その検査には価値がない。
// ---------------------------------------------------------------------------
async function runSelfTest(api, trackedMind) {
  const G = 140, S = 3;
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
      for (let i = 0; i < 2; i++) {
        const TPG = api.TICKS_PER_GEN ?? 8;
        const roster = api.createRoster(90001 + i * 15485863, { sabotage: c.sabotage });
        const rng = new RNG(((90001 + i * 15485863) ^ 0x85ebca6b) >>> 0);
        const per = roster.worlds.map(w => ({ world: w, obs: new Observer({ trackedMind }) }));
        for (let g = 0; g < G; g++) {
          for (const p of per) {
            for (let t = 0; t < TPG; t++) api.stepTick(p.world, rng);
            api.advanceGeneration(p.world, rng);
            p.obs.observe(p.world);
          }
        }
        for (const p of per) (by[p.world.profileId] ||= []).push(p);
      }
      res = C.checkDivergence(by);
    } else {
      const runs = [];
      const gens = c.run === 'freq' ? 420 : G;
      for (let i = 0; i < S; i++) {
        runs.push(runWorld(api, {
          seed: 5150 + i * 7907, gens, trackedMind,
          answers: { sabotage: c.sabotage }, collectViolations: false,
        }));
      }
      res = c.expect === 'linkage' ? C.checkLinkage(runs)
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
const BADGE = { PASS: '✅ PASS', FAIL: '❌ FAIL', WARN: '⚠️ WARN', SKIP: '⏭ SKIP' };

function renderReport(d) {
  const { sim, conf, batch, allV, aborted, det, distinct, freq, byProfile, opponents,
          closed, open, recovery, checks, selftest, api } = d;
  const L = [];
  const P = s => L.push(s);

  P('# 増殖 — ヘッドレス検証レポート');
  P('');
  P('`node test/run.js` が生成。**このファイルは手で編集しない。**');
  P('');
  P(`- 検査対象 sim: **${sim.impl}**${sim.isReal ? '' : '　← `src/sim/` がまだ無いので `test/fake-sim.js`（代替実装）を検査している'}`);
  if (!sim.isReal) {
    P('');
    P('  > **重要**: 以下の「PASS」は代替実装が設計どおりに書かれていることしか示さない。');
    P('  > 本物の `src/sim/` が生えたら sim-adapter が自動でそちらに切り替わり、同じ検査が本番の実装にかかる。');
    P('  > 価値があるのはそのときで、いまは「何を測るか」を確定させている段階。');
  }
  if (sim.missing.length) {
    P(`- 未実装のAPI（fake で代替中）: \`${sim.missing.join('`, `')}\``);
  }
  P(`- 実行パラメータ: 不変条件 ${conf.seeds}種×${conf.gens}世代 / 頻度依存 ${conf.freqSeeds}種×${conf.freqGens}世代 / ロスター ${conf.rosterSeeds}種×${conf.rosterGens}世代 / 近親交配 ${conf.inbreedSeeds}種×${conf.inbreedGens}世代`);
  P('');

  // ---- サマリ ----
  P('## サマリ');
  P('');
  const invOk = allV.ok && aborted.length === 0;
  const detOk = det.every(x => x.ok);
  P('| | 検査 | 結果 |');
  P('|---|---|---|');
  P(`| AAA-1 | 決定性（同じ種＝同じ歴史） | ${BADGE[detOk ? 'PASS' : 'FAIL']} |`);
  P(`| AAA-2 | 不変条件（NaN・無限ループ・人口爆発・即死） | ${BADGE[invOk ? 'PASS' : 'FAIL']} |`);
  const idToAAA = { frequency: 'AAA-3', linkage: 'AAA-4', recessive: 'AAA-5', chronicle: 'AAA-6' };
  for (const c of checks) P(`| ${idToAAA[c.id] ?? '—'} | ${c.title} | ${BADGE[c.status]} |`);
  P('');
  const fails = checks.filter(c => c.status === 'FAIL');
  const skips = checks.filter(c => c.status === 'SKIP');
  if (fails.length) {
    P('### 実測で否定された主張');
    P('');
    for (const c of fails) P(`- **${c.title}** — ${c.summary}`);
    P('');
  }
  if (skips.length) {
    P('### 測れなかった主張（sim が必要な情報を出していない）');
    P('');
    for (const c of skips) P(`- **${c.title}** — ${c.summary}`);
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
  if (allV.ok) P('違反 **0件**。NaN / Infinity / 負の人口 / 負の食料 / 0..1 逸脱 / 死者の混入 / 血統比の破れ、いずれも検出されず。');
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
