// ============================================================================
// integration.js — UI と sim の「継ぎ目」を検査する。
//
// なぜ要るか：
//   sim単体は13項目通り、UI単体も動いていたのに、繋いだ瞬間に毎フレーム落ちた。
//     index.html?sim=sim → TypeError: people is not iterable
//   原因は mock にしか無いヘルパーを UI が呼んでいたこと。
//   `src/ui/api.js` の Proxy は **本物に無い名前を黙って mock で埋める**ので、
//   mock の関数が本物の world を受け取り、そこで初めて壊れる。
//   単体テストが両側とも緑のまま、この穴を1つも検出できなかった。
//
// ここでやること：
//   A. UI が呼んでいる `api.*` の名前を機械的に集め、本物の sim に在るか調べる。
//      **mock で埋まる名前が1つでもあれば落とす。** それが上のクラッシュの正体。
//   B. UI が辿る導線（世界を作る→進める→読む→戦う→捕虜→国境）をブラウザなしで1周する。
//      呼べるだけでなく、例外を出さずに返ることまで見る。
//
// src/ui/ は読むだけ。書き換えない。
// ============================================================================

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { RNG } from '../src/core/rng.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, '..', 'src', 'ui');

// api.js 自身と mock.js は「呼ぶ側」ではないので走査から外す
const SKIP = new Set(['api.js', 'mock.js']);

function uiSourceFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js') && !SKIP.has(f.name)) out.push(p);
    }
  };
  walk(UI_DIR);
  return out;
}

/** UI のソースから `api.なんとか` を全部拾う。 */
export function collectApiSymbols() {
  const uses = new Map();   // name -> [ファイル…]
  for (const file of uiSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    // `from './api.js'` のようなパスを拾わないよう、直前の文字を見て弾く。
    for (const m of src.matchAll(/(?<![\w$./'"`])api\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = m[1];
      if (name === 'js') continue;                     // 念のため
      if (!uses.has(name)) uses.set(name, new Set());
      uses.get(name).add(file.replace(join(HERE, '..') + '/', ''));
    }
  }
  return uses;
}

/**
 * api.js の ALIAS 表を**ソースから**読む（旧方式）。
 * テストが自前に持つとズレるので、必ず本物の表を見る。
 * 現行の api.js は ALIAS ではなく adapter.js の makeAdapter() を使うので、
 * その場合ここは空を返し、解決は bridge 側が担う。
 */
export function readAliasTable() {
  const p = join(UI_DIR, 'api.js');
  if (!existsSync(p)) return {};
  const src = readFileSync(p, 'utf8');
  const block = src.match(/const\s+ALIAS\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (!block) return {};
  const alias = {};
  for (const m of block[1].matchAll(/['"]?([A-Za-z_$][A-Za-z0-9_$]*)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    alias[m[1]] = m[2];
  }
  return alias;
}

/**
 * api.js が「本物の名前をどうやって解決しているか」を読み取る。
 * ここを決め打ちにすると、UI 側が仕組みを変えた瞬間にテストが嘘をつく
 * （実際 ALIAS 表 → adapter.js の bridge に変わって、4件の偽 FAIL が出た）。
 * 読み取れなかったときは黙って通さず、その旨を返して検査を赤くする。
 */
export async function resolveStrategy(realMod) {
  const p = join(UI_DIR, 'api.js');
  const src = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const alias = readAliasTable();
  let bridge = null, bridgeError = null;
  const usesAdapter = /makeAdapter\s*\(/.test(src);

  if (usesAdapter && realMod) {
    try {
      const mod = await import(pathToFileURL(join(UI_DIR, 'adapter.js')).href);
      if (typeof mod.makeAdapter !== 'function') throw new Error('adapter.js に makeAdapter が無い');
      bridge = mod.makeAdapter(realMod);
      if (!bridge || typeof bridge !== 'object') throw new Error('makeAdapter が object を返さない');
    } catch (e) {
      bridgeError = e?.message ?? String(e);
    }
  }
  return {
    usesAdapter, bridge, bridgeError,
    alias, hasAlias: Object.keys(alias).length > 0,
    // 再現できているか。false なら「UIの解決順を写せていない」ので検査結果は信用できない。
    faithful: usesAdapter ? !!bridge : true,
  };
}

// ---------------------------------------------------------------------------
// A. 名前の突き合わせ
// ---------------------------------------------------------------------------
export async function auditSymbols(realMod, strat, mock) {
  const uses = collectApiSymbols();
  const { bridge, alias } = strat;

  const rows = [];
  for (const [name, files] of [...uses].sort((a, b) => a[0].localeCompare(b[0]))) {
    const viaBridge = !!(bridge && name in bridge && bridge[name] !== undefined);
    const viaDirect = !viaBridge && realMod && name in realMod && realMod[name] !== undefined;
    const aliasName = alias[name];
    const viaAlias = !viaBridge && !viaDirect && realMod && aliasName
      && aliasName in realMod && realMod[aliasName] !== undefined;
    const inMock = !!(mock && name in mock && mock[name] !== undefined);

    let status;
    if (viaBridge) status = 'bridge';          // adapter.js が形ごと写している
    else if (viaDirect) status = 'ok';
    else if (viaAlias) status = 'alias';
    else if (inMock) status = 'mock-filled';   // ← これが毎フレーム落ちの正体
    else status = 'missing';

    rows.push({
      name, status, alias: viaAlias ? aliasName : (aliasName ?? null),
      inMock, files: [...files].sort(),
    });
  }
  return { rows, aliasTable: alias, mockLoaded: !!mock };
}

/**
 * `src/ui/api.js` の Proxy と**同じ解決順**を再現する。
 *   本物の名前 → ALIAS 経由の本物 → mock で穴埋め
 *
 * ここを手抜きして sim を直接叩くと、UI が実際に通る道とは別の道を検査してしまう。
 * 「毎フレーム落ちる」の正体は mock 穴埋めなので、同じ順で解決しないと再現できない。
 * どの名前が mock で埋まったかを usedMock に記録する（動的な証拠）。
 */
export function makeUiApi(realMod, strat, mock) {
  const usedMock = new Set();
  const { bridge, alias } = strat;
  const resolve = (k) => {
    if (bridge && k in bridge && bridge[k] !== undefined) return bridge[k];
    if (realMod) {
      if (k in realMod && realMod[k] !== undefined) return realMod[k];
      const a = alias[k];
      if (a && a in realMod && realMod[a] !== undefined) return realMod[a];
    }
    if (mock && k in mock && mock[k] !== undefined) {
      if (realMod) usedMock.add(k);
      return mock[k];
    }
    return undefined;
  };
  const proxy = new Proxy({}, {
    get(_, k) { return typeof k === 'string' ? resolve(k) : undefined; },
    has(_, k) { return typeof k === 'string' && resolve(k) !== undefined; },
  });
  return { proxy, usedMock };
}

// ---------------------------------------------------------------------------
// B. 導線のヘッドレス一周
//
// 引数の形は src/ui/ の実際の呼び出し箇所から写している。
// 「呼べる」だけでなく「UIが渡す形で呼んでも壊れない」ことを見るのが目的。
// ---------------------------------------------------------------------------
export function walkthrough(api, opts = {}) {
  const seed = opts.seed ?? 20250819;
  const gens = opts.gens ?? 20;
  const steps = [];
  const rng = new RNG((seed ^ 0x5bf03635) >>> 0);
  let world = null, roster = null, battle = null;

  // 1手を実行して、例外・返り値の異常をその場で記録する。
  // 途中で落ちても続行する（1つ目の欠落で残り全部が見えなくなるのを避ける）。
  const step = (label, fn, opt = {}) => {
    const rec = { label, status: 'skip', note: '' };
    steps.push(rec);
    if (opt.needs && opt.needs.some(x => !x)) { rec.note = '前段が失敗したので実行できない'; return undefined; }
    const fname = label.split('(')[0].trim();
    if (typeof api[fname] !== 'function' && opt.fn === undefined && !opt.raw) {
      rec.status = 'missing'; rec.note = `api.${fname} が関数でない`;
      return undefined;
    }
    try {
      const v = fn();
      if (opt.expect) {
        const bad = opt.expect(v);
        if (bad) { rec.status = 'bad'; rec.note = bad; return v; }
      }
      rec.status = 'ok';
      rec.note = opt.describe ? opt.describe(v) : '';
      return v;
    } catch (e) {
      rec.status = 'threw';
      rec.note = `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`;
      rec.stack = String(e?.stack ?? '').split('\n').slice(1, 3).map(s => s.trim()).join(' / ');
      return undefined;
    }
  };

  // --- 開幕：性格診断の回答から世界を作る（opening.js の導線）---
  const answers = [];
  for (let i = 0; i < 12; i++) answers.push(rng.next());
  world = step('createWorld(SEED, answers, {name})',
    () => api.createWorld(seed, answers, { name: '我らのシャーレ' }),
    { expect: w => (!w || !w.people) ? 'world か world.people が返ってこない' : null,
      describe: w => `人口 ${w.people.size}` });

  // --- 方針カード（policy.js）---
  step('setCard(world, id, on, value)',
    () => { const cards = api.CARDS ?? []; const c = cards[0];
            return c ? api.setCard(world, c.id, true, c.def ?? 0) : api.setCard(world, 'mix_policy', true, 100); },
    { needs: [world] });

  // --- 時間を進める（main.js のループ）---
  step(`stepTick/advanceGeneration × ${gens}世代`, () => {
    const TPG = api.TICKS_PER_GEN ?? 12;
    for (let g = 0; g < gens; g++) {
      for (let t = 0; t < TPG; t++) api.stepTick(world, rng);
      api.advanceGeneration(world, rng);
      if (!world.people.size) break;
    }
    return world;
  }, { needs: [world], raw: true,
       expect: w => w.people.size === 0 ? '12世代で絶滅した（UIが表示するものが無くなる）' : null,
       describe: w => `第${w.gen}世代 人口 ${w.people.size}` });

  const anyone = world && world.people.size ? [...world.people.values()][0] : null;

  // --- 配役・居住区・任命（roles.js）---
  step('assignRole(world, id, role)', () => api.assignRole(world, anyone.id, anyone.role), { needs: [world, anyone] });
  step('setDistrict(world, id, district)', () => api.setDistrict(world, anyone.id, 'frontier'), { needs: [world, anyone] });
  step('appointBureau(world, key, id) ×3局', () => {
    const adults = [...world.people.values()].filter(p => p.age >= 2);
    const keys = ['military', 'agri', 'civil'];
    let out = null;
    for (let i = 0; i < keys.length && i < adults.length; i++) out = api.appointBureau(world, keys[i], adults[i].id);
    return out;
  }, { needs: [world, anyone], raw: true,
       describe: () => `局長 ${Object.values(world.bureaus ?? {}).filter(Boolean).length}名` });

  // --- 読む（search.js / inspector.js）---
  step('search(world, filters)',
    () => api.search(world, { geneMin: 0.2 }),
    { needs: [world],
      expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）`,
      describe: v => `${v.length}件` });
  step('powerOf(ind)',
    () => api.powerOf(anyone),
    { needs: [world, anyone],
      expect: v => Number.isFinite(v) ? null : `数値が返らない（${v}）` });
  step('publicRank(world, ind)', () => api.publicRank(world, anyone), { needs: [world, anyone] });
  step('nationPower(world)',
    () => api.nationPower(world),
    { needs: [world],
      // UI は world を渡すが、本物は people を取る実装かもしれない。
      // 落ちなくても NaN/undefined が返れば画面には壊れた数字が出る。
      expect: v => (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)))
        ? `UI は world を渡しているのに ${v} が返る（本物の引数は people ではないか）` : null,
      describe: v => `= ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v}` });

  // --- 年代記（chronicle.js）---
  const evs = step('chronicle(world, {genMin, kinds, limit})',
    () => api.chronicle(world, { genMin: 0, kinds: ['粛清', '一揆', '死亡', '出生'], limit: 40 }),
    { needs: [world],
      expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）`,
      describe: v => `${v.length}件` });
  const ev = evs && evs.length ? evs[0] : null;
  step('traceUp(world, eventId)', () => api.traceUp(world, ev.id), { needs: [world, ev],
    expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）` });
  step('traceDown(world, eventId)', () => api.traceDown(world, ev.id), { needs: [world, ev],
    expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）` });
  step('canonize(world, eventId, text, {truthful})',
    () => api.canonize(world, ev.id, '調査の結果、責任は内側にあった', { truthful: true }),
    { needs: [world, ev] });

  // --- 具申（petitions.js）---
  const pets = step('petitions(world, rng)',
    () => api.petitions(world, rng),
    { needs: [world],
      expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）`,
      describe: v => `${v.length}件` });
  const pet = pets && pets.length ? pets[0] : null;
  step('resolvePetition(world, id, approve, rng)',
    () => api.resolvePetition(world, pet.id, true, rng), { needs: [world, pet] });

  // --- ロスター（opponents.js）---
  roster = step('createRoster(SEED)', () => api.createRoster(seed),
    { expect: r => (!r || !(r.nations ?? r.worlds)) ? 'nations も worlds も無い' : null,
      describe: r => `${(r.nations ?? r.worlds).length}カ国` });
  step('stepRoster(roster, rng)', () => api.stepRoster(roster, rng, 1), { needs: [roster] });
  const opps = step('listOpponents(roster)', () => api.listOpponents(roster),
    { needs: [roster],
      expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）`,
      describe: v => `${v.length}件` });
  const opp = opps && opps.length ? opps[0] : null;
  step('peek(roster, id)', () => api.peek(roster, opp.id ?? opp), { needs: [roster, opp] });

  // --- 戦争（battle.js）---
  // 戦闘は adapter が形を写している（sim: battle.sides.home/away.units、UI: battle.a/.b.fighters）。
  // UI 側の形で受け取れることを確かめる。どちらの形でも通るようにしておく。
  const sideCounts = b => {
    if (!b) return null;
    if (b.sides?.home?.units && b.sides?.away?.units) return [b.sides.home.units.length, b.sides.away.units.length];
    if (b.a?.fighters && b.b?.fighters) return [b.a.fighters.length, b.b.fighters.length];
    return null;
  };
  battle = step('startWar(world, rng, opponent)', () => {
    const enemy = api.makeGhost ? api.makeGhost((seed ^ 0x1234) >>> 0, world.phase ?? 1, 1) : opp;
    return api.startWar(world, rng, enemy);
  }, { needs: [world],
       expect: b => !b ? 'battle が返ってこない'
         : !sideCounts(b) ? 'battle に両軍が入っていない（sides.home/away.units も a/b.fighters も無い）' : null,
       describe: b => { const c = sideCounts(b); return `${c[0]}対${c[1]}`; } });
  step('stepBattle(battle, rng) を決着まで', () => {
    let guard = 400;
    while (battle && !battle.over && guard-- > 0) api.stepBattle(battle, rng);
    if (guard <= 0) throw new Error('400ラウンド回っても決着しない（UIは固まる）');
    return battle;
  }, { needs: [battle], raw: true,
       describe: b => `${b.round ?? b.rounds ?? '?'}ラウンドで ${b.outcome?.kind ?? b.result ?? '決着'}` });
  step('captiveOptions(battle)', () => api.captiveOptions(battle), { needs: [battle] });
  step('settleWar(world, battle)', () => api.settleWar(world, battle, rng), { needs: [world, battle] });
  const caps = step("takeCaptives(world, battle, axis, rng)",
    () => api.takeCaptives(world, battle, '総合', rng),
    { needs: [world, battle],
      expect: v => Array.isArray(v) ? null : `配列が返らない（${typeof v}）`,
      describe: v => `${v.length}名` });
  step("borderDecision(world, captiveId, 'accept')",
    () => api.borderDecision(world, caps[0].id, 'accept'), { needs: [world, caps && caps.length ? caps[0] : null] });

  // --- 戦後もう1世代回して、捕虜を入れた世界が壊れていないか見る ---
  step('戦後に1世代進める', () => {
    const TPG = api.TICKS_PER_GEN ?? 12;
    for (let t = 0; t < TPG; t++) api.stepTick(world, rng);
    api.advanceGeneration(world, rng);
    for (const p of world.people.values()) {
      for (const k of Object.keys(p.genes ?? {})) {
        if (!Number.isFinite(p.genes[k])) throw new Error(`#${p.id} の遺伝子 ${k} が ${p.genes[k]}`);
      }
    }
    return world;
  }, { needs: [world], raw: true, describe: w => `第${w.gen}世代 人口 ${w.people.size}` });

  return { steps, world, roster, battle };
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------
export async function runIntegration(sim, opts = {}) {
  const realMod = sim.isReal ? sim.api.__mod : null;
  let mock = null;
  try { mock = await import(pathToFileURL(join(UI_DIR, 'mock.js')).href); } catch { mock = null; }

  // UI が名前をどう解決しているかを api.js から読み取る。
  const strat = await resolveStrategy(realMod);
  const audit = await auditSymbols(realMod, strat, mock);

  // 導線は必ず「UI が通るのと同じ解決順」で叩く。sim を直接叩いてはいけない。
  const { proxy: uiApi, usedMock } = makeUiApi(realMod, strat, mock);
  const walk = walkthrough(uiApi, opts);
  walk.usedMock = [...usedMock];

  const filled = audit.rows.filter(r => r.status === 'mock-filled');
  const missing = audit.rows.filter(r => r.status === 'missing');
  const threw = walk.steps.filter(s => s.status === 'threw');
  const bad = walk.steps.filter(s => s.status === 'bad');
  const gone = walk.steps.filter(s => s.status === 'missing');

  let status = 'PASS';
  if (filled.length || missing.length || threw.length || gone.length) status = 'FAIL';
  else if (bad.length) status = 'WARN';

  // UI の解決順を写せていないなら、この検査の結果自体が信用できない。
  // 黙って PASS にすると「継ぎ目を見ている」という嘘が残るので、必ず赤くする。
  if (!strat.faithful) {
    return {
      status: 'FAIL',
      summary: `**この検査が UI の解決順を再現できていない**。\`src/ui/api.js\` は \`makeAdapter()\` を使っているが、`
        + `\`src/ui/adapter.js\` を読み込めなかった（${strat.bridgeError}）。`
        + `継ぎ目を検査できていないので、下の結果は当てにならない。まず test/integration.js の resolveStrategy() を直すこと。`,
      audit, walk, strat, counts: { filled: 0, missing: 0, threw: 0, bad: 0, gone: 0, unfaithful: 1 },
    };
  }

  const parts = [];
  if (missing.length) parts.push(`UI が呼ぶ ${missing.length}個の名前が sim にも mock にも無い（呼んだ瞬間 undefined）`);
  if (filled.length) parts.push(`**${filled.length}個が mock で埋まっている**（本物の world を mock の関数が受け取る＝ブラウザで即クラッシュ）`);
  if (gone.length) parts.push(`導線の ${gone.length}手が関数として存在しない`);
  if (threw.length) parts.push(`導線の ${threw.length}手が例外を投げた`);
  if (bad.length) parts.push(`導線の ${bad.length}手が想定外の値を返した`);

  const summary = status === 'PASS'
    ? `UI が呼ぶ ${audit.rows.length}個の名前すべてが本物の sim で解決し、開幕→${opts.gens ?? 12}世代→検索→年代記→具申→ロスター→開戦→捕虜→国境 の${walk.steps.length}手すべてが例外なく通った。`
    : parts.join('。') + '。';

  return { status, summary, audit, walk, strat, counts: { filled: filled.length, missing: missing.length, threw: threw.length, bad: bad.length, gone: gone.length } };
}

/**
 * この検査が空振りでないことの証明。
 *
 * 「mock にしか無い名前を UI が呼んだら赤くなる」——それが元のクラッシュの正体なので、
 * 実際に mock 専用の名前を分類器に通して mock-filled と判定されるかを確かめる。
 * ここが通らないなら、この検査は次の同じ事故も見逃す。
 */
export async function selfCheckIntegration(sim) {
  const realMod = sim.isReal ? sim.api.__mod : null;
  if (!realMod) return { ok: null, note: '本物の sim が無いので確認できない' };
  let mock = null;
  try { mock = await import(pathToFileURL(join(UI_DIR, 'mock.js')).href); } catch { mock = null; }
  if (!mock) return { ok: null, note: 'mock.js を読めない' };

  const strat = await resolveStrategy(realMod);
  const { bridge, alias } = strat;
  const classify = (name) => {
    if (bridge && name in bridge && bridge[name] !== undefined) return 'bridge';
    if (name in realMod && realMod[name] !== undefined) return 'ok';
    const a = alias[name];
    if (a && a in realMod && realMod[a] !== undefined) return 'alias';
    if (name in mock && mock[name] !== undefined) return 'mock-filled';
    return 'missing';
  };

  // mock にしか無い名前（＝UI が呼んだ瞬間に本物の world を mock に渡す地雷）
  const canaries = Object.keys(mock).filter(k => classify(k) === 'mock-filled');
  // 存在しない名前は missing になること
  const missingOk = classify('__絶対に存在しない名前__') === 'missing';

  return {
    ok: canaries.length > 0 && missingOk,
    canaries,
    missingOk,
    note: canaries.length
      ? `mock 専用の ${canaries.length}個（${canaries.slice(0, 6).join(', ')}）を mock-filled として検出できる`
      : 'mock 専用の名前が1つも無いため、この方法では確認できない（mock と本物の差が消えた）',
  };
}

/** レポート用の本文。 */
export function renderIntegration(res) {
  const L = [];
  const mark = { ok: '✅', alias: '✅', bridge: '✅', 'mock-filled': '❌', missing: '❌' };
  const smark = { ok: '✅', threw: '❌', missing: '❌', bad: '⚠️', skip: '⏭' };

  L.push('### A. UI が呼ぶ名前が本物の sim にあるか');
  L.push('');
  const how = res.strat?.usesAdapter
    ? '`src/ui/adapter.js` の `makeAdapter(sim)` → 本物の sim → mock'
    : (res.strat?.hasAlias ? '本物の sim → `api.js` の ALIAS 表 → mock' : '本物の sim → mock');
  L.push('`src/ui/**/*.js` から `api.*` を機械的に集め、**UI と同じ解決順**で本物の sim に突き合わせる。');
  L.push('');
  L.push(`解決順: ${how}`);
  L.push('');
  L.push('> `api.js` の Proxy は**本物に無い名前を黙って mock で埋める**。');
  L.push('> 埋まった関数は本物の world を渡されて初めて壊れるので、起動するまで誰も気づかない。');
  L.push('> ここで ❌ が出たら、それはブラウザで確実に落ちるという意味。');
  L.push('');
  const bad = res.audit.rows.filter(r => r.status === 'mock-filled' || r.status === 'missing');
  if (bad.length) {
    L.push('| 名前 | 状態 | 呼んでいる場所 |');
    L.push('|---|---|---|');
    for (const r of bad) {
      const why = r.status === 'mock-filled' ? 'mock で埋まる（本物に無い）' : 'sim にも mock にも無い';
      L.push(`| \`api.${r.name}\` | ${mark[r.status]} ${why} | ${r.files.map(f => `\`${f}\``).join(' ')} |`);
    }
    L.push('');
  } else {
    L.push(`UI が呼ぶ **${res.audit.rows.length}個**の名前はすべて本物の sim で解決する（mock で埋まっているものは0個）。`);
    L.push('');
  }
  const bridged = res.audit.rows.filter(r => r.status === 'bridge');
  if (bridged.length) {
    L.push(`\`src/ui/adapter.js\` が形ごと写しているもの（${bridged.length}件）: `
      + bridged.map(r => `\`${r.name}\``).join('・'));
    L.push('');
  }
  const aliased = res.audit.rows.filter(r => r.status === 'alias');
  if (aliased.length) {
    L.push('別名で解決しているもの（`api.js` の ALIAS 経由）:');
    L.push('');
    for (const r of aliased) L.push(`- \`api.${r.name}\` → \`sim.${r.alias}\``);
    L.push('');
  }
  if (res.walk.usedMock?.length) {
    L.push(`導線を1周する間に**実際に mock へ落ちた**名前: ${res.walk.usedMock.map(n => `\`${n}\``).join('・')}`);
    L.push('');
  }

  L.push('### B. UI の導線をブラウザなしで1周');
  L.push('');
  L.push('| | 手 | 結果 |');
  L.push('|---|---|---|');
  for (const s of res.walk.steps) {
    L.push(`| ${smark[s.status] ?? '?'} | \`${s.label}\` | ${s.note || s.status} |`);
  }
  L.push('');
  const problems = res.walk.steps.filter(s => s.status === 'threw');
  if (problems.length) {
    L.push('例外の出どころ:');
    L.push('```');
    for (const s of problems) L.push(`${s.label}\n  ${s.note}\n  ${s.stack ?? ''}`);
    L.push('```');
    L.push('');
  }
  return L.join('\n');
}
