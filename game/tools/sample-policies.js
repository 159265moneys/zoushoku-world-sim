#!/usr/bin/env node
// tools/sample-policies.js — eval.js に食わせるランダムな方針セットを作る。
//
//   node tools/sample-policies.js --n 10 --seeds 10 --gens 200 --opponents martial,agrarian \
//     | node tools/eval.js > out.json
//
// 乱数は core/rng.js の RNG だけ（Math.random 禁止）。同じ --seed から同じ方針が出る。
// Python 側の動作確認・煙試験用。探索そのものは Python がやる。

import { RNG } from '../src/core/rng.js';
import { CARDS } from '../src/sim/index.js';
import { PROMOTE_IDS, BORDER_IDS, AXIS_IDS } from './eval.js';

function parse(argv) {
  const a = { n: 10, seeds: 10, gens: 200, opponents: ['ghost'], seed: 1, seedBase: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    const v = () => argv[++i];
    if (s === '--n') a.n = parseInt(v(), 10);
    else if (s === '--seeds') a.seeds = parseInt(v(), 10);
    else if (s === '--gens') a.gens = parseInt(v(), 10);
    else if (s === '--seed') a.seed = parseInt(v(), 10);
    else if (s === '--seed-base') a.seedBase = parseInt(v(), 10);
    else if (s === '--opponents') a.opponents = v().split(',').map((x) => x.trim()).filter(Boolean);
  }
  return a;
}

const a = parse(process.argv.slice(2));
const rng = new RNG(a.seed >>> 0 || 1);
const policies = [];
for (let i = 0; i < a.n; i++) {
  const cards = {};
  for (const c of CARDS) {
    const raw = c.min + rng.next() * (c.max - c.min);
    cards[c.id] = Math.round(raw / c.step) * c.step;
  }
  policies.push({
    id: `r${String(i).padStart(3, '0')}`,
    cards,
    captiveAxis: rng.pick(AXIS_IDS),
    border: rng.pick(BORDER_IDS),
    promote: rng.pick(PROMOTE_IDS),
    warAppetite: Math.round(rng.next() * 100) / 100,
  });
}
const seeds = [];
for (let i = 0; i < a.seeds; i++) seeds.push(a.seedBase + i);

process.stdout.write(JSON.stringify({ policies, seeds, gens: a.gens, opponents: a.opponents }) + '\n');
