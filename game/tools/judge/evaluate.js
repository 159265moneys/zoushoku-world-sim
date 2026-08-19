// 評価器への口。本番は tools/eval.js（別担当）を子プロセスで叩く。
// まだ無いあいだは --world=<mode> で「正解が分かっている偽の世界」に差し替えて
// 判定ロジック側を先に完成させる。偽物を使ったときは報告書の先頭にそう出る。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RNG } from '../../src/core/rng.js';
import { encode, distance, CARD_IDS, N_KNOBS, CARD_RANGE } from './space.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GAME_ROOT = path.resolve(HERE, '../..');
const CACHE_DIR = path.join(HERE, 'cache');

// ---------------------------------------------------------------- 成績の読み方

/**
 * 生の1行から「成績」を取り出す。
 *
 * 勝利条件は設計上「戦争で他オーナーの世界に勝つ」の一本なので winRate を主にする。
 * 一度も戦わなかった国は勝利条件を一度も満たしていないので 0 とする（中立の0.5に
 * すると、戦わないだけで中位に居座れてしまう）。この決めが結論を動かしていないかは
 * power / netWins で必ず突き合わせる。
 */
export const METRICS = {
  winRate: (r) => {
    if (r.extinct) return 0;
    const n = (r.wins ?? 0) + (r.losses ?? 0);
    return n > 0 ? r.wins / n : 0;
  },
  netWins: (r) => (r.extinct ? -5 : (r.wins ?? 0) - (r.losses ?? 0)),
  power: (r) => (r.extinct ? 0 : r.power ?? 0),
};
export const METRIC_NAMES = Object.keys(METRICS);

export function metricOf(row, name) {
  const f = METRICS[name];
  if (!f) throw new Error(`未知の指標: ${name}`);
  return f(row);
}

// ---------------------------------------------------------------- 本番の評価器

function evalScriptPath() {
  return path.join(GAME_ROOT, 'tools', 'eval.js');
}

export function hasRealEvaluator() {
  return fs.existsSync(evalScriptPath());
}

function runEvalOnce(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [evalScriptPath()], {
      cwd: GAME_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`eval.js がタイムアウト (${timeoutMs}ms)`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`eval.js が異常終了 (code=${code})\n${err.slice(0, 2000)}`));
      try {
        const j = JSON.parse(out);
        if (!j || !Array.isArray(j.results)) throw new Error('results 配列が無い');
        resolve(j.results);
      } catch (e) {
        reject(new Error(`eval.js の出力が契約と違う: ${e.message}\n先頭: ${out.slice(0, 400)}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// ------------------------------------------------------- 偽の世界（正解が既知）

/**
 * 判定器を先に完成させるためのダミー世界。3種類あって、**それぞれ正解が分かっている**。
 *
 *   plural   … 3つの型があり、相手ごとに最良が入れ替わる（＝設計の主張どおりの世界）
 *   dominant … 全相手で同じ1本が最良（＝設計の敗北。判定器はこれを見つけねばならない）
 *   noise    … 方針がほぼ効かない（＝上達の定規が無い世界）
 *
 * selftest.js がこの3つを判定器に食わせて、判定が正解と一致するか確かめる。
 * 「判定器が支配戦略を検出できること」を先に証明しておかないと、
 * 本番で「支配戦略なし」と出たときにそれが本物か測定不能かを区別できない。
 */
const ARCHETYPES = {
  A: { // 軍事速攻
    cards: { deploy_top: 90, drill: 45, hunt_ratio: 20, frontier: 80, mix_policy: 40,
             spare_old: 7, raise_young: 60, guards: 0, surrender_at: 0, stockpile: 10, ration_equal: 30, hereditary: 50 },
    captiveAxis: '武力', border: 'kill', promote: 'martial', warAppetite: 0.95,
  },
  B: { // 農本量産
    cards: { deploy_top: 15, drill: 5, hunt_ratio: 15, frontier: 10, mix_policy: 50,
             spare_old: 7, raise_young: 10, guards: 0, surrender_at: 60, stockpile: 55, ration_equal: 90, hereditary: 50 },
    captiveAxis: '繁殖性', border: 'accept', promote: 'fecund', warAppetite: 0.15,
  },
  C: { // 融和・混血
    cards: { deploy_top: 50, drill: 20, hunt_ratio: 35, frontier: 40, mix_policy: 100,
             spare_old: 7, raise_young: 30, guards: 0, surrender_at: 40, stockpile: 30, ration_equal: 70, hereditary: 0 },
    captiveAxis: '総合', border: 'accept', promote: 'melting', warAppetite: 0.5,
  },
};

// 効くつまみと効かないつまみを作り分ける。感度分析が「死んでいるカード」を
// 見分けられるかの試験になる。
const KNOB_WEIGHT = {
  deploy_top: 1.6, drill: 1.2, hunt_ratio: 1.0, frontier: 1.0, mix_policy: 1.4,
  spare_old: 0, raise_young: 0.15, guards: 0, surrender_at: 0.1,
  stockpile: 0.9, ration_equal: 0.2, hereditary: 0.2,
};

/** 重み付きの「型への近さ」。0（真逆）〜1（一致） */
function affinity(policy, arch) {
  let s = 0, wsum = 0;
  for (const id of CARD_IDS) {
    const r = CARD_RANGE[id];
    const w = KNOB_WEIGHT[id] ?? 0;
    if (!w) continue;
    const a = ((policy.cards?.[id] ?? r.def) - r.min) / (r.max - r.min);
    const b = ((arch.cards[id] ?? r.def) - r.min) / (r.max - r.min);
    s += w * (1 - Math.abs(a - b)); wsum += w;
  }
  // カテゴリ：promote と border は効く。captiveAxis は死にカードにしてある
  const catW = 1.5;
  s += catW * (policy.promote === arch.promote ? 1 : 0.35); wsum += catW;
  s += 0.8 * (policy.border === arch.border ? 1 : 0.5); wsum += 0.8;
  s += 1.2 * (1 - Math.abs((policy.warAppetite ?? 0.5) - arch.warAppetite)); wsum += 1.2;
  return s / wsum;
}

/** じゃんけん表：相手ごとに、どの型が効くか */
const COUNTER = {
  martial:  { A: 0.55, B: 0.75, C: 1.00 },
  terror:   { A: 0.60, B: 0.70, C: 1.00 },
  purist:   { A: 0.65, B: 0.72, C: 1.00 },
  agrarian: { A: 1.00, B: 0.60, C: 0.72 },
  fecund:   { A: 1.00, B: 0.55, C: 0.70 },
  laissez:  { A: 1.00, B: 0.68, C: 0.75 },
  melting:  { A: 0.72, B: 1.00, C: 0.62 },
  merit:    { A: 0.70, B: 1.00, C: 0.66 },
  dynastic: { A: 0.75, B: 1.00, C: 0.60 },
  pious:    { A: 0.68, B: 1.00, C: 0.64 },
};

function latentQuality(policy, opponent, mode) {
  if (mode === 'noise') return 0.05 * affinity(policy, ARCHETYPES.A);
  if (mode === 'dominant') {
    // 全相手で同じ1本（型A）が最良。相手による揺れはあるが順序は変わらない
    return 1.35 * affinity(policy, ARCHETYPES.A) + 0.15 * affinity(policy, ARCHETYPES.C);
  }
  // plural：3つの尾根の max。max なので谷が残り、上位が複数の島に割れる
  const w = COUNTER[opponent] ?? { A: 0.8, B: 0.8, C: 0.8 };
  return 1.5 * Math.max(
    w.A * affinity(policy, ARCHETYPES.A),
    w.B * affinity(policy, ARCHETYPES.B),
    w.C * affinity(policy, ARCHETYPES.C),
  );
}

/** 偽の1行を作る。種から決定的。 */
function fakeRow(policy, seed, opponent, gens, mode) {
  const h = createHash('sha1').update(`${policy.id}|${seed}|${opponent}|${mode}`).digest();
  const rng = new RNG(h.readUInt32LE(0));
  const q = latentQuality(policy, opponent, mode);
  const noiseSd = mode === 'noise' ? 0.30 : 0.22;
  const nBattles = 10;
  const p = Math.min(0.97, Math.max(0.03, 0.5 + 0.9 * (q - (mode === 'noise' ? 0.05 : 0.75)) + rng.normal(0, noiseSd) * 0.5));
  let wins = 0;
  for (let i = 0; i < nBattles; i++) if (rng.bool(p)) wins++;
  const extinct = rng.next() < Math.max(0, 0.10 - 0.09 * q);
  const pop = extinct ? 0 : Math.round(60 + 220 * q + rng.normal(0, 25));
  return {
    id: policy.id, seed, opponent, gens,
    power: extinct ? 0 : Math.round(pop * 0.55 + (0.3 + 0.5 * q) * pop * 1.4 + Math.max(0, 30 + 40 * q) * 2.2),
    pop, extinct, wins, losses: nBattles - wins,
    admixture: +(0.5 * (policy.cards?.mix_policy ?? 50) / 100 + rng.normal(0, 0.05)).toFixed(3),
    morale: +(0.4 + 0.3 * q + rng.normal(0, 0.06)).toFixed(3),
    regimeGrudge: +(0.4 - 0.2 * q + rng.normal(0, 0.05)).toFixed(3),
    yieldRate: +(30 + 40 * q + rng.normal(0, 4)).toFixed(1),
    _fake: true,
  };
}

// ------------------------------------------------------------------ 公開API

export function makeEvaluator({ world = 'real', gens = 200, cache = true, timeoutMs = 20 * 60_000, quiet = false } = {}) {
  const fake = world !== 'real';
  if (!fake && !hasRealEvaluator()) {
    throw new Error(
      'tools/eval.js が無い。本番評価は走らせられない。\n' +
      '  判定ロジックだけ確かめるなら --world=plural|dominant|noise を付ける。'
    );
  }
  if (cache && !fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  let calls = 0, rowsOut = 0, cacheHits = 0;

  return {
    fake, world, gens,
    stats: () => ({ calls, rows: rowsOut, cacheHits }),

    /** policies × seeds × opponents をまとめて評価して行の配列を返す */
    async run(policies, seeds, opponents) {
      if (!policies.length || !seeds.length || !opponents.length) return [];
      const out = [];
      // 1回のバッチが 6000 行を超えないように方針で刻む
      const perPolicy = seeds.length * opponents.length;
      const chunk = Math.max(1, Math.floor(6000 / Math.max(1, perPolicy)));

      for (let i = 0; i < policies.length; i += chunk) {
        const batch = policies.slice(i, i + chunk);
        const payload = { policies: batch, seeds, gens: this.gens, opponents };
        const key = createHash('sha1')
          .update(JSON.stringify({ world, payload })).digest('hex').slice(0, 20);
        const cf = path.join(CACHE_DIR, `${world}-${key}.json`);

        if (cache && fs.existsSync(cf)) {
          out.push(...JSON.parse(fs.readFileSync(cf, 'utf8')));
          cacheHits++;
          continue;
        }
        let rows;
        if (fake) {
          rows = [];
          for (const p of batch) for (const s of seeds) for (const o of opponents) {
            rows.push(fakeRow(p, s, o, this.gens, world));
          }
        } else {
          rows = await runEvalOnce(payload, timeoutMs);
        }
        calls++;
        if (cache) fs.writeFileSync(cf, JSON.stringify(rows));
        out.push(...rows);
        if (!quiet && !fake) {
          process.stderr.write(`  eval: ${Math.min(i + chunk, policies.length)}/${policies.length} 方針\n`);
        }
      }
      rowsOut += out.length;
      return out;
    },
  };
}

export { ARCHETYPES, KNOB_WEIGHT };
