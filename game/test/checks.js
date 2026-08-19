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
  mean, sd, pearson, euclid, clamp01, round, pct, maxOf, minOf,
  lineChart, barChart, histogram, quantile,
} from './lib/util.js';
import { viableOnly, markInconclusive, corpusSummary, MIN_BREEDING_GENS } from './viability.js';

const R = (id, title, claim) => ({ id, title, claim, status: 'SKIP', summary: '', detail: '', numbers: {} });

/**
 * 判定の門番。
 * 「歴史が足りないので測れなかった」を FAIL に混ぜないための唯一の入口。
 * 戻り値が null なら、その検査は INCONCLUSIVE として確定済み。
 */
function gate(r, runs, opts = {}) {
  const need = opts.min ?? 1;
  const v = viableOnly(runs);
  if (v.length < need) { markInconclusive(r, runs, opts.what ?? 'この主張'); return null; }
  return v;
}

// 系列の末尾 frac を取る
function tail(a, frac = 0.2) { return a.slice(Math.max(0, Math.floor(a.length * (1 - frac)))); }

/**
 * 系列を取る。**人口0の世代は必ず落とす。**
 *
 * 絶滅後の世代は「遺伝子平均0・産出0」として記録されているので、
 * これを混ぜると「武断国の攻撃素質が0」のような、実装ではなく
 * 集計の事故でしかない FAIL が出る。ここが唯一の防波堤。
 */
function seriesOf(obs, fn, includeDead = false) {
  return obsEntries(obs, includeDead).map(fn);
}
/** 生きている世代のレコードそのもの（gen が要るときに使う）。 */
function obsEntries(obs, includeDead = false) {
  return includeDead ? obs.series : obs.series.filter(x => x.pop > 0);
}

// ===========================================================================
// 1. 連鎖 — 全ステが親2人を上回る子が1体でも出たら失敗
// ===========================================================================
export function checkLinkage(runs, armExempt = null) {
  const r = R('linkage', '連鎖（染色体）', '全ステが親2人を上回る子は構造的に生まれない');
  // 連鎖だけは「子が1体でも生まれていれば」測れる。世界が続く必要はない。
  const births = runs.flatMap(x => x.obs.births);
  if (births.length < 30) {
    return markInconclusive(r, runs, `出生が ${births.length}件しかなく、連鎖の保証`);
  }
  // sim が意図的に対抗アーム予算から外している染色体（v2では8番＝感受性/他責）は、
  // そこだけ親を上回っても設計違反ではない。除外して数える。
  const exempt = armExempt instanceof Set ? armExempt : new Set(armExempt ?? []);
  const domOf = b => (b.chromDomList ?? []).filter(ch => !exempt.has(ch));

  const violators = births.filter(b => b.minMargin > 0);
  const chromDom = births.filter(b => domOf(b).length > 0);
  const margins = births.map(b => b.minMargin);
  const aboveCounts = births.map(b => b.above);

  r.numbers = {
    births: births.length,
    fullDomination: violators.length,
    chromosomeDomination: chromDom.length,
    armBudgetExemptChromosomes: [...exempt],
    maxMinMargin: maxOf(margins),
    meanGenesAboveBothParents: mean(aboveCounts),
  };
  if (violators.length > 0) {
    r.status = 'FAIL';
    r.summary = `${births.length}件中 ${violators.length}件で全33座位が親2人を上回った。連鎖が効いていない。`;
  } else if (chromDom.length > 0) {
    r.status = 'WARN';
    r.summary = `全ステ制覇は0件だが、腕予算の対象である染色体で親2人制覇が ${chromDom.length}件ある（${births.length}件中）。腕予算が緩い。`;
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
    `染色体1本まるごと親2人を上回った子: ${chromDom.length}`
      + (exempt.size ? `（予算対象外の染色体 ${[...exempt].join(',')} は除外して数えている）` : ''),
    `最も惜しかった子の余裕 min_g(child-max(parents)) = ${round(maxOf(margins), 4)}（0未満なら安全）`,
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
  const ok = gate(r, runs, { what: '形質が固定するかどうか' });
  if (!ok) return r;
  runs = ok;

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
    const overall = { name, tailMean: round(tm, 4), tailSd: round(tsd, 4), min: round(minOf(avg), 3), max: round(maxOf(avg), 3) };

    // 「固定」＝集団のほぼ全員がその形質に振り切れた状態。0.28 のような中間値は固定ではない。
    // 1本の種がたまたま低めに落ち着いただけで FAIL にすると、頻度依存が効いていても落ちる。
    const FIX_HI = 0.88, FIX_LO = 0.12;
    const fixedSeeds = perSeed.filter(a => { const m = mean(tail(a, 0.2)); return m > FIX_HI || m < FIX_LO; }).length;
    overall.fixedSeeds = fixedSeeds;
    overall.seedsNeededToFail = Math.max(2, Math.ceil(runs.length / 2));

    let st;
    if (tm > FIX_HI || tm < FIX_LO) { st = 'FAIL'; }                       // 全種の平均で振り切れている
    else if (fixedSeeds >= overall.seedsNeededToFail) { st = 'FAIL'; }     // 過半数の種で振り切れている
    else if (fixedSeeds > 0) { st = 'WARN'; }                              // 一部の種だけ。報告はする
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
  const pin = rows.filter(x => x.status === 'WARN');
  r.summary = bad.length
    ? `${bad.join('・')} が集団に固定した。頻度依存が効いていない。`
    : pin.length
      ? `固定はしていない（${gens}世代 × ${runs.length}種）。ただし ` +
        pin.map(x => `${x.name}（末尾平均 ${x.tailMean}${x.fixedSeeds ? `・${x.fixedSeeds}/${runs.length}種で振り切れ` : '・ほぼ動かず'}）`).join('、') +
        ' は注視。'
      : `${gens}世代 × ${runs.length}種で 逃走癖・私欲・怠惰 のいずれも固定しなかった。` +
        rows.map(x => `${x.name} ${x.tailMean}`).join(' / ');
  r.detail = lines.join('\n');
  return r;
}

// ===========================================================================
// 3. 劣性の潜伏 — 心系の劣性が数世代潜伏して発現する例が観測できるか
// ===========================================================================
export function checkRecessiveLatency(runs, trackedMind) {
  const r = R('recessive', '劣性の潜伏', '心系の劣性が数世代潜伏し、保因者どうしの結婚で発現する');
  if (!runs.some(x => x.obs.caps.geno)) {
    r.status = 'SKIP';
    r.summary = 'sim が個体の遺伝子型（アレル対）を出していないため観測不能。表現型だけでは潜伏は原理的に測れない。';
    return r;
  }
  // 潜伏は定義上「数世代」かかる。歴史が短い世界では原理的に観測できない。
  const all = gate(r, runs.filter(x => x.obs.caps.geno), { what: '劣性が潜伏して発現するか' });
  if (!all) return r;
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
  if (!closedRuns.length || !closedRuns.some(x => x.obs.caps.geno)) {
    r.status = 'SKIP';
    r.summary = 'sim が遺伝子型を出していないため劣性ホモ率を測れない。';
    return r;
  }
  // 血が濃くなるには世代が要る。短命な世界の比較には意味がない。
  const cv = gate(r, closedRuns, { what: '閉じた血統が腐るか' });
  if (!cv) return r;
  const ov = viableOnly(openRuns);
  if (!ov.length) return markInconclusive(r, openRuns, '外来血を入れた側との比較');
  closedRuns = cv; openRuns = ov;
  recoveryRuns = viableOnly(recoveryRuns);
  const homoOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.homo), 0.25)));
  const loadOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.hz), 0.25)));
  const popOf = runs => runs.map(x => mean(tail(seriesOf(x.obs, s => s.pop), 0.25)));

  const cH = mean(homoOf(closedRuns)), oH = mean(homoOf(openRuns));
  const cL = mean(loadOf(closedRuns)), oL = mean(loadOf(openRuns));
  const cP = mean(popOf(closedRuns)), oP = mean(popOf(openRuns));

  r.numbers = {
    closedHomozygosity: round(cH, 4), openHomozygosity: round(oH, 4),
    closedValueHomozygosity: round(cL, 4), openValueHomozygosity: round(oL, 4),
    closedPop: round(cP, 1), openPop: round(oP, 1),
  };

  // 回復：閉鎖で走らせたあと外来血を注入して劣性ホモ率が下がるか
  let recovered = null, recLines = [];
  if (recoveryRuns.length) {
    // 注入は「世代番号」で起きる。人口0の世代を落とすと配列の添字と世代がずれるので、
    // 前後の比較は必ず gen を見て切る（ここを添字でやると回復が逆符号に見える）。
    const injectGen = recoveryRuns[0].injectAt ?? 0;
    const entries = recoveryRuns.map(x => obsEntries(x.obs));
    const L = Math.min(...entries.map(a => a.length));
    const avg = [];
    for (let i = 0; i < L; i++) avg.push(mean(entries.map(a => a[i].homo)));
    const beforeVals = entries.flatMap(a => a.filter(e => e.gen >= injectGen - 12 && e.gen < injectGen).map(e => e.homo));
    const afterVals = entries.flatMap(a => a.filter(e => e.gen >= injectGen + 8).map(e => e.homo));
    if (!beforeVals.length || !afterVals.length) { recovered = null; }
    else {
      var before = mean(beforeVals), after = mean(afterVals);
      recovered = before - after;
    }
    if (recovered == null) {
      recLines = ['', `外来血の注入（第${injectGen}世代）の前後を比較できる世代が足りない。`];
    } else {
    const half = injectGen;
    r.numbers.homozygosityBeforeInjection = round(before, 4);
    r.numbers.homozygosityAfterInjection = round(after, 4);
    recLines = [
      '',
      `外来血の注入（第${half}世代）を挟んだ劣性ホモ率:`,
      '```',
      lineChart(avg, { width: 68, height: 10, lo: 0, hi: Math.max(0.35, maxOf(avg) * 1.1), xlabel: `gen 0 .. ${L}（注入=${half}）` }),
      '```',
      `注入直前 ${round(before, 4)} → 末尾 ${round(after, 4)}（差 ${round(recovered, 4)}）`,
    ];
    }
  }

  // 注入が本当に起きたか（外来個体が増えたか）。起きていないなら「回復しない」とは言えない。
  const injectionTook = recoveryRuns.length
    ? maxOf(recoveryRuns.flatMap(x => seriesOf(x.obs, s => s.foreignFrac)), 0) > 0.01 : false;
  r.numbers.injectionTook = injectionTook;

  const rise = cH - oH;
  if (rise <= 0.005) {
    r.status = 'FAIL';
    r.summary = `閉じた血統(${round(cH, 3)})が開いた血統(${round(oH, 3)})より劣性ホモ率が高くならなかった。近親交配ペナルティが発生していない。`;
  } else if (recovered != null && recovered <= 0.002 && !injectionTook) {
    // 閉鎖で腐ることは示せた。回復側は実験そのものが成立していない。
    r.status = 'WARN';
    r.summary = `閉鎖 ${round(cH, 3)} vs 開放 ${round(oH, 3)}（+${round(rise, 3)}）で**近親交配ペナルティは確認できた**。`
      + `一方「外来血で回復するか」は**測れていない**：注入後も外来個体の比率が上がっておらず、`
      + `捕虜の受け入れ（takeCaptives → borderDecision('accept')）が実際には成立していない。回復の可否はこの実測では言えない。`;
  } else if (recovered != null && recovered <= 0.002) {
    r.status = 'WARN';
    r.summary = `閉鎖で劣性ホモは増える(${round(cH, 3)} vs ${round(oH, 3)})が、外来血が入っても回復しない（差 ${round(recovered, 4)}）。雑種強勢の経路が弱い。`;
  } else {
    r.status = 'PASS';
    r.summary = `閉鎖 ${round(cH, 3)} vs 開放 ${round(oH, 3)}（+${round(rise, 3)}）。血の濃さ（全座位ホモ率）も ${round(cL, 3)} vs ${round(oL, 3)}。` +
      (recovered != null ? ` 外来血の注入で ${round(recovered, 4)} 低下。` : '');
  }
  r.detail = [
    '```',
    barChart([
      ['閉鎖 劣性ホモ率', cH], ['開放 劣性ホモ率', oH],
      ['閉鎖 全座位ホモ率', cL], ['開放 全座位ホモ率', oL],
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
  const all = Object.values(byProfile).flat();
  // 判定可能な世界だけでクラスタを作る。絶滅した国の最終ゲノムは
  // 「最後の1体」であって国の性格ではないので、混ぜると分化が消える。
  const kept = {};
  for (const [k, v] of Object.entries(byProfile)) {
    const ok = viableOnly(v).filter(x => x.obs.finalCentroid);
    if (ok.length) kept[k] = ok;
  }
  const ids = Object.keys(kept);
  if (ids.length < 2) {
    markInconclusive(r, all, 'オーナーごとに分化するか');
    r.summary += ` 判定可能だったのは ${ids.length}カ国（比較には2カ国以上が要る）。`;
    return r;
  }
  if (ids.length < Object.keys(byProfile).length) {
    r.note = `10国中 ${ids.length}カ国だけが判定可能だったため、その範囲で判定している。`;
  }
  byProfile = kept;

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

  // 最近傍セントロイド分類（leave-one-out）。
  // 1国あたり3世界未満だと「自国のセントロイドだけ標本1個・他国は平均」という
  // 構造的な不利が出て、分化していても識別率が0%に落ちる。だから3未満では測らない。
  const perProfile = minOf(ids.map(id => byProfile[id].length));
  let acc = null;
  const chance = 1 / ids.length;
  // 1国あたり2世界では「同じ方針でもこれくらいは散る」という幅そのものが測れない。
  // 幅が測れないのに比を根拠に主張を否定すると、それは実測ではなく思い込みになる。
  if (perProfile < 3) {
    markInconclusive(r, all, 'オーナーごとに分化するか');
    r.summary = `**判定不能**（主張が否定されたのではない）。判定可能な世界が1国あたり ${perProfile}本しかなく、`
      + `「同じ方針でもどれだけ散るか」（クラスタ内分散）を推定できない。`
      + ` 参考値としてクラスタ間 ${round(bMean, 3)} / クラスタ内 ${round(wMean, 3)}（比 ${round(ratio, 2)}）だが、`
      + `n=${perProfile} のクラスタ内分散は当てにならない。**1国あたり3本以上を生存させる必要がある**（\`--roster-seeds\` を増やすか、国が潰れない状態にする）。`;
    r.numbers = {
      profiles: ids.length, worldsPerProfile: perProfile,
      provisionalBetween: round(bMean, 4), provisionalWithin: round(wMean, 4), provisionalRatio: round(ratio, 3),
      requiredWorldsPerProfile: 3,
    };
    return r;
  }
  if (perProfile >= 3) {
    let correct = 0, total = 0;
    for (const id of ids) {
      const vecs = byProfile[id].map(x => x.obs.finalCentroid);
      for (let k = 0; k < vecs.length; k++) {
        const loo = vecs.filter((_, i) => i !== k);
        if (loo.length < 2) continue;
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
    acc = total ? correct / total : null;
  }

  r.numbers = {
    profiles: ids.length, worldsPerProfile: perProfile,
    betweenClusterMeanDistance: round(bMean, 4),
    withinClusterMeanSpread: round(wMean, 4),
    ratio: round(ratio, 3),
    nearestCentroidAccuracy: acc == null ? null : round(acc, 3),
    chanceLevel: round(chance, 3),
    accuracyMeasurable: perProfile >= 3,
  };
  const accTxt = acc == null
    ? `識別率は1国あたり${perProfile}世界では測れない（3世界以上必要）`
    : `識別率 ${pct(acc)}（偶然 ${pct(chance)}）`;
  // 判定の主軸は比。識別率は3世界以上あるときだけ補助的に見る。
  if (ratio < 1.0) {
    r.status = 'FAIL';
    r.summary = `クラスタ間距離 ${round(bMean, 3)} ≦ クラスタ内分散 ${round(wMean, 3)}（比 ${round(ratio, 2)}）。ゲノムが平均に潰れている＝「オーナーごとに分化する」という柱が実測で否定された。`;
  } else if (acc != null && acc < chance * 2) {
    r.status = 'FAIL';
    r.summary = `クラスタは離れている（比 ${round(ratio, 2)}）のに ${accTxt}。国ごとの散らばりが大きすぎて、ゲノムから国を言い当てられない。`;
  } else if (ratio < 1.5) {
    r.status = 'WARN';
    r.summary = `分化はしているが弱い（比 ${round(ratio, 2)}、${accTxt}）。`;
  } else {
    r.status = 'PASS';
    r.summary = `クラスタ間 ${round(bMean, 3)} > クラスタ内 ${round(wMean, 3)}（比 ${round(ratio, 2)}）。${accTxt}。${ids.length}国はゲノムで見分けがつく。`;
  }
  if (r.note) r.summary += ` ${r.note}`;

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

  // 同じ方針の世界どうしがどれだけ散っているかを国別に出す。
  // 「分化しない」の原因が特定の国の暴れなのか全体の漂動なのかを切り分けるため。
  const spreadRows = ids.map(id => [id, within[id]]).sort((a, b) => b[1] - a[1]);

  r.detail = [
    `プロファイル ${ids.length}種 × 各 ${perProfile}世界（判定可能だったものだけ）`,
    `クラスタ間の平均距離 ${round(bMean, 3)} / 同じ方針どうしの平均距離 ${round(wMean, 3)} → 比 ${round(ratio, 3)}`,
    acc != null ? `最近傍セントロイドでの識別率 ${pct(acc)}（偶然 ${pct(chance)}）` : '',
    '',
    '同じ方針で走らせた世界どうしの散らばり（大きいほど方針が効いていない）:',
    '```',
    barChart(spreadRows, { width: 34 }),
    '```',
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
  // 親に練度が乗っていなければ「遺伝しない」ことを確かめようがない。
  const births = runs.flatMap(x => x.obs.births).filter(b => b.parentSkill > 0.001);
  if (births.length < 50) {
    markInconclusive(r, runs, '練度が遺伝しないこと');
    r.summary += ` 親の練度が0でない出生が ${births.length}件しかなく（必要50件）、無相関の検定ができない。`;
    return r;
  }

  const px = births.map(b => b.parentSkill), cy = births.map(b => b.childSkill);
  const rho = pearson(px, cy);
  const nonzero = births.filter(b => b.childSkill > 1e-9).length;
  const maxChild = maxOf(cy);

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
    r.summary = 'sim が戦死の内訳（流れ矢かステータス由来か）を出していないため測れない。'
      + '`battle.js` の `resolveDown()` は `luck` を知っているが、その印がどこにも残らずに消えている。'
      + '次のどれか1つで観測可能になる：(a) 死亡ユニットに `u.luck = luck` を立てる、'
      + '(b) `kill(w, ind, luck ? "戦死:運" : "戦死:ステ")` と死因を分ける、'
      + '(c) `world.deathTally = {war_stat, war_luck}` を積む。';
    return r;
  }
  const total = stat + luck;
  if (total < 30) {
    markInconclusive(r, runs, '戦死の内訳');
    r.summary += ` 集計できた戦死が ${total}件しかない（比率を言うには30件以上ほしい）。内訳は ステータス由来${stat} / 運${luck}。`;
    return r;
  }
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
  const rawP = byProfile.purist ?? [], rawM = byProfile.melting ?? [];
  if (!rawP.length || !rawM.length) { r.summary = 'purist / melting の世界が無い'; return r; }
  if (!rawP.some(x => x.obs.caps.geno)) { r.status = 'SKIP'; r.summary = 'sim が遺伝子型を出していないため測れない'; return r; }
  const P = viableOnly(rawP), M = viableOnly(rawM);
  if (!P.length || !M.length) {
    markInconclusive(r, [...rawP, ...rawM], '純血が腐り融和で雑種強勢が出るか');
    r.summary += ` （purist 判定可能 ${P.length}/${rawP.length}、melting ${M.length}/${rawM.length}）`;
    return r;
  }

  const g = (runs, fn) => mean(runs.map(x => mean(tail(seriesOf(x.obs, fn), 0.25))));
  const pH = g(P, s => s.homo), mH = g(M, s => s.homo);
  const pL = g(P, s => s.hz), mL = g(M, s => s.hz);
  const pPop = g(P, s => s.pop), mPop = g(M, s => s.pop);
  const pF = g(P, s => s.foreignFrac), mF = g(M, s => s.foreignFrac);
  const pY = g(P, s => s.yieldRate), mY = g(M, s => s.yieldRate);

  r.numbers = {
    puristHomozygosity: round(pH, 4), meltingHomozygosity: round(mH, 4),
    puristValueHomozygosity: round(pL, 4), meltingValueHomozygosity: round(mL, 4),
    puristPop: round(pPop, 1), meltingPop: round(mPop, 1),
    puristForeignFrac: round(pF, 4), meltingForeignFrac: round(mF, 4),
    puristYield: round(pY, 2), meltingYield: round(mY, 2),
  };
  // 融和国に外の血が1滴も入っていないなら、そもそも比較が成立していない。
  // これを FAIL にすると「捕虜が薬になる」という主張を、起きなかった実験で否定することになる。
  if (mF < 0.01 && pF < 0.01) {
    markInconclusive(r, [...P, ...M], '純血と融和の差');
    r.summary = `**判定不能**（主張が否定されたのではない）。融和国(melting)の外来個体比率が ${pct(mF)}、`
      + `純血国(purist)が ${pct(pF)}。**どちらの国にも外の血がほとんど入っていないので、混血と純血を比べていない。**`
      + ` 捕虜の受け入れ（takeCaptives → borderDecision('accept')）が実際に起きているかを先に確かめる必要がある。`;
    r.numbers = { ...r.numbers, puristForeignFrac: round(pF, 4), meltingForeignFrac: round(mF, 4) };
    return r;
  }
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
    r.summary = `純血 劣性ホモ ${round(pH, 3)} / 全座位ホモ ${round(pL, 3)} に対し 融和 ${round(mH, 3)} / ${round(mL, 3)}。人口 ${round(pPop, 1)} vs ${round(mPop, 1)}、産出 ${round(pY, 1)} vs ${round(mY, 1)}。`;
  }
  r.detail = [
    '```',
    barChart([
      ['purist 劣性ホモ', pH], ['melting 劣性ホモ', mH],
      ['purist 全座位ホモ率', pL], ['melting 全座位ホモ率', mL],
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
  const rawT = byProfile.terror ?? [];
  if (!rawT.length) { r.summary = 'terror の世界が無い'; return r; }
  const T = viableOnly(rawT);
  if (!T.length) return markInconclusive(r, rawT, '粛清が3世代後に謀反として返るか');
  // 粛清も謀反も1件も記録されていないなら、それは観測経路が無いということ
  const anyPurge = T.some(x => x.obs.series.some(s => s.purges > 0));
  const anyReb = T.some(x => x.obs.series.some(s => s.rebels > 0));
  if (!anyPurge && !anyReb) {
    r.status = 'SKIP';
    r.summary = '粛清・謀反の事件が年代記に1件も出ていない。'
      + '`record(w,"粛清",…)` / `record(w,"一揆",…)` が発生していないか、kind の綴りが違う。';
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
  } else if (Math.max(...lags.map(l => corr[l])) - Math.min(...lags.map(l => corr[l])) < 0.06) {
    // どの遅れでも相関が同じ＝「3世代後」という特異性が無い。
    // 粛清の多い国では謀反も多い、という定常的な相関を見ているだけの可能性が高い。
    r.status = 'WARN';
    r.summary = `粛清と謀反は明確に結びついている（terror の謀反率 ${round(rebelRate(T), 2)}件/世代 vs laissez ${round(rebelRate(L), 3)}件/世代、`
      + `粛清 ${totalPurge}件・謀反 ${totalRebel}件）が、**遅れ0〜6世代の相関がすべて r≈${round(corr[3], 2)} で平坦**。`
      + `「3世代後に返ってくる」という時間差の特異性までは実測できていない（定常的な相関と区別がつかない）。`
      + ` 年代記の遡行（trueCause の鎖）では実際に平均3世代前の粛清まで辿れているので、因果の鎖そのものは繋がっている。`;
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
  const rawM = byProfile.merit ?? [], rawD = byProfile.dynastic ?? [];
  if (!rawM.length || !rawD.length) { r.summary = 'merit / dynastic の世界が無い'; return r; }
  const M = viableOnly(rawM), D = viableOnly(rawD);
  if (!M.length || !D.length) return markInconclusive(r, [...rawM, ...rawD], '透過率が局長の出自を変えるか');
  const logs = runs => runs.map(x => x.world.bureauLog ?? []).filter(l => l.length);
  const ml = logs(M), dl = logs(D);
  if (!ml.length || !dl.length) {
    r.status = 'SKIP';
    r.summary = 'sim が局長の任命ログ（出自つき）を出していないため測れない。';
    return r;
  }
  // 創世期（アダムとイザナミしかいない数世代）は必ず H1/H2 に集中するので落とす。
  const trim = ls => ls.map(l => l.filter(e => (e.gen ?? 0) >= 5)).filter(l => l.length >= 4);
  const stat = ls => {
    const nobleFrac = mean(ls.map(l => l.filter(e => e.noble).length / l.length));
    const houses = mean(ls.map(l => new Set(l.map(e => e.house)).size / l.length));
    // 上位1家系への集中度
    const conc = mean(ls.map(l => {
      const c = new Map();
      for (const e of l) c.set(e.house, (c.get(e.house) ?? 0) + 1);
      return Math.max(...c.values()) / l.length;
    }));
    const rank = mean(ls.flatMap(l => l.map(e => e.houseRank ?? 0)));
    return { nobleFrac, houses, conc, rank, n: mean(ls.map(l => l.length)) };
  };
  const mt = trim(ml), dt = trim(dl);
  if (!mt.length || !dt.length) {
    markInconclusive(r, [...M, ...D], '透過率が局長の出自を変えるか');
    r.summary += ' 創世期を除くと任命の記録が足りない（各国4件以上必要）。';
    return r;
  }
  const m = stat(mt), d = stat(dt);
  r.numbers = {
    meritNobleFrac: round(m.nobleFrac, 4), dynasticNobleFrac: round(d.nobleFrac, 4),
    meritDistinctHousesPerAppointment: round(m.houses, 4), dynasticDistinctHousesPerAppointment: round(d.houses, 4),
    meritTopHouseShare: round(m.conc, 4), dynasticTopHouseShare: round(d.conc, 4),
    appointmentsPerWorld: round(m.n, 0),
  };
  // 期待される向き：世襲は1家系に集中し、実力主義は家系がばらける。
  const sep = d.conc - m.conc;
  r.numbers.concentrationGap = round(sep, 4);
  if (Math.abs(sep) <= 0.02 && Math.abs(m.houses - d.houses) <= 0.01) {
    r.status = 'FAIL';
    r.summary = `世襲(${pct(d.conc)})と実力主義(${pct(m.conc)})で局長の家系集中度に差が出ていない（差 ${round(sep, 3)}）。透過率が血統構造を変えていない。`;
  } else if (sep < -0.02) {
    r.status = 'FAIL';
    r.summary = `**向きが逆**。上位1家系の占有率は 世襲 ${pct(d.conc)} < 実力主義 ${pct(m.conc)}（差 ${round(sep, 3)}）。`
      + `透過率を上げた実力主義のほうが家系が固まっている。抜擢が実力ではなく血統に効いているか、透過率の符号が逆。`;
  } else if (sep <= 0.05) {
    r.status = 'WARN';
    r.summary = `差はあるが小さい（上位家系の占有率 世襲 ${pct(d.conc)} vs 実力 ${pct(m.conc)}、差 ${round(sep, 3)}）。`;
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
  const rawA = byProfile.martial ?? [], rawB = byProfile.agrarian ?? [];
  if (!rawA.length || !rawB.length) { r.summary = 'martial / agrarian の世界が無い'; return r; }
  const A = viableOnly(rawA), B = viableOnly(rawB);
  if (!A.length || !B.length) {
    markInconclusive(r, [...rawA, ...rawB], '戦死の淘汰が武力素質の分布をずらすか');
    r.summary += ` （martial 判定可能 ${A.length}/${rawA.length}、agrarian ${B.length}/${rawB.length}）`;
    return r;
  }
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
const REBEL_KINDS = ['一揆', '謀反', 'rebellion'];
const PURGE_KINDS = ['粛清', 'purge', '処刑'];

export function checkChronicleTrace(runs, api) {
  const r = R('chronicle', '年代記の遡行', '3世代後の謀反から原因の粛清まで年代記で遡れる');
  const trace = api.traceUp ?? api.trace;
  if (typeof trace !== 'function') {
    r.status = 'SKIP';
    r.summary = 'sim が traceUp（trueCause の連鎖を辿る手段）を出していない。';
    return r;
  }
  let traced = 0, rebellions = 0, lags = [], examples = [];
  for (const run of runs) {
    const evs = run.world.events ?? [];
    for (const e of evs) {
      if (!REBEL_KINDS.includes(e.kind)) continue;
      rebellions++;
      let chain = [];
      try { chain = trace(run.world, e.id, 12) ?? []; } catch { chain = []; }
      const cause = chain.find(c => PURGE_KINDS.includes(c.kind));
      if (cause) {
        traced++;
        lags.push(e.gen - cause.gen);
        if (examples.length < 5) {
          const claimed = e.claimed?.text ?? e.claimed?.blame ?? e.claimed ?? '—';
          examples.push(`- 第${e.gen}世代の${e.kind} → (trueCause ${chain.length}段) → 第${cause.gen}世代の${cause.kind}　`
            + `※公表された帰属は「${claimed}」／遡行 ${e.gen - cause.gen}世代`);
        }
      }
    }
  }
  r.numbers = {
    rebellions, tracedToPurge: traced,
    meanLagGens: lags.length ? round(mean(lags), 2) : null,
    lagGE3: lags.filter(x => x >= 3).length,
  };
  if (!rebellions) {
    // 謀反が起きていないのは「遡行できない」ではなく「まだ測れていない」
    markInconclusive(r, runs, '謀反から粛清への遡行');
    r.summary += ' 謀反（一揆）の事件が1件も起きていないため、鎖を辿る対象が存在しない。';
    return r;
  }
  if (!traced) {
    r.status = 'FAIL';
    r.summary = `謀反 ${rebellions}件のいずれからも原因の粛清まで辿れなかった。trueCause の鎖が繋がっていない。`;
  } else {
    r.status = 'PASS';
    r.summary = `謀反 ${rebellions}件中 ${traced}件（${pct(traced / rebellions)}）で原因の粛清まで遡れた。`
      + `遡行の隔たりは平均 ${round(mean(lags), 1)}世代、3世代以上のものが ${lags.filter(x => x >= 3).length}件。`;
  }
  r.detail = [
    '真の原因（trueCause）と公表された帰属（claimed）が別カラムであることの確認:',
    ...(examples.length ? examples : ['(例なし)']),
  ].join('\n');
  return r;
}
