// viability.js — 「測れなかった」と「主張が偽だった」を分ける唯一の場所。
//
// この区別がテスト基盤でいちばん大事な部分。
// 世界が5世代で絶滅したときに「劣性の潜伏が観測できなかった」のは
// 設計の否定ではなく**測定の失敗**である。絶滅した世界を根拠に FAIL を出すと、
// レポートは動いていない実装のせいで設計そのものを不当に否定する。
//
//   FAIL          … 十分な歴史があり、そのうえで主張と逆の結果が出た
//   INCONCLUSIVE  … 歴史が足りず、主張の真偽を判定していない
//   SKIP          … sim がその観測に必要なデータを出していない（データ契約の穴）

export const BREEDING_POP = 4;         // これを下回ると繁殖が成立しない
export const MIN_BREEDING_GENS = 10;   // 繁殖可能な規模で回った世代数の下限

/** 1世界が「設計主張を測るに足る歴史」を持ったか。 */
export function viabilityOf(obs, requested = 0) {
  const s = obs.series ?? [];
  let breeding = 0, peak = 0, deathGen = null;
  for (const x of s) {
    if (x.pop >= BREEDING_POP) breeding++;
    if (x.pop > peak) peak = x.pop;
    // 絶滅した「世代」。ロスターは死んだ国もループを回し続けるので、
    // 観測世代数をそのまま死亡世代として使うと分布が末尾に固まって嘘になる。
    if (deathGen === null && x.pop === 0 && x.gen > 0) deathGen = x.gen;
  }
  const gens = Math.max(0, s.length - 1);
  const lastPop = s.length ? s[s.length - 1].pop : 0;
  return {
    gens, requested, breedingGens: breeding, peakPop: peak, lastPop,
    extinct: lastPop === 0,
    deathGen: lastPop === 0 ? (deathGen ?? gens) : null,
    survivedFull: lastPop > 0 && gens >= requested,
    viable: breeding >= MIN_BREEDING_GENS,
  };
}

export function viableOnly(runs) {
  return (runs ?? []).filter(r => r?.viability?.viable);
}

/** 母集団の要約。INCONCLUSIVE の理由文を作るのに使う。 */
export const EARLY_DEATH_GENS = 10;   // これ以内に絶滅したら「即死」（AAA-2）

export function corpusSummary(runs) {
  const n = (runs ?? []).length;
  let extinct = 0, early = 0, sumBreed = 0, sumGens = 0, peak = 0;
  const deathGens = [];
  for (const r of runs ?? []) {
    const v = r?.viability;
    if (!v) continue;
    if (v.extinct) {
      const dg = v.deathGen ?? v.gens;
      extinct++;
      deathGens.push(dg);
      if (dg <= EARLY_DEATH_GENS) early++;
    }
    sumBreed += v.breedingGens;
    sumGens += v.gens;
    peak = Math.max(peak, v.peakPop);
  }
  return {
    worlds: n, extinctWorlds: extinct,
    earlyDeaths: early,
    earlyDeathRate: n ? early / n : 0,
    deathGens: deathGens.sort((a, b) => a - b),
    viableWorlds: viableOnly(runs).length,
    meanBreedingGens: n ? Math.round(sumBreed / n) : 0,
    meanGens: n ? Math.round(sumGens / n) : 0,
    peakPop: peak,
  };
}

/**
 * 検査結果を INCONCLUSIVE に落とす。
 * 「測れなかった」ことを、主張の否定に見えない文言で書く。
 */
export function markInconclusive(r, runs, what = 'この主張') {
  const c = corpusSummary(runs);
  r.status = 'INCONCLUSIVE';
  r.numbers = { ...c, requiredBreedingGens: MIN_BREEDING_GENS };
  r.summary =
    `**判定不能**（主張が否定されたのではない）。測定に足る世界が ${c.viableWorlds}/${c.worlds} 本。` +
    `${c.extinctWorlds}本が絶滅し、繁殖可能な規模（${BREEDING_POP}体以上）で回った世代数は平均 ${c.meanBreedingGens}世代` +
    `（判定に必要なのは ${MIN_BREEDING_GENS}世代）。最大到達人口 ${c.peakPop}。` +
    `世界が続かないので${what}は測れていない。`;
  r.detail = [
    '```',
    `世界数            ${c.worlds}`,
    `うち絶滅          ${c.extinctWorlds}`,
    `うち判定可能      ${c.viableWorlds}   （繁殖規模で ${MIN_BREEDING_GENS}世代以上）`,
    `平均到達世代      ${c.meanGens}`,
    `平均繁殖可能世代  ${c.meanBreedingGens}`,
    `最大到達人口      ${c.peakPop}`,
    '```',
    '',
    'この検査は世界が続くようになれば自動で判定に変わる。検査側の変更は要らない。',
  ].join('\n');
  return r;
}
