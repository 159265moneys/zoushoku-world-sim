// sim-adapter.js — 検査対象の sim を1つに固定して返す。
//
// 【鉄則】本物と代替実装を混ぜない。
//   混ぜると「fake の createRoster が作った世界」に「本物の advanceGeneration」を掛ける
//   ような不整合が起きて、テストが sim のバグではなく自分のバグを報告する。
//   本物に無い関数は null のまま返し、ランナー側でその検査を SKIP する。

import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as fake from './fake-sim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM_DIR = join(HERE, '..', 'src', 'sim');

// これが無ければ世界を1世代も回せない
export const REQUIRED = ['createWorld', 'stepTick', 'advanceGeneration'];

// あれば対応する検査が走る。無ければその検査は SKIP。
export const OPTIONAL = [
  'assignRole', 'setDistrict', 'appointBureau', 'setCard', 'search', 'chronicle',
  'petitions', 'resolvePetition', 'makeGhost', 'startWar', 'stepBattle', 'runBattle',
  'surrender', 'settleWar', 'applyRout', 'selectDeployment',
  'captiveOptions', 'takeCaptives', 'borderDecision', 'publicRank',
  'purge', 'kill', 'traceUp', 'traceDown', 'recomputeAggregates',
  'createRoster', 'advanceRoster', 'listOpponents', 'peek',
  // 遺伝子型を読むために使う（無ければ observer が hap を直接読む）
  'phenotype', 'carriers', 'recessiveHomo', 'homozygosity',
];

// index.js が壊れているときに個別に拾うモジュール群
const SUBMODULES = [
  'world.js', 'battle.js', 'cards.js', 'chronicle.js',
  'petitions.js', 'derive.js', 'genetics.js', 'roster.js', 'rival.js',
];

async function loadReal() {
  if (!existsSync(SIM_DIR)) return { ok: false, why: 'src/sim/ が存在しない' };
  const notes = [];
  // 1. まず公開API（index.js）
  const idx = join(SIM_DIR, 'index.js');
  if (existsSync(idx)) {
    try {
      const mod = await import(pathToFileURL(idx).href);
      if (REQUIRED.every(k => typeof mod[k] === 'function')) {
        return { ok: true, mod, from: 'src/sim/index.js', notes };
      }
      notes.push('index.js は読めたが createWorld/stepTick/advanceGeneration が揃っていない');
    } catch (e) {
      notes.push(`index.js が読み込めない: ${e.message}`);
    }
  }
  // 2. index.js が壊れているので個別モジュールから組み立てる
  const merged = {};
  for (const f of SUBMODULES) {
    const p = join(SIM_DIR, f);
    if (!existsSync(p)) continue;
    try {
      const m = await import(pathToFileURL(p).href);
      for (const [k, v] of Object.entries(m)) if (merged[k] === undefined) merged[k] = v;
    } catch (e) {
      notes.push(`${f} が読み込めない: ${e.message}`);
    }
  }
  if (REQUIRED.every(k => typeof merged[k] === 'function')) {
    return { ok: true, mod: merged, from: 'src/sim/*.js（index.js が壊れているため個別 import）', notes };
  }
  notes.push(`必須API不足: ${REQUIRED.filter(k => typeof merged[k] !== 'function').join(', ')}`);
  return { ok: false, why: notes.join(' / '), notes };
}

function pack(mod, label, from, notes) {
  const api = {};
  for (const k of [...REQUIRED, ...OPTIONAL]) api[k] = typeof mod[k] === 'function' ? mod[k] : null;
  const missing = OPTIONAL.filter(k => !api[k]);
  api.TICKS_PER_GEN = mod.SIM_CONST?.TICKS_PER_GEN ?? mod.TICKS_PER_GEN ?? 12;
  api.LUCK_SHARE = mod.SIM_CONST?.LUCK_SHARE ?? mod.LUCK_SHARE ?? 0.10;
  api.PROFILES = mod.PROFILES ?? mod.RIVAL_PROFILES ?? null;
  // 対抗アーム予算から意図的に外している染色体。連鎖の検査がここを除外して数える。
  api.ARM_EXEMPT = mod.SIM_CONST?.ARM_EXEMPT ?? mod.ARM_EXEMPT ?? new Set();
  api.TRACKED_MIND = mod.TRACKED_MIND ?? null;
  api.__mod = mod;
  return { api, impl: label, from, missing, notes: notes ?? [] };
}

/**
 * @param {'auto'|'real'|'fake'} want
 * @returns {{api, impl, from, missing, notes, isReal, error}}
 */
export async function loadSim(want = 'auto') {
  if (want === 'fake') {
    const p = pack(fake, 'test/fake-sim.js（参照実装）', 'test/fake-sim.js', []);
    return { ...p, isReal: false, error: null };
  }
  const real = await loadReal();
  if (real.ok) {
    const p = pack(real.mod, 'src/sim', real.from, real.notes);
    return { ...p, isReal: true, error: null };
  }
  if (want === 'real') {
    return { api: null, impl: 'src/sim', from: null, missing: [], notes: real.notes ?? [], isReal: true, error: real.why };
  }
  const p = pack(fake, 'test/fake-sim.js（参照実装）', 'test/fake-sim.js', [`src/sim を使えなかった: ${real.why}`]);
  return { ...p, isReal: false, error: real.why };
}
