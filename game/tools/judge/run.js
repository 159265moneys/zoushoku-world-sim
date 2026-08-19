// 判定器の入口。
//
//   node tools/judge/run.js                       # 本番（tools/eval.js と tools/search/best.json が要る）
//   node tools/judge/run.js --world=plural         # 判定ロジックだけをダミー世界で回す
//   node tools/judge/run.js --world=dominant --oat # 支配戦略が有る世界。感度分析まで出す
//
// 種の取り決め（探索担当へ）：
//   探索に使ってよい種は 1..8999。**9001以降は判定用のホールドアウトなので使わないこと。**
//   ここを守らないと「探索で選んだ方針を、選ぶのに使った種で採点する」ことになり、
//   上位方針の成績が丸ごと過適合になる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RNG, mean, cohenD } from './stats.js';
import { verifySpace, samplePolicy, CARD_IDS, CARD_RANGE, OPPONENTS, CAPTIVE_AXES, BORDERS, PROMOTES } from './space.js';
import { makeEvaluator, hasRealEvaluator, METRIC_NAMES, GAME_ROOT } from './evaluate.js';
import {
  buildTable, q1Dominance, q2WinLines, q3OpponentDependence, q4SkillGradient,
  globalSensitivity, oatSensitivity,
} from './questions.js';
import { renderReport } from './report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOLDOUT_BASE = 9001;
export const SEARCH_SEED_MAX = 8999;

function parseArgs(argv) {
  const o = {
    world: 'real', seeds: 30, gens: 200, metric: 'winRate', random: 40,
    best: path.join(GAME_ROOT, 'tools', 'search', 'best.json'),
    out: path.join(GAME_ROOT, 'tools', 'report-search.md'),
    oat: false, cache: true, quiet: false, eliteCap: 32,
    standIn: false, yes: false, maxMinutes: 30,
  };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'world') o.world = v;
    else if (k === 'seeds') o.seeds = +v;
    else if (k === 'gens') o.gens = +v;
    else if (k === 'metric') o.metric = v;
    else if (k === 'random') o.random = +v;
    else if (k === 'best') o.best = path.resolve(v);
    else if (k === 'out') o.out = path.resolve(v);
    else if (k === 'oat') o.oat = true;
    else if (k === 'no-cache') o.cache = false;
    else if (k === 'quiet') o.quiet = true;
    else if (k === 'elite-cap') o.eliteCap = +v;
    else if (k === 'stand-in') o.standIn = true;
    else if (k === 'yes') o.yes = true;
    else if (k === 'max-minutes') o.maxMinutes = +v;
  }
  return o;
}

// 本物の sim を叩いたときの実測。gens=200・並列9 で 1行あたりおよそ1.4秒
// （種ごとの10国ロスター構築を含む。方針数が増えるほどロスター分は薄まる）
const SEC_PER_ROW_AT_200 = 1.4;

export function estimateCost(nPolicies, nSeeds, nOpponents, gens) {
  const rows = nPolicies * nSeeds * nOpponents;
  const minutes = (rows * SEC_PER_ROW_AT_200 * (gens / 200)) / 60;
  return { rows, minutes };
}

/**
 * best.json を読んで正規化する。欠けたカードは既定値で埋め、範囲外は丸める。
 * 探索側の best.json は `policies`（finalize.py が平らにしたもの）のほか
 * `top`（成績で包んだ行）も持つので、どちらの形でも受ける。
 */
function loadElite(file, cap) {
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = [raw, raw.policies, raw.best, raw.top].find(Array.isArray) || [];
  const meta = (!Array.isArray(raw) && raw.meta) || {};
  const out = [];
  arr.slice(0, cap).map((x) => (x && x.policy ? { ...x.policy, _note: x.note } : x)).forEach((p, i) => {
    const cards = {};
    for (const id of CARD_IDS) {
      const r = CARD_RANGE[id];
      const v = Number(p.cards?.[id]);
      cards[id] = Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.def;
    }
    out.push({
      id: p.id || `elite${String(i + 1).padStart(3, '0')}`,
      cards,
      captiveAxis: CAPTIVE_AXES.includes(p.captiveAxis) ? p.captiveAxis : '総合',
      border: BORDERS.includes(p.border) ? p.border : 'accept',
      promote: PROMOTES.includes(p.promote) ? p.promote : 'merit',
      warAppetite: Number.isFinite(+p.warAppetite) ? Math.min(1, Math.max(0, +p.warAppetite)) : 0.5,
    });
  });
  return out.length ? { policies: out, meta } : null;
}

/**
 * ホールドアウトが本当にホールドアウトか、探索側のメタ情報と突き合わせて確かめる。
 * 「分けたつもり」を信用しない。1本でも重なっていれば、上位方針の成績は過適合を含む。
 */
function auditHoldout(meta, judgeSeeds, opponents) {
  const used = new Set([...(meta.search_seeds || []), ...(meta.holdout_seeds || [])]);
  const overlap = judgeSeeds.filter((s) => used.has(s));
  const searchOpps = meta.opponents || null;
  const unseenOpps = searchOpps ? opponents.filter((o) => !searchOpps.includes(o)) : [];
  return {
    known: used.size > 0, overlap, searchSeedCount: used.size,
    searchOpps, unseenOpps,
  };
}

/**
 * best.json が無いときの代役。探索担当の出力を真似て、**探索用の種だけ**（1..8）で
 * 乱択＋山登りをして上位を返す。
 *
 * 2点わざとそうしている：
 *  - 種を8本しか使わない。少ない種で選ぶと過適合が起きる。判定はホールドアウトで
 *    採点するので、過適合していれば成績が落ちる形で表に出る。
 *  - 相手ごとに別々に山を登る。相手依存が実在する世界なら専門家が育ち、
 *    実在しない世界なら全部同じところに登る。**代役が答えを仕込まない**ようにこうする。
 */
async function synthesizeElite(evaluator, rng, cap, metricName, scale = 1) {
  const searchSeeds = evaluator.fake ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4];
  let pool = [];
  for (let i = 0; i < Math.round(240 * scale); i++) pool.push(samplePolicy(rng, `c0_${i}`));
  let rows = await evaluator.run(pool, searchSeeds, OPPONENTS);
  let t = buildTable(rows, pool, searchSeeds, OPPONENTS, metricName);

  // 相手ごとに、その相手に対する上位2本の周りを3周だけ探る
  const elites = new Map();
  for (let o = 0; o < OPPONENTS.length; o++) {
    let cur = t.ids.map((_, p) => p)
      .sort((a, b) => mean(t.v[b][o]) - mean(t.v[a][o])).slice(0, 2)
      .map((p) => t.policies[p]);
    for (let round = 0; round < (evaluator.fake ? 3 : 1); round++) {
      const kids = [];
      cur.forEach((par, pi) => {
        for (let m = 0; m < Math.max(2, Math.round(8 * scale)); m++) {
          const kid = JSON.parse(JSON.stringify(par));
          kid.id = `h${o}_${round}_${pi}_${m}`;
          for (const id of CARD_IDS) {
            if (rng.next() > 0.4) continue;
            const r = CARD_RANGE[id];
            const v = kid.cards[id] + rng.normal(0, (r.max - r.min) * 0.18);
            kid.cards[id] = Math.min(r.max, Math.max(r.min, Math.round(v / r.step) * r.step));
          }
          if (rng.next() < 0.3) kid.captiveAxis = rng.pick(CAPTIVE_AXES);
          if (rng.next() < 0.3) kid.border = rng.pick(BORDERS);
          if (rng.next() < 0.3) kid.promote = rng.pick(PROMOTES);
          if (rng.next() < 0.5) kid.warAppetite = Math.min(1, Math.max(0, kid.warAppetite + rng.normal(0, 0.15)));
          kids.push(kid);
        }
      });
      const gen = [...cur, ...kids];
      const gr = await evaluator.run(gen, searchSeeds, [OPPONENTS[o]]);
      const gt = buildTable(gr, gen, searchSeeds, [OPPONENTS[o]], metricName);
      cur = gt.order.slice(0, 2).map((p) => gt.policies[p]);
    }
    cur.forEach((p, i) => elites.set(`${OPPONENTS[o]}_${i}`, p));
  }
  // 総合上位も混ぜる（万能型がいるならここに出る）
  t.order.slice(0, 8).forEach((p, i) => elites.set(`gen_${i}`, t.policies[p]));

  return [...elites.values()].slice(0, cap)
    .map((p, i) => ({ ...p, id: `elite${String(i + 1).padStart(3, '0')}` }));
}

function verdictLines(q1, q2, q3, q4, meta) {
  const L = [];
  const dominant = q1.verdict === 'DOMINANT_STRICT' || q1.verdict === 'DOMINANT_TYPE';
  if (q1.verdict === 'NO_SIGNAL') {
    L.push(`1. **問1は判定不能。** 相手ごとの最上位ティアに全方針の ${(q1.tierFrac * 100).toFixed(0)}% が入ってしまい、方針の優劣そのものが測れていない。支配戦略が「無い」のではなく、有無を言える状態にない。`);
  } else if (dominant) {
    L.push(`1. **支配戦略が実在する。** 全10相手で最上位ティアに入る方針が ${q1.universal.length}本あり、その得意不得意のかたちは直径 ${q1.uShapeDiameter.toFixed(3)}（測定誤差の床 ${q1.noiseFloor.toFixed(3)}）で区別がつかない＝1本の型。カード設定は散らばっている（直径 ${q1.uDiameter.toFixed(3)}）が、それは効かないカードの違いにすぎない。「最適解は複数」は実装で成立していない。`);
  } else if (q1.verdict === 'MULTI_UNIVERSAL') {
    L.push(`1. 支配戦略は1本に絞れないが、全相手で通じる方針が ${q1.universal.length}本ある（かたちの直径 ${q1.uShapeDiameter.toFixed(3)} / 測定誤差 ${q1.noiseFloor.toFixed(3)}）。勝ち筋は ${q2.nTypes}本で、「最適解は複数」は成立、ただし「どれかを選ばされる」圧は弱い。`);
  } else if (q2.nTypes <= 1) {
    L.push(`1. 支配戦略は無い（全相手で最上位ティアに入る方針は0本）が、**勝ち筋も1本しか立たない**。上位方針は挙動空間で1つの塊で、島に割れなかった。「最適解は複数」の後半が実装で成立していない。`);
  } else {
    L.push(`1. 支配戦略は無い（全相手で最上位ティアに入る方針は0本）。勝ち筋は ${q2.nTypes}本で、挙動空間のクラスタ間/内 距離比 ${q2.wb.ratio.toFixed(2)}・識別率 ${(q2.ident.rate * 100).toFixed(0)}%・並べ替え検定 p=${q2.perm.p.toFixed(3)}、型の隔たりは測定誤差の ${Math.min(...q2.behavior.map((x) => x.snr)).toFixed(1)}倍以上。ゆらぎではなく別の型として立っている。`);
  }
  if (q3.verdict === 'OPPONENT_DEPENDENT') {
    L.push(`2. 最適は相手で変わる。相手をまたいだ最良の距離 ${q3.betweenMean.toFixed(3)} に対し、同じ相手で種を割ったノイズの床は ${q3.withinMean.toFixed(3)}（比 ${q3.ratio.toFixed(2)}）。1本を全相手に持ち回ると平均 ${q3.bestUniversalLoss.toFixed(2)}sd 取りこぼす＝コピーが効かない。`);
  } else if (q3.verdict === 'SAME_FOR_ALL') {
    L.push(`2. **最適は相手で変わらない。** 10国の最良方針は ${q3.distinctBest}種類しかなく、1本を全相手に持ち回っても取りこぼしは ${q3.bestUniversalLoss.toFixed(2)}sd。「統治の正解は自国民依存でコピーできない」は実装で成立していない。`);
  } else {
    L.push(`2. **相手ごとの最良の入れ替わりは、測定ノイズと区別がつかない。** 相手間 ${q3.betweenMean.toFixed(3)} 対 同一相手のノイズ床 ${q3.withinMean.toFixed(3)}（比 ${q3.ratio.toFixed(2)}）。相手依存を主張する根拠は現時点で無い。`);
  }
  const nn = Number.isFinite(q4.nNeeded) ? `${q4.nNeeded}戦` : '無限';
  if (q4.verdict === 'NOT_OBSERVABLE') {
    L.push(`3. **上達を測る定規が無い。** 最良とランダムの効果量 d=${q4.d.toFixed(2)}、1戦で最良が勝つ確率 ${(q4.pSup * 100).toFixed(0)}%、有意差に要る試合数 ${nn}。レビューの指摘は実測で裏付けられた。`);
  } else {
    L.push(`3. 上手い下手は${q4.verdict === 'CLEAR' ? 'はっきり' : '薄いが'}出る（d=${q4.d.toFixed(2)}、1戦で最良が勝つ確率 ${(q4.pSup * 100).toFixed(0)}%）。ただし有意に分けるには ${nn} 要る${q4.nNeeded > 20 ? '＝1セッションでは体感できない' : ''}。`);
  }
  return L;
}

export async function judge(opts) {
  const o = { ...opts };
  const rng = new RNG(20260820);

  const mismatch = verifySpace();
  if (mismatch.length) {
    process.stderr.write('⚠ SEARCH.md の範囲と src/sim/cards.js がズレている:\n  ' + mismatch.join('\n  ') + '\n');
  }

  const evaluator = makeEvaluator({ world: o.world, gens: o.gens, cache: o.cache, quiet: o.quiet });

  // --- 予算の見積り。本物の sim は1行1.4秒かかるので、うっかり数時間走らせない ---
  const seedsN = o.seeds, oppN = OPPONENTS.length;
  const est = estimateCost(o.eliteCap + o.random, seedsN, oppN, o.gens);
  if (!evaluator.fake) {
    if (!o.quiet) process.stderr.write(`見積り: 約${est.rows}行 / 約${est.minutes.toFixed(0)}分\n`);
    if (est.minutes > o.maxMinutes && !o.yes) {
      throw new Error(
        `見積り ${est.minutes.toFixed(0)}分 が上限 ${o.maxMinutes}分 を超える。\n` +
        `  そのまま走らせるなら --yes、上限を上げるなら --max-minutes=N、\n` +
        `  規模を落とすなら --seeds=N / --random=N / --elite-cap=N。`
      );
    }
  }

  // --- 方針を集める ------------------------------------------------------
  const loaded = loadElite(o.best, o.eliteCap);
  let elite = loaded?.policies ?? null;
  let eliteMeta = loaded?.meta ?? {};
  let policySource;
  if (elite) {
    const rel = path.relative(GAME_ROOT, o.best);
    policySource = `\`${rel.startsWith('..') ? o.best : rel}\`（探索担当の出力）`;
  } else if (!evaluator.fake && !o.standIn) {
    // 代役の探索は本物の sim を数千回叩く。探索担当の仕事を勝手に、しかも
    // 下手なやり方でやり直すことになるので、明示的に頼まれない限り走らせない。
    throw new Error(
      `${path.relative(GAME_ROOT, o.best)} が無い。\n` +
      '  探索担当の出力を待つか、判定器に下手な代役探索をさせるなら --stand-in を付ける\n' +
      '  （代役は本物の sim を数千回叩く。上位方針の質は探索担当のものより確実に低い）。'
    );
  } else {
    const scale = evaluator.fake ? 1 : 0.15;
    elite = await synthesizeElite(evaluator, rng.fork(7), o.eliteCap, o.metric, scale);
    policySource = evaluator.fake
      ? '**代役**（best.json が無いので、判定器が探索用の種8本で乱択＋山登りした上位）'
      : '**代役**（best.json が無いので、判定器が探索用の種4本で小規模に乱択＋山登りした上位。探索担当の出力より質は低い）';
  }
  const randoms = [];
  for (let i = 0; i < o.random; i++) randoms.push(samplePolicy(rng.fork(1000 + i), `rand${String(i + 1).padStart(3, '0')}`));

  const tags = new Map();
  elite.forEach((p) => tags.set(p.id, 'elite'));
  randoms.forEach((p) => tags.set(p.id, 'random'));
  const policies = [...elite, ...randoms];

  // --- ホールドアウト種で評価 ---------------------------------------------
  const seeds = Array.from({ length: o.seeds }, (_, i) => HOLDOUT_BASE + i);
  const audit = auditHoldout(eliteMeta, seeds, OPPONENTS);
  if (audit.overlap.length) {
    process.stderr.write(
      `⚠ ホールドアウトが汚染されている: 種 ${audit.overlap.join(',')} は探索側でも使われている。\n` +
      '  上位方針の成績はその分だけ過適合を含む。\n'
    );
  }
  if (!o.quiet) process.stderr.write(`判定: ${policies.length}方針 × ${OPPONENTS.length}相手 × ${seeds.length}種 = ${policies.length * OPPONENTS.length * seeds.length}行\n`);
  const rows = await evaluator.run(policies, seeds, OPPONENTS);

  const t = buildTable(rows, policies, seeds, OPPONENTS, o.metric);
  if (t.missing > t.ids.length * OPPONENTS.length * seeds.length * 0.02) {
    process.stderr.write(`⚠ 欠損が多い: ${t.missing}行。評価器が一部の方針で落ちている可能性\n`);
  }

  // --- 4つの問い ---------------------------------------------------------
  const q1 = q1Dominance(t, rng.fork(11));
  const sens = globalSensitivity(t);
  const q2 = q2WinLines(t, rng.fork(22), q1);
  const q3 = q3OpponentDependence(t, rng.fork(33));
  const q4 = q4SkillGradient(t, rng.fork(44), tags);

  // 支配戦略が見つかったときは、どのカードがどれだけ効いているかまで出す
  let oat = null;
  const needOat = o.oat || q1.verdict === 'DOMINANT_STRICT' || q1.verdict === 'DOMINANT_TYPE';
  if (needOat) {
    if (!o.quiet) process.stderr.write('支配戦略あり → OAT感度分析を実行\n');
    const base = t.policies[q1.champ];
    const oatSeeds = seeds.slice(0, Math.min(seeds.length, 20));
    const r = await oatSensitivity(base, evaluator, oatSeeds, OPPONENTS, o.metric, rng.fork(55));
    oat = { ...r, baseId: q1.champId };
  }

  // --- 指標を変えても結論が変わらないか ------------------------------------
  const robustness = [];
  for (const m of METRIC_NAMES) {
    const tm = m === o.metric ? t : buildTable(rows, policies, seeds, OPPONENTS, m);
    const a = m === o.metric ? q1 : q1Dominance(tm, rng.fork(111));
    const c = m === o.metric ? q3 : q3OpponentDependence(tm, rng.fork(333), { splits: 20 });
    const d = m === o.metric ? q4 : q4SkillGradient(tm, rng.fork(444), tags);
    robustness.push({ metric: m, q1: a.verdict, q3: c.verdict, d: d.d });
  }

  const meta = {
    fake: evaluator.fake, world: o.world, gens: o.gens, policySource,
    nElite: elite.length, nRandom: randoms.length, audit, eliteMeta,
    hasEval: hasRealEvaluator(), hasBest: !!loaded, bestPath: path.relative(GAME_ROOT, o.best),
    fullCost: estimateCost(o.eliteCap + o.random, o.seeds, OPPONENTS.length, o.gens),
    stamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    argv: process.argv.slice(2),
  };
  const ctx = { meta, t, q1, q2, q3, q4, sens, oat, robustness, tags };
  const stFile = path.join(HERE, 'selftest-result.json');
  if (fs.existsSync(stFile)) ctx.selftest = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  ctx.verdictLines = verdictLines(q1, q2, q3, q4, meta);
  return ctx;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(`
判定器。tools/SEARCH.md の4つの問いに数字で答え、tools/report-search.md を書く。

  node tools/judge/run.js                     本番（tools/search/best.json が要る）
  node tools/judge/run.js --world=plural      判定ロジックだけをダミー世界で回す
  node tools/judge/selftest.js                正解の分かっている3世界で判定器を較正

  --seeds=N        ホールドアウトの種数（既定30。SEARCH.md の下限も30）
  --gens=N         世代数（既定200）
  --random=N       判定器が独立に撒く一様乱択の本数（既定40）
  --elite-cap=N    best.json から読む上位の本数（既定32）
  --metric=NAME    winRate | netWins | power（既定 winRate）
  --oat            感度分析を必ず実行（支配戦略が見つかったときは自動で走る）
  --stand-in       best.json が無いとき、判定器に代役探索をさせる
  --max-minutes=N  見積りがこれを超えたら止める（既定30）
  --yes            見積りを無視して走らせる
  --no-cache       評価結果のキャッシュを使わない

種の取り決め：探索は 1..8999、判定は 9001.. のホールドアウト。重ねないこと。
`);
    return;
  }
  if (o.world === 'real' && !hasRealEvaluator()) {
    process.stderr.write(
      '\ntools/eval.js がまだ無い。\n' +
      '判定ロジックの検証だけなら、正解が既知のダミー世界で回せる:\n' +
      '  node tools/judge/run.js --world=plural     # 型が複数 & 相手依存の世界\n' +
      '  node tools/judge/run.js --world=dominant   # 支配戦略が1本ある世界\n' +
      '  node tools/judge/run.js --world=noise      # 方針が効かない世界\n' +
      '  node tools/judge/selftest.js               # 3つとも正しく判定できるか確認\n\n'
    );
    process.exitCode = 1;
    return;
  }
  const ctx = await judge(o);
  const md = renderReport(ctx);
  fs.writeFileSync(o.out, md);
  const rel = path.relative(GAME_ROOT, o.out);
  process.stderr.write(`\n書き出し: ${rel.startsWith('..') ? o.out : rel}\n\n`);
  for (const l of ctx.verdictLines) process.stderr.write(l.replace(/\*\*/g, '') + '\n');
  process.stderr.write('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { process.stderr.write(`\n判定に失敗: ${e.message}\n${e.stack}\n`); process.exitCode = 1; });
}

export { parseArgs, loadElite, verdictLines };
