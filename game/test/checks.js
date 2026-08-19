// checks.js — 設計主張の検証。ここが本命。
//
// 設計文書が「こうなるはず」と主張していることを、実際にそうなるか確かめる。
// 各検査は run.js が集めたデータだけを見る。sim の内部は observer 経由でしか触らない。
//
// status: PASS / FAIL / WARN / SKIP
//   FAIL = 設計主張が実測で否定された。隠さない。
//   SKIP = sim がその観測に必要な情報を出していない（= sim への要求として報告する）

import { GENE_NAMES } from '../src/core/genes.js';
import {
  mean, sd, pearson, euclid, clamp01, round, pct,
  lineChart, barChart, histogram, quantile,
} from './lib/util.js';

const R = (id, title, claim) => ({ id, title, claim, status: 'SKIP', summary: '', detail: '', numbers: {} });

// 系列の末尾 frac を取る
function tail(a, frac = 0.2) { return a.slice(Math.max(0, Math.floor(a.length * (1 - frac)))); }
function seriesOf(obs, fn) { return obs.series.map(fn); }

// ===========================================================================
// 1. 連鎖 — 全ステが親2人を上回る子が1体でも出たら失敗
// ===========================================================================
export function checkLinkage(runs) {
  const r = R('linkage', '連鎖（染色体）', '全ステが親2人を上回る子は構造的に生まれない');
  const births = runs.flatMap(x => x.obs.births);
  if (!births.length) { r.summary = '出生レコードが1件も取れていない'; return r; }

  const violators = births.filter(b => b.minMargin > 0);
  const chromDom = births.filter(b => b.chromDom > 0);
  const margins = births.map(b => b.minMargin);
  const aboveCounts = births.map(b => b.above);

  r.numbers = {
    births: births.length,
    fullDomination: violators.length,
    chromosomeDomination: chromDom.length,
    maxMinMargin: Math.max(...margins),
    meanGenesAboveBothParents: mean(aboveCounts),
  };
  if (violators.length > 0) {
    r.status = 'FAIL';
    r.summary = `${births.length}件中 ${violators.length}件で全33座位が親2人を上回った。連鎖が効いていない。`;
  } else if (chromDom.length > 0) {
    r.status = 'WARN';
    r.summary = `全ステ制覇は0件だが、染色体単位での親2人制覇が ${chromDom.length}件ある（腕予算が緩い）。`;
  } else if (mean(aboveCounts) < 1) {
    r.status = 'WARN';
    r.summary = `全ステ制覇は0件。ただし親を上回る座位が平均 ${round(mean(aboveCounts), 2)} しかない＝変異がほぼ死んでいる疑い。`;
  } else {
    r.status = 'PASS';
    r.summary = `${births.length}件の出生で全ステ制覇 0件。1座位単位では平均 ${round(mean(aboveCounts), 1)}/33 が親超え＝進化の余地は残っている。`;
  }
  r.detail = [
    `出生数: ${births.length}`,
    `全33座位で親2人を上回った子: **${violators.length}**（0でなければ失敗）`,
    `染色体1本まるごと親2人を上回った子: ${chromDom.length}`,
    `最も惜しかった子の余裕 min_g(child-max(parents)) = ${round(Math.max(...margins), 4)}（0未満なら安全）`,
    '',
    '親2人を上回った座位数の分布（33座位中）:',
    '```',
    histogram(aboveCounts, { bins: 12, lo: 0, hi: 33, width: 34 }),
    '```',
  ].join('\n');
  return r;
}

// ===========================================================================
// 2. 頻度依存 — 逃走癖・私欲・怠惰が集団に固定しないか
// ===========================================================================
export function checkFrequency(runs, opts = {}) {
  const r = R('frequency', '頻度依存', '増えれば損になる形質（逃走・私欲・怠惰）は集団に固定しない');
  if (!runs.length || !runs[0].obs.series.length) { r.summary = '系列が取れていない'; return r; }

  const traits = {
    逃走癖: s => clamp01((1 - s.genes['胆力']) * (0.4 + 0.6 * s.genes['感受性'])),
    私欲: s => s.genes['私欲'],
    怠惰: s => clamp01((1 - s.genes['勤勉']) * (0.4 + 0.6 * s.genes['感受性'])),
  };
  const lines = [], rows = [];
  let worst = 'PASS';
  const gens = runs[0].obs.series.length;

  for (const [name, fn] of Object.entries(traits)) {
    // 種をまたいだ平均系列と、種ごとの末尾値
    const perSeed = runs.map(x => seriesOf(x.obs, fn));
    const L = Math.min(...perSeed.map(a => a.length));
    const avg = [];
    for (let i = 0; i < L; i++) avg.push(mean(perSeed.map(a => a[i])));
    const t = tail(avg, 0.2);
    const tm = mean(t), tsd = sd(t);
    const overall = { name, tailMean: round(tm, 4), tailSd: round(tsd, 4), min: round(Math.min(...avg), 3), max: round(Math.max(...avg), 3) };

    // 種ごとに固定しているものが1つでもあるか（平均でならすと見えなくなるので個別に見る）
    const fixedSeeds = perSeed.filter(a => { const m = mean(tail(a, 0.2)); return m > 0.85 || m < 0.15; }).length;
    overall.fixedSeeds = fixedSeeds;

    let st;
    if (tm > 0.85 || tm < 0.15) { st = 'FAIL'; }
    else if (fixedSeeds > runs.length * 0.3) { st = 'FAIL'; }
    else if (tsd < 0.004 && Math.abs(tm - 0.5) < 0.03) { st = 'WARN'; }
    else st = 'PASS';
    if (st === 'FAIL') worst = 'FAIL';
    else if (st === 'WARN' && worst !== 'FAIL') worst = 'WARN';
    overall.status = st;
    rows.push(overall);

    lines.push(`### ${name}  →  ${st}`);
    lines.push('```');
    lines.push(lineChart(avg, { width: 68, height: 10, lo: 0, hi: 1, xlabel: `gen 0 .. ${L}` }));
    lines.push('```');
    lines.push(`末尾20%平均=${round(tm, 3)} 標準偏差=${round(tsd, 4)} 全期間 min=${overall.min} max=${overall.max} / 固定した種 ${fixedSeeds}/${runs.length}`);
    lines.push('');
  }

  r.status = worst;
  r.numbers = { gens, seeds: runs.length, traits: rows };
  const bad = rows.filter(x => x.status === 'FAIL').map(x => x.name);
  const pin = rows.filter(x => x.status === 'WARN').map(x => x.name);
  r.summary = bad.length
    ? `${bad.join('・')} が集団に固定した。頻度依存が効いていない。`
    : pin.length
      ? `固定はしないが ${pin.join('・')} が0.5付近に張り付いて動いていない（中立漂動しかしていない疑い）。`
      : `${gens}世代 × ${runs.length}種で 逃走癖・私欲・怠惰 のいずれも固定しなかった。`;
  r.detail = lines.join('\n');
  return r;
}

// ===========================================================================
// 3. 劣性の潜伏 — 心系の劣性が数世代潜伏して発現する例が観測できるか
// ===========================================================================
export function checkRecessiveLatency(runs, trackedMind) {
  const r = R('recessive', '劣性の潜伏', '心系の劣性が数世代潜伏し、保因者どうしの結婚で発現する');
  const all = runs.filter(x => x.obs.caps.geno);
  if (!all.length) {
    r.status = 'SKIP';
    r.summary = 'sim が個体の遺伝子型（アレル対）を出していないため観測不能。表現型だけでは潜伏は原理的に測れない。';
    return r;
  }
  const latencies = [], carrierPairEvents = [];
  let hCount = 0;

  for (const run of all) {
    const z = run.obs.zygo;
    for (const [id, rec] of z) {
      for (let j = 0; j < trackedMind.length; j++) {
        if (rec.code[j] !== 'h') continue;
        hCount++;
        const f = rec.f != null ? z.get(rec.f) : null;
        const m = rec.m != null ? z.get(rec.m) : null;
        if (!f || !m) continue;
        // 「保因者どうしが結ばれた瞬間に発現」— 親は両方 'c'（保因）で、本人が 'h'
        if (f.code[j] === 'c' && m.code[j] === 'c') {
          const anc = nearestExpressingAncestor(z, rec, j, 40);
          const lat = anc == null ? rec.gen : rec.gen - anc;
          if (lat >= 0) {
            latencies.push(lat);
            carrierPairEvents.push({ gene: trackedMind[j], gen: rec.gen, latency: lat });
          }
        }
      }
    }
  }
  const multi = latencies.filter(x => x >= 2).length;
  r.numbers = {
    homozygousRecessiveIndividualsGenes: hCount,
    carrierPairExpressions: latencies.length,
    latencyMean: round(mean(latencies), 2),
    latencyMedian: latencies.length ? quantile(latencies, 0.5) : 0,
    latencyP90: latencies.length ? quantile(latencies, 0.9) : 0,
    latencyGE2: multi,
  };
  if (!latencies.length) {
    r.status = 'FAIL';
    r.summary = '保因者どうしから劣性ホモが生まれる事例が1件も観測できなかった。潜伏が成立していない。';
  } else if (multi === 0) {
    r.status = 'FAIL';
    r.summary = `発現は ${latencies.length}件あるが、すべて潜伏1世代。「数世代潜伏して発現」が成立していない。`;
  } else {
    r.status = 'PASS';
    r.summary = `保因者どうしの結婚による劣性発現 ${latencies.length}件。うち ${multi}件（${pct(multi / latencies.length)}）は2世代以上潜伏。中央値 ${quantile(latencies, 0.5)}世代、90%点 ${quantile(latencies, 0.9)}世代。`;
  }
  const ex = carrierPairEvents.filter(e => e.latency >= 3).slice(0, 6);
  r.detail = [
    `劣性ホモ（発現）の座位延べ数: ${hCount}`,
    `そのうち「両親とも保因者」から生まれた発現: **${latencies.length}件**`,
    '',
    '潜伏世代数の分布（直近に同じ形質を発現した先祖からの隔たり）:',
    '```',
    latencies.length ? histogram(latencies, { bins: 10, lo: 0, hi: Math.max(6, quantile(latencies, 0.98)), width: 34 }) : '(none)',
    '```',
    ex.length ? '3世代以上潜伏した例:' : '',
    ...ex.map(e => `- 第${e.gen}世代 「${e.gene}」の劣性が ${e.latency}世代の潜伏を経て発現`),
  ].join('\n');
  return r;
}

function nearestExpressingAncestor(z, rec, j, maxDepth) {
  // 親から遡って、同じ座位で 'h'（発現）だった最も近い先祖の世代を返す
  let frontier = [rec.f, rec.m].filter(x => x != null);
  const seen = new Set();
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    let best = null;
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const a = z.get(id);
      if (!a) continue;
      if (a.code[j] === 'h') best = best == null ? a.gen : Math.max(best, a.gen);
      if (a.f != null) next.push(a.f);
      if (a.m != null) next.push(a.m);
    }
    if (best != null) return best;
    frontier = next;
  }
  return null;
}

// ===========================================================================
// 4. 近親交配 — 閉じた血統で劣性ホモが増え、外来血で回復するか
// ===========================================================================
export function checkInbreeding(closedRuns, openRuns, recoveryRuns) {
  const r = R('inbreeding', '近親交配', '閉じた血統は劣性ホモが溜まって腐る。外来血を入れると回復する');
  if (!closedRuns.length || !closedRuns[0].obs.caps.geno) {
    r.status = 'SKIP';
    r.summary = 'sim が遺伝子型を出していないため劣性ホモ率を測れない。';
    return r;
  }
  const homoOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.homo), 0.25)));
  const loadOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.load), 0.25)));
  const popOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.pop), 0.25)));

  const cH = mean(homoOf(closedRuns)), oH = mean(homoOf(openRuns));
  const cL = mean(loadOf(closedRuns)), oL = mean(loadOf(openRuns));
  const cP = mean(popOf(closedRuns)), oP = mean(popOf(openRuns));

  r.numbers = {
    closedHomozygosity: round(cH, 4), openHomozygosity: round(oH, 4),
    closedLoad: round(cL, 4), openLoad: round(oL, 4),
    closedPop: round(cP, 1), openPop: round(oP, 1),
  };

  // 回復：閉鎖で走らせたあと外来血を注入して劣性ホモ率が下がるか
  let recovered = null, recLines = [];
  if (recoveryRuns.length) {
    const series = recoveryRuns.map(x => seriesOf(x.obs, s => s.homo));
    const L = Math.min(...series.map(a => a.length));
    const avg = [];
    for (let i = 0; i < L; i++) avg.push(mean(series.map(a => a[i])));
    const half = recoveryRuns[0].injectAt ?? Math.floor(L / 2);
    const before = mean(avg.slice(Math.max(0, half - 12), half));
    const after = mean(tail(avg, 0.25));
    recovered = before - after;
    r.numbers.homozygosityBeforeInjection = round(before, 4);
    r.numbers.homozygosityAfterInjection = round(after, 4);
    recLines = [
      '',
      `外来血の注入（第${half}世代）を挟んだ劣性ホモ率:`,
      '```',
      lineChart(avg, { width: 68, height: 10, lo: 0, hi: Math.max(0.35, Math.max(...avg) * 1.1), xlabel: `gen 0 .. ${L}（注入=${half}）` }),
      '```',
      `注入直前 ${round(before, 4)} → 末尾 ${round(after, 4)}（差 ${round(recovered, 4)}）`,
    ];
  }

  const rise = cH - oH;
  if (rise <= 0.005) {
    r.status = 'FAIL';
    r.summary = `閉じた血統(${round(cH, 3)})が開いた血統(${round(oH, 3)})より劣性ホモ率が高くならなかった。近親交配ペナルティが発生していない。`;
  } else if (recovered != null && recovered <= 0.002) {
    r.status = 'WARN';
    r.summary = `閉鎖で劣性ホモは増える(${round(cH, 3)} vs ${round(oH, 3)})が、外来血を入れても回復しない（差 ${round(recovered, 4)}）。雑種強勢の経路が弱い。`;
  } else {
    r.status = 'PASS';
    r.summary = `閉鎖 ${round(cH, 3)} vs 開放 ${round(oH, 3)}（+${round(rise, 3)}）。遺伝的荷重も ${round(cL, 3)} vs ${round(oL, 3)}。` +
      (recovered != null ? ` 外来血の注入で ${round(recovered, 4)} 低下。` : '');
  }
  r.detail = [
    '```',
    barChart([
      ['閉鎖 劣性ホモ率', cH], ['開放 劣性ホモ率', oH],
      ['閉鎖 遺伝的荷重', cL], ['開放 遺伝的荷重', oL],
    ], { width: 36 }),
    '```',
    `平均人口: 閉鎖 ${round(cP, 1)} / 開放 ${round(oP, 1)}`,
    ...recLines,
  ].join('\n');
  return r;
}

// ===========================================================================
// 5. オーナーごとの分化（10国ロスター）
// ===========================================================================
export function checkDivergence(byProfile) {
  const r = R('divergence', 'オーナーごとの分化', '世界は平均じゃなくオーナーごとのクラスタに割れる');
  const ids = Object.keys(byProfile).filter(k => byProfile[k].length);
  if (ids.length < 2) { r.summary = 'プロファイルが2つ未満'; return r; }

  const centroids = {};
  const within = {};
  for (const id of ids) {
    const vecs = byProfile[id].map(x => x.obs.finalCentroid);
    const c = vecs[0].map((_, i) => mean(vecs.map(v => v[i])));
    centroids[id] = c;
    within[id] = mean(vecs.map(v => euclid(v, c)));
  }
  const wMean = mean(ids.map(id => within[id]));
  const bList = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      bList.push(euclid(centroids[ids[i]], centroids[ids[j]]));
  const bMean = mean(bList);
  const ratio = wMean > 1e-9 ? bMean / wMean : Infinity;

  // 最近傍セントロイド分類（leave-one-out）。偶然当たる確率 = 1/ids.length
  let correct = 0, total = 0;
  for (const id of ids) {
    const vecs = byProfile[id].map(x => x.obs.finalCentroid);
    for (let k = 0; k < vecs.length; k++) {
      const loo = vecs.filter((_, i) => i !== k);
      if (!loo.length) continue;
      const cs = {};
      for (const other of ids) {
        const vs = other === id ? loo : byProfile[other].map(x => x.obs.finalCentroid);
        cs[other] = vs[0].map((_, i) => mean(vs.map(v => v[i])));
      }
      let best = null, bd = Infinity;
      for (const other of ids) { const d = euclid(vecs[k], cs[other]); if (d < bd) { bd = d; best = other; } }
      if (best === id) correct++;
      total++;
    }
  }
  const acc = total ? correct / total : 0;
  const chance = 1 / ids.length;

  r.numbers = {
    profiles: ids.length, worldsPerProfile: byProfile[ids[0]].length,
    betweenClusterMeanDistance: round(bMean, 4),
    withinClusterMeanSpread: round(wMean, 4),
    ratio: round(ratio, 3),
    nearestCentroidAccuracy: round(acc, 3), chanceLevel: round(chance, 3),
  };
  if (ratio < 1.0 || acc < chance * 2) {
    r.status = 'FAIL';
    r.summary = `クラスタ間距離 ${round(bMean, 3)} / クラスタ内分散 ${round(wMean, 3)} = ${round(ratio, 2)}、識別率 ${pct(acc)}（偶然 ${pct(chance)}）。ゲノムが平均に潰れている＝「オーナーごとに分化する」という柱が実測で否定された。`;
  } else if (ratio < 1.5) {
    r.status = 'WARN';
    r.summary = `分化はしているが弱い（比 ${round(ratio, 2)}、識別率 ${pct(acc)}）。`;
  } else {
    r.status = 'PASS';
    r.summary = `クラスタ間 ${round(bMean, 3)} > クラスタ内 ${round(wMean, 3)}（比 ${round(ratio, 2)}）。最近傍セントロイドで ${pct(acc)} 識別（偶然 ${pct(chance)}）。10国はゲノムで見分けがつく。`;
  }

  // 分化を一番よく説明している遺伝子を出す
  const spread = GENE_NAMES.map((g, i) => {
    const vals = ids.map(id => centroids[id][i]);
    return [g, Math.max(...vals) - Math.min(...vals)];
  }).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const distRows = [];
  for (let i = 0; i < ids.length; i++) {
    let nearest = null, nd = Infinity;
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const d = euclid(centroids[ids[i]], centroids[ids[j]]);
      if (d < nd) { nd = d; nearest = ids[j]; }
    }
    distRows.push(`- ${ids[i].padEnd(9)} 最も近い国 = ${nearest} (距離 ${round(nd, 3)}) / 自クラスタの広がり ${round(within[ids[i]], 3)}`);
  }

  r.detail = [
    `プロファイル ${ids.length}種 × 各 ${byProfile[ids[0]].length}世界`,
    '',
    '国を隔てている遺伝子 上位10（10国のセントロイド間の振れ幅）:',
    '```',
    barChart(spread, { width: 34 }),
    '```',
    '各国の最近傍:',
    ...distRows,
  ].join('\n');
  return r;
}

// ===========================================================================
// 6. 練度が遺伝していないこと
// ===========================================================================
export function checkSkillHeritability(runs) {
  const r = R('skill', '練度が遺伝しないこと', '練度は遺伝しない。伸び率は環境が決める');
  const births = runs.flatMap(x => x.obs.births).filter(b => b.parentSkill > 0.001);
  if (births.length < 50) { r.summary = `親の練度が0でない出生が ${births.length}件しかなく検定できない`; return r; }

  const px = births.map(b => b.parentSkill), cy = births.map(b => b.childSkill);
  const rho = pearson(px, cy);
  const nonzero = births.filter(b => b.childSkill > 1e-9).length;
  const maxChild = Math.max(...cy);

  r.numbers = {
    samples: births.length, correlation: round(rho, 4),
    childrenBornWithNonZeroSkill: nonzero, maxInitialChildSkill: round(maxChild, 4),
    meanParentSkill: round(mean(px), 4),
  };
  if (nonzero > 0) {
    r.status = 'FAIL';
    r.summary = `${nonzero}/${births.length} の子が練度0でない状態で生まれている（最大 ${round(maxChild, 3)}）。練度が遺伝している。`;
  } else if (Math.abs(rho) > 0.1) {
    r.status = 'FAIL';
    r.summary = `親の練度と子の初期練度の相関 r=${round(rho, 3)}。無相関でなければならない。`;
  } else {
    r.status = 'PASS';
    r.summary = `${births.length}件で 親の平均練度(平均${round(mean(px), 3)}) と子の初期練度の相関 r=${round(rho, 4)}、子の初期練度は全件0。`;
  }
  r.detail = [
    '```',
    barChart([
      ['親の平均練度', mean(px)],
      ['子の初期練度', mean(cy)],
      ['相関 |r|', Math.abs(rho)],
    ], { width: 34, max: 1 }),
    '```',
    `サンプル ${births.length}件 / 練度0でない子 ${nonzero}件`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 7. 戦死の内訳 — ステータス由来90% / 運10%
// ===========================================================================
export function checkWarDeath(runs) {
  const r = R('wardeath', '戦死の内訳', '戦死者のうちステータス由来が90%、完全な運（流れ矢）が10%');
  let stat = 0, luck = 0, any = false;
  for (const x of runs) {
    if (!x.death) continue;
    stat += x.death.stat; luck += x.death.luck;
    if (x.death.stat + x.death.luck > 0) any = true;
  }
  if (!any) {
    r.status = 'SKIP';
    r.summary = 'sim が戦死の原因（deathCause に war:stat / war:luck 相当）を出していないため内訳を測れない。';
    return r;
  }
  const total = stat + luck;
  const share = luck / total;
  r.numbers = { warDeaths: total, statDeaths: stat, luckDeaths: luck, luckShare: round(share, 4), target: 0.10 };
  const off = Math.abs(share - 0.10);
  if (off > 0.03) {
    r.status = 'FAIL';
    r.summary = `戦死 ${total}件中 運死 ${luck}件 = ${pct(share)}。設計値10%から ${round(off * 100, 1)}pt ずれている。`;
  } else {
    r.status = 'PASS';
    r.summary = `戦死 ${total}件：ステータス由来 ${stat}件 (${pct(1 - share)}) / 運 ${luck}件 (${pct(share)})。設計値 90/10 に一致。`;
  }
  r.detail = [
    '```',
    barChart([['ステータス由来', 1 - share], ['運（流れ矢）', share], ['設計値：運', 0.10]],
      { width: 40, max: 1, fmt: v => pct(v) }),
    '```',
    `総戦死 ${total}件（${runs.length}世界の合計）`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 8. purist vs melting — 純血で腐るか / 融和で雑種強勢が出るか
// ===========================================================================
export function checkPuristVsMelting(byProfile) {
  const r = R('purist-melting', 'purist vs melting', '純血国は劣性ホモが上がり適応度が落ちる。融和国は雑種強勢が出る');
  const P = byProfile.purist ?? [], M = byProfile.melting ?? [];
  if (!P.length || !M.length) { r.summary = 'purist / melting の世界が無い'; return r; }
  if (!P[0].obs.caps.geno) { r.summary = 'sim が遺伝子型を出していないため測れない'; return r; }

  const g = (runs, fn) => mean(runs.map(x => mean(tail(seriesOf(x.obs, fn), 0.25))));
  const pH = g(P, s => s.homo), mH = g(M, s => s.homo);
  const pL = g(P, s => s.load), mL = g(M, s => s.load);
  const pPop = g(P, s => s.pop), mPop = g(M, s => s.pop);
  const pF = g(P, s => s.foreignFrac), mF = g(M, s => s.foreignFrac);
  const pY = g(P, s => s.yieldRate), mY = g(M, s => s.yieldRate);

  r.numbers = {
    puristHomozygosity: round(pH, 4), meltingHomozygosity: round(mH, 4),
    puristLoad: round(pL, 4), meltingLoad: round(mL, 4),
    puristPop: round(pPop, 1), meltingPop: round(mPop, 1),
    puristForeignFrac: round(pF, 4), meltingForeignFrac: round(mF, 4),
    puristYield: round(pY, 2), meltingYield: round(mY, 2),
  };
  const homoOk = pH > mH + 0.005;
  const fitOk = mPop > pPop || mY > pY;
  if (!homoOk && !fitOk) {
    r.status = 'FAIL';
    r.summary = `純血(${round(pH, 3)})と融和(${round(mH, 3)})で劣性ホモ率に差がなく、適応度の差も出ていない。捕虜＝薬という主張が実測で否定された。`;
  } else if (!homoOk) {
    r.status = 'FAIL';
    r.summary = `純血の劣性ホモ率 ${round(pH, 3)} が融和 ${round(mH, 3)} を上回らない。近親交配で腐るという主張が成立していない。`;
  } else if (!fitOk) {
    r.status = 'WARN';
    r.summary = `劣性ホモは純血で高い(${round(pH, 3)} vs ${round(mH, 3)})が、人口・産出に差が出ていない＝腐っても罰が効いていない。`;
  } else {
    r.status = 'PASS';
    r.summary = `純血 劣性ホモ ${round(pH, 3)} / 荷重 ${round(pL, 3)} に対し 融和 ${round(mH, 3)} / ${round(mL, 3)}。人口 ${round(pPop, 1)} vs ${round(mPop, 1)}、産出 ${round(pY, 1)} vs ${round(mY, 1)}。`;
  }
  r.detail = [
    '```',
    barChart([
      ['purist 劣性ホモ', pH], ['melting 劣性ホモ', mH],
      ['purist 荷重', pL], ['melting 荷重', mL],
    ], { width: 34 }),
    '',
    barChart([
      ['purist 人口', pPop], ['melting 人口', mPop],
      ['purist 産出', pY], ['melting 産出', mY],
    ], { width: 34 }),
    '```',
    `外来個体の比率: purist ${pct(pF)} / melting ${pct(mF)}（融和側が高くなければ捕虜処理が効いていない）`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 9. terror — 粛清と3世代後の謀反に相関があるか
// ===========================================================================
export function checkTerrorLag(byProfile) {
  const r = R('terror', 'terror：粛清 → 3世代後の謀反', '粛清という一手が怨恨として3世代後に返る');
  const T = byProfile.terror ?? [];
  if (!T.length || !T[0].obs.caps.purgeLog) {
    r.summary = 'sim が粛清／謀反のログを出していないため測れない。';
    return r;
  }
  const lags = [0, 1, 2, 3, 4, 5, 6];
  const corr = {};
  for (const lag of lags) {
    const xs = [], ys = [];
    for (const run of T) {
      const p = seriesOf(run.obs, s => s.purges);
      const q = seriesOf(run.obs, s => s.rebels);
      for (let i = 0; i + lag < p.length; i++) { xs.push(p[i]); ys.push(q[i + lag]); }
    }
    corr[lag] = pearson(xs, ys);
  }
  const totalPurge = T.reduce((a, x) => a + seriesOf(x.obs, s => s.purges).reduce((u, v) => u + v, 0), 0);
  const totalRebel = T.reduce((a, x) => a + seriesOf(x.obs, s => s.rebels).reduce((u, v) => u + v, 0), 0);
  // 比較対象として laissez（粛清しない国）の謀反率
  const L = byProfile.laissez ?? [];
  const rebelRate = runs => runs.length
    ? mean(runs.map(x => mean(seriesOf(x.obs, s => s.rebels)))) : 0;

  const best = lags.reduce((a, b) => (corr[b] > corr[a] ? b : a), 0);
  r.numbers = {
    purges: totalPurge, rebellions: totalRebel,
    correlationByLag: Object.fromEntries(lags.map(l => [l, round(corr[l], 4)])),
    peakLag: best,
    terrorRebellionRate: round(rebelRate(T), 4),
    laissezRebellionRate: round(rebelRate(L), 4),
  };
  if (totalPurge === 0) {
    r.status = 'FAIL';
    r.summary = 'terror 国で粛清が1件も起きていない。プロファイルが機能していない。';
  } else if (corr[3] <= 0.02) {
    r.status = 'FAIL';
    r.summary = `粛清と3世代後の謀反の相関 r=${round(corr[3], 3)}。粛清が3世代後に返るという主張が実測で否定された。`;
  } else if (best !== 3) {
    r.status = 'WARN';
    r.summary = `相関のピークが lag=${best}（r=${round(corr[best], 3)}）で、設計が想定する3世代ではない。lag3 は r=${round(corr[3], 3)}。`;
  } else {
    r.status = 'PASS';
    r.summary = `粛清 ${totalPurge}件・謀反 ${totalRebel}件。相関のピークは lag=3（r=${round(corr[3], 3)}）で設計どおり。terror の謀反率 ${round(rebelRate(T), 3)} vs laissez ${round(rebelRate(L), 3)}。`;
  }
  r.detail = [
    '粛清 → 謀反 の遅れ別相関:',
    '```',
    barChart(lags.map(l => [`lag ${l}世代`, Math.max(0, corr[l])]), { width: 40, max: Math.max(0.05, ...lags.map(l => corr[l])) }),
    '```',
    `terror: 粛清 ${totalPurge}件 / 謀反 ${totalRebel}件`,
    `謀反の発生率: terror ${round(rebelRate(T), 4)} 件/世代 vs laissez ${round(rebelRate(L), 4)} 件/世代`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 10. merit vs dynastic — 透過率が局長の出自分布を変えるか
// ===========================================================================
export function checkMeritVsDynastic(byProfile) {
  const r = R('merit-dynastic', 'merit vs dynastic', '透過率の差が局長の出自分布（名家か無名か）の差になる');
  const M = byProfile.merit ?? [], D = byProfile.dynastic ?? [];
  if (!M.length || !D.length) { r.summary = 'merit / dynastic の世界が無い'; return r; }
  const logs = runs => runs.map(x => x.world.bureauLog ?? []).filter(l => l.length);
  const ml = logs(M), dl = logs(D);
  if (!ml.length || !dl.length) {
    r.status = 'SKIP';
    r.summary = 'sim が局長の任命ログ（出自つき）を出していないため測れない。';
    return r;
  }
  const stat = ls => {
    const nobleFrac = mean(ls.map(l => l.filter(e => e.noble).length / l.length));
    const houses = mean(ls.map(l => new Set(l.map(e => e.house)).size / l.length));
    // 上位1家系への集中度
    const conc = mean(ls.map(l => {
      const c = new Map();
      for (const e of l) c.set(e.house, (c.get(e.house) ?? 0) + 1);
      return Math.max(...c.values()) / l.length;
    }));
    const rank = mean(ls.flatMap(l => l.map(e => e.houseRank)));
    return { nobleFrac, houses, conc, rank, n: mean(ls.map(l => l.length)) };
  };
  const m = stat(ml), d = stat(dl);
  r.numbers = {
    meritNobleFrac: round(m.nobleFrac, 4), dynasticNobleFrac: round(d.nobleFrac, 4),
    meritDistinctHousesPerAppointment: round(m.houses, 4), dynasticDistinctHousesPerAppointment: round(d.houses, 4),
    meritTopHouseShare: round(m.conc, 4), dynasticTopHouseShare: round(d.conc, 4),
    appointmentsPerWorld: round(m.n, 0),
  };
  const sep = d.conc - m.conc;
  if (sep <= 0.02 && (m.houses - d.houses) <= 0.01) {
    r.status = 'FAIL';
    r.summary = `世襲(${round(d.conc, 3)})と実力主義(${round(m.conc, 3)})で局長の家系集中度に差が出ていない。透過率が血統構造を変えていない。`;
  } else if (sep <= 0.05) {
    r.status = 'WARN';
    r.summary = `差はあるが小さい（上位家系の占有率 世襲 ${pct(d.conc)} vs 実力 ${pct(m.conc)}）。`;
  } else {
    r.status = 'PASS';
    r.summary = `上位1家系が局長を占める率は 世襲 ${pct(d.conc)} vs 実力主義 ${pct(m.conc)}。名家出身率は ${pct(d.nobleFrac)} vs ${pct(m.nobleFrac)}。透過率が出自分布に出ている。`;
  }
  r.detail = [
    '```',
    barChart([
      ['dynastic 上位家系占有', d.conc], ['merit 上位家系占有', m.conc],
      ['dynastic 名家出身率', d.nobleFrac], ['merit 名家出身率', m.nobleFrac],
      ['dynastic 家系の多様性', d.houses], ['merit 家系の多様性', m.houses],
    ], { width: 36, max: 1, fmt: v => pct(v) }),
    '```',
    `1世界あたり任命 ${round(m.n, 0)}件`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 11. martial vs agrarian — 戦死の淘汰で武力素質の分布がずれるか
// ===========================================================================
export function checkMartialVsAgrarian(byProfile) {
  const r = R('martial-agrarian', 'martial vs agrarian', '戦死による淘汰で武力素質の分布が実際にずれる');
  const A = byProfile.martial ?? [], B = byProfile.agrarian ?? [];
  if (!A.length || !B.length) { r.summary = 'martial / agrarian の世界が無い'; return r; }
  const g = (runs, name) => mean(runs.map(x => mean(tail(seriesOf(x.obs, s => s.genes[name]), 0.25))));
  const spread = (runs, name) => sd(runs.map(x => mean(tail(seriesOf(x.obs, s => s.genes[name]), 0.25))));

  const keys = ['攻撃素質', '胆力', '頑健', '勤勉', '器用', '好奇心', '知性'];
  const rows = keys.map(k => ({ k, m: g(A, k), a: g(B, k), d: g(A, k) - g(B, k) }));
  const atk = rows.find(x => x.k === '攻撃素質');
  const noise = Math.max(spread(A, '攻撃素質'), spread(B, '攻撃素質'), 1e-6);
  const z = atk.d / noise;

  const wd = runs => mean(runs.map(x => (x.death?.stat ?? 0) + (x.death?.luck ?? 0)));
  r.numbers = {
    martialAttack: round(atk.m, 4), agrarianAttack: round(atk.a, 4),
    delta: round(atk.d, 4), betweenSeedSd: round(noise, 4), z: round(z, 2),
    martialWarDeaths: round(wd(A), 1), agrarianWarDeaths: round(wd(B), 1),
  };
  if (atk.d <= 0) {
    r.status = 'FAIL';
    r.summary = `武断国の攻撃素質 ${round(atk.m, 3)} が農本国 ${round(atk.a, 3)} を上回らない。戦死による淘汰が分布をずらしていない。`;
  } else if (z < 1.5) {
    r.status = 'WARN';
    r.summary = `差は正方向(${round(atk.d, 3)})だが種間ばらつき(${round(noise, 3)})に対して z=${round(z, 1)} と小さい。`;
  } else {
    r.status = 'PASS';
    r.summary = `攻撃素質 武断 ${round(atk.m, 3)} vs 農本 ${round(atk.a, 3)}（差 ${round(atk.d, 3)}、z=${round(z, 1)}）。戦死 ${round(wd(A), 0)}件 vs ${round(wd(B), 0)}件。`;
  }
  r.detail = [
    '武断国 − 農本国 の遺伝子平均の差:',
    '```',
    barChart(rows.map(x => [x.k, x.d]), { width: 34, max: Math.max(...rows.map(x => Math.abs(x.d)), 0.01) }),
    '```',
    '```',
    barChart(rows.flatMap(x => [[`martial ${x.k}`, x.m], [`agrarian ${x.k}`, x.a]]).slice(0, 6), { width: 30, max: 1 }),
    '```',
    `2番染色体の緊張（武力と技術が同じ血で両立しない）: 武断の好奇心 ${round(g(A, '好奇心'), 3)} vs 農本 ${round(g(B, '好奇心'), 3)}`,
  ].join('\n');
  return r;
}

// ===========================================================================
// 12. 年代記の遡行（AAA-6）— 謀反から原因の粛清まで遡れるか
// ===========================================================================
export function checkChronicleTrace(runs, api) {
  const r = R('chronicle', '年代記の遡行', '3世代後の謀反から原因の粛清まで年代記で遡れる');
  if (typeof api.trace !== 'function') {
    r.status = 'SKIP';
    r.summary = 'sim が trace（trueCause の連鎖を辿る手段）を出していない。';
    return r;
  }
  let traced = 0, rebellions = 0, examples = [];
  for (const run of runs) {
    const evs = run.world.events ?? [];
    for (const e of evs) {
      if (e.kind !== 'rebellion') continue;
      rebellions++;
      const chain = api.trace(run.world, e.id, 8);
      const cause = chain.find(c => c.kind === 'purge');
      if (cause) {
        traced++;
        if (examples.length < 4) examples.push(
          `- 第${e.gen}世代の謀反 → (trueCause) → 第${cause.gen}世代の粛清 #${cause.target}　※公表された帰属は「${e.claimed ?? '—'}」`);
      }
    }
  }
  r.numbers = { rebellions, tracedToPurge: traced };
  if (!rebellions) { r.status = 'SKIP'; r.summary = '謀反が1件も起きていないため遡行を確かめられない。'; return r; }
  if (!traced) {
    r.status = 'FAIL';
    r.summary = `謀反 ${rebellions}件のいずれからも原因の粛清まで辿れなかった。trueCause が繋がっていない。`;
  } else {
    r.status = 'PASS';
    r.summary = `謀反 ${rebellions}件中 ${traced}件（${pct(traced / rebellions)}）で原因の粛清まで遡れた。`;
  }
  r.detail = [
    '真の原因（trueCause）と公表された帰属（claimed）が別カラムであることの確認:',
    ...examples,
  ].join('\n');
  return r;
}
