// src/sim の公開API。ui と test はここだけを import する。
// 依存の向きは ui → sim → core の一方向。sim は DOM も window も Date.now() も触らない。

export {
  createWorld, stepTick, advanceGeneration,
  assignRole, setDistrict, appointBureau,
  search, readGene, purge, kill, spawn, dominantCause, recomputeAggregates,
} from './world.js';

export { setCard, CARDS, CARD_BY_ID, readCard, cardOr, defaultCards } from './cards.js';

export {
  chronicle, trace, traceUp, traceDown, record, applyDelta, setCanon, pruneChronicle,
} from './chronicle.js';

export { petitions, resolvePetition, STAKE } from './petitions.js';

export {
  makeGhost, startWar, stepBattle, runBattle, surrender,
  captiveOptions, takeCaptives, borderDecision, publicRank,
  settleWar, applyRout, selectDeployment, rankNation, injectOutsideBlood, CAPTIVE_AXES,
} from './battle.js';

export {
  eff, sins, sinOutputs, citizenPower, combatStats, produce, consume,
  unmetTotal, unmetBySin, willingness, acceptance, sensitivity,
  SEGMENT_OF, SKILL_OF,
} from './derive.js';

export {
  phenotype, carriers, recessiveHomo, homozygosity, gamete, breedGenome,
  foundingGenome, answersToTargets, enforceNoUniversalSuperiority,
} from './genetics.js';

export { PROFILES, makeRivalOwner, runRivalTurn } from './rival.js';
export { createRoster, advanceRoster, listOpponents, peek, rosterReport } from './roster.js';

export * as SIM_CONST from './constants.js';
