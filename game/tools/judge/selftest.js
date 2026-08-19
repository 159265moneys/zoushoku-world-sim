// 判定器そのものの試験。
//
// なぜ要るか：本番で「支配戦略なし」と出たとき、それが**本当に無い**のか
// **判定器が見つけられないだけ**なのかを区別する手段が他に無い。
// 正解を仕込んだ3つの世界を食わせて、判定器が正解を答えられることを先に示す。
//
//   plural   … 3つの型があり相手ごとに最良が入れ替わる → 支配戦略なし / 型が複数 / 相手依存
//   dominant … 1本が全相手で最良                      → 支配戦略あり / 相手依存なし
//   noise    … 方針がほぼ効かない                      → 上達の定規が無い
//
//   node tools/judge/selftest.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './run.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CASES = [
  {
    world: 'plural',
    want: {
      q1: (v) => v === 'NONE' || v === 'MULTI_UNIVERSAL',
      q1desc: '支配戦略なし（NONE か MULTI_UNIVERSAL）',
      q2: (n) => n >= 2, q2desc: '型が2本以上',
      q3: (v) => v === 'OPPONENT_DEPENDENT', q3desc: '相手依存',
      q4: (v) => v === 'CLEAR' || v === 'WEAK', q4desc: '上達が観測できる',
    },
  },
  {
    world: 'dominant',
    want: {
      q1: (v) => v === 'DOMINANT_TYPE' || v === 'DOMINANT_STRICT',
      q1desc: '支配戦略あり',
      q2: () => true, q2desc: '（不問）',
      q3: (v) => v === 'SAME_FOR_ALL' || v === 'INDISTINGUISHABLE_FROM_NOISE',
      q3desc: '相手依存なし',
      q4: (v) => v === 'CLEAR' || v === 'WEAK', q4desc: '上達が観測できる',
    },
  },
  {
    world: 'noise',
    want: {
      q1: (v) => v === 'NO_SIGNAL', q1desc: '判定不能と自己申告する',
      q2: () => true, q2desc: '（不問）',
      q3: (v) => v !== 'OPPONENT_DEPENDENT', q3desc: '相手依存を誤検出しない',
      q4: (v) => v === 'NOT_OBSERVABLE', q4desc: '上達の定規が無いと判定',
    },
  },
];

const base = { seeds: 30, gens: 200, metric: 'winRate', random: 40, eliteCap: 32, cache: true, quiet: true, oat: false, best: '/nonexistent/best.json' };

let fail = 0;
const record = [];
for (const c of CASES) {
  process.stdout.write(`\n=== 世界: ${c.world} ===\n`);
  const t0 = Date.now();
  const ctx = await judge({ ...base, world: c.world });
  const got = { q1: ctx.q1.verdict, q2: ctx.q2.nTypes, q3: ctx.q3.verdict, q4: ctx.q4.verdict };
  const checks = [
    ['問1 支配戦略', c.want.q1desc, got.q1, c.want.q1(got.q1)],
    ['問2 型の数', c.want.q2desc, got.q2, c.want.q2(got.q2)],
    ['問3 相手依存', c.want.q3desc, got.q3, c.want.q3(got.q3)],
    ['問4 上達', c.want.q4desc, got.q4, c.want.q4(got.q4)],
  ];
  for (const [name, want, g, ok] of checks) {
    if (!ok) fail++;
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${name.padEnd(14)} 期待:${String(want).padEnd(30)} 実際:${g}\n`);
  }
  process.stdout.write(`  d=${ctx.q4.d.toFixed(2)}  型間/型内=${ctx.q2.wb.ratio.toFixed(2)}  相手間/ノイズ床=${ctx.q3.ratio.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  record.push({
    world: c.world,
    checks: checks.map(([name, want, g, ok]) => ({ name, want, got: String(g), ok })),
    d: ctx.q4.d, clusterRatio: ctx.q2.wb.ratio, oppRatio: ctx.q3.ratio,
  });
}

fs.writeFileSync(path.join(HERE, 'selftest-result.json'), JSON.stringify({
  stamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
  pass: fail === 0, fail, worlds: record,
}, null, 2));

process.stdout.write(fail === 0
  ? '\n判定器は3つの世界すべてで正解を出した。本番の結果を信用してよい。\n\n'
  : `\n**${fail}件の不一致。判定器が正解の分かっている世界で外している。本番の結果は信用できない。**\n\n`);
process.exitCode = fail === 0 ? 0 : 1;
