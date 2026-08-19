// ライバル国の「自動オーナー」。
//
// 作者が書いたCPUの振る舞いではなく、プレイヤーと同じ8つの動詞を
// 同じ world API に対して撃つ。だから10国は「同じルールで実際に走った世界」になる。
//
// プロファイルはパラメータの束でしかない：
//   配役の配分 / 抜擢の基準 / 捕虜の受け入れ方針 / 粛清の閾値 / 透過率 / 降伏するか
// この6項目の差が、世代を重ねると血統の差として出ること——それが検証したいこと。

import { BUREAU, ROLE, DISTRICT } from '../core/model.js';
import * as C from './constants.js';
import { citizenPower, sins, eff, clamp, clamp01 } from './derive.js';
import { setCard } from './cards.js';
import { appointBureau, setDistrict, purge, search } from './world.js';
import { petitions, resolvePetition } from './petitions.js';

/**
 * 抜擢の基準。ここで選ばれた個体が局長になり、
 *  ・カードを人格で歪める
 *  ・地位を得るので繁殖機会が増える（chooseMate の bureau ボーナス）
 * ので、基準の差がそのまま次世代の遺伝子構成に効く。
 */
const PROMOTE = {
  martial:  (p) => eff(p, '攻撃素質') * 1.2 + eff(p, '統率素質') + p.genes.胆力 * 0.6,
  agrarian: (p) => eff(p, '器用') + p.genes.勤勉 * 1.1 + eff(p, '共同作業適性') * 0.7,
  fecund:   (p) => p.genes.繁殖性 * 1.5 + p.genes.情愛 * 0.5,
  purist:   (p) => (p.lineage.home ?? 0) * 1.6 + citizenPower(p),
  melting:  (p) => (1 - (p.lineage.home ?? 0)) * 1.2 + citizenPower(p) * 1.1,
  terror:   (p) => p.genes.従順 * 1.3 + p.genes.非情 * 0.8 - p.genes.野心 * 1.1,
  laissez:  (p) => p.age * 0.05 + citizenPower(p) * 0.3,
  pious:    (p) => p.genes.信仰性 * 1.4 + p.genes.団結傾向 * 1.0 - p.genes.懐疑 * 0.8,
  merit:    (p) => citizenPower(p) * 1.6,
  dynastic: (p) => 0, // 別扱い（前任者の子を継がせる）
};

/** 粛清の対象らしさ。閾値を超えた者が消える＝そのまま淘汰圧になる。 */
const PURGE_SCORE = {
  terror:   (p, w) => 0.55 * p.genes.野心 + 0.55 * (1 - p.genes.従順) + 0.5 * p.regimeGrudge + 0.3 * p.genes.誇り,
  pious:    (p, w) => 0.7 * (1 - p.genes.信仰性) + 0.6 * p.genes.懐疑 + 0.3 * p.regimeGrudge,
  purist:   (p, w) => 1.3 * (1 - (p.lineage.home ?? 0)),
  martial:  (p, w) => 0.7 * p.genes.保身 + 0.5 * (p.cowardice ? 1 : 0),
  dynastic: (p, w) => 0.6 * p.genes.野心 * (p.bureau ? 0 : 1) - 0.5 * (p.titles.length ? 1 : 0),
  merit:    () => 0, agrarian: () => 0, fecund: () => 0, melting: () => 0, laissez: () => 0,
};

export const PROFILES = {
  martial: {
    id: 'martial', name: '武断', label: '狩り・実戦に厚く配役。武力素質を優先抜擢。降伏しない',
    roleMix: { hunt: 0.55, drill: 0.25 }, frontier: 0.55,
    promote: 'martial', captive: 'accept', purgeThreshold: 1.05, purgeRate: 0.02,
    transparency: 0.55, surrenderAt: 0, foreignBias: 0.1, inbreedGuard: 0.2,
    fertBias: 0.95, deployTop: 0.65, warAppetite: 0.85,
    preferGene: '攻撃素質', preferWeight: 0.7,
    cards: { deploy_top: 70, drill: 25, hunt_ratio: 55, frontier: 55, raise_young: 45 },
  },
  agrarian: {
    id: 'agrarian', name: '農本', label: '産出優先。備蓄を厚く。戦争は最小限',
    roleMix: { hunt: 0.15, drill: 0.02 }, frontier: 0.15,
    promote: 'agrarian', captive: 'accept', purgeThreshold: 1.5, purgeRate: 0,
    transparency: 0.5, surrenderAt: 0.55, foreignBias: 0.05, inbreedGuard: 0.25,
    fertBias: 1.0, deployTop: 0.22, warAppetite: 0.12,
    preferGene: '勤勉', preferWeight: 0.6,
    cards: { deploy_top: 20, drill: 0, hunt_ratio: 15, stockpile: 45, frontier: 10 },
  },
  fecund: {
    id: 'fecund', name: '多産', label: '繁殖性優先。質より量。密度ストレスを許容',
    roleMix: { hunt: 0.3, drill: 0.05 }, frontier: 0.3,
    promote: 'fecund', captive: 'accept', purgeThreshold: 1.5, purgeRate: 0,
    transparency: 0.6, surrenderAt: 0.45, foreignBias: 0.3, inbreedGuard: 0.05,
    fertBias: 1.45, deployTop: 0.4, warAppetite: 0.3,
    preferGene: '繁殖性', preferWeight: 1.1,
    cards: { deploy_top: 40, hunt_ratio: 30, ration_equal: 90, frontier: 30 },
  },
  purist: {
    id: 'purist', name: '純血', label: '捕虜をほぼ誅殺。自国産の血だけで回す',
    roleMix: { hunt: 0.3, drill: 0.12 }, frontier: 0.25,
    promote: 'purist', captive: 'kill', purgeThreshold: 0.95, purgeRate: 0.03,
    transparency: 0.25, surrenderAt: 0.3, foreignBias: -0.95, inbreedGuard: 0,
    fertBias: 1.05, deployTop: 0.45, warAppetite: 0.45,
    preferGene: null, preferWeight: 0,
    cards: { deploy_top: 45, hunt_ratio: 30, hereditary: 90, frontier: 20 },
  },
  melting: {
    id: 'melting', name: '融和', label: '捕虜を全部受け入れる。混血を最大化',
    roleMix: { hunt: 0.3, drill: 0.12 }, frontier: 0.3,
    promote: 'melting', captive: 'accept', purgeThreshold: 1.5, purgeRate: 0,
    transparency: 0.8, surrenderAt: 0.4, foreignBias: 0.95, inbreedGuard: 0.6,
    fertBias: 1.05, deployTop: 0.45, warAppetite: 0.5,
    preferGene: null, preferWeight: 0,
    cards: { deploy_top: 45, hunt_ratio: 30, hereditary: 10, ration_equal: 80 },
  },
  terror: {
    id: 'terror', name: '恐怖', label: '怨恨を無視して粛清を多用。従順を選抜',
    roleMix: { hunt: 0.35, drill: 0.2 }, frontier: 0.4,
    promote: 'terror', captive: 'kill', purgeThreshold: 0.72, purgeRate: 0.08,
    transparency: 0.3, surrenderAt: 0.2, foreignBias: -0.4, inbreedGuard: 0.1,
    fertBias: 1.0, deployTop: 0.55, warAppetite: 0.6,
    preferGene: '従順', preferWeight: 0.9,
    cards: { deploy_top: 55, drill: 20, hunt_ratio: 35, hereditary: 60 },
  },
  laissez: {
    id: 'laissez', name: '放任', label: 'ほとんど何もしない。局長に丸投げ',
    roleMix: { hunt: 0.3, drill: 0.05 }, frontier: 0.2,
    promote: 'laissez', captive: 'accept', purgeThreshold: 1.5, purgeRate: 0,
    transparency: 0.5, surrenderAt: 0.5, foreignBias: 0, inbreedGuard: 0.1,
    fertBias: 1.0, deployTop: 0.4, warAppetite: 0.25,
    preferGene: null, preferWeight: 0,
    cards: {},
  },
  pious: {
    id: 'pious', name: '信仰', label: '信仰性・団結傾向を選抜。排他的で捕虜を拒む',
    roleMix: { hunt: 0.25, drill: 0.12 }, frontier: 0.2,
    promote: 'pious', captive: 'return', purgeThreshold: 0.85, purgeRate: 0.035,
    transparency: 0.35, surrenderAt: 0.25, foreignBias: -0.7, inbreedGuard: 0.05,
    fertBias: 1.15, deployTop: 0.4, warAppetite: 0.4,
    preferGene: '信仰性', preferWeight: 1.0,
    cards: { deploy_top: 40, hunt_ratio: 25, hereditary: 70, ration_equal: 70 },
  },
  merit: {
    id: 'merit', name: '実力主義', label: '素質上位を抜擢。家柄を無視（透過率を最大に）',
    roleMix: { hunt: 0.35, drill: 0.15 }, frontier: 0.45,
    promote: 'merit', captive: 'accept', purgeThreshold: 1.5, purgeRate: 0,
    transparency: 0.95, surrenderAt: 0.45, foreignBias: 0.4, inbreedGuard: 0.5,
    fertBias: 1.0, deployTop: 0.5, warAppetite: 0.5,
    preferGene: '知性', preferWeight: 0.6,
    cards: { deploy_top: 50, drill: 15, hunt_ratio: 35, hereditary: 0, frontier: 45 },
  },
  dynastic: {
    id: 'dynastic', name: '世襲', label: '局長の血統を固定（透過率を最小に）',
    roleMix: { hunt: 0.28, drill: 0.1 }, frontier: 0.15,
    promote: 'dynastic', captive: 'accept', purgeThreshold: 1.1, purgeRate: 0.015,
    transparency: 0.05, surrenderAt: 0.5, foreignBias: -0.3, inbreedGuard: 0,
    fertBias: 1.0, deployTop: 0.35, warAppetite: 0.3,
    preferGene: '序列意識', preferWeight: 0.5,
    cards: { deploy_top: 35, hunt_ratio: 28, hereditary: 100, frontier: 10 },
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

export function makeRivalOwner(profileId) {
  const pf = PROFILES[profileId] || PROFILES.laissez;
  return { profile: pf, id: pf.id, purged: 0, appointed: 0, wars: 0 };
}

/** 世界の側に「敷く」「配る」を一度だけ焼き付ける。createWorld の直後に呼ぶ。 */
export function applyProfileToWorld(world, owner) {
  const pf = owner.profile;
  for (const [k, v] of Object.entries(pf.cards)) setCard(world, k, true, v);
  world.transparency = pf.transparency;
  world.mating.foreignBias = pf.foreignBias;
  world.mating.inbreedGuard = pf.inbreedGuard;
  world.mating.preferGene = pf.preferGene;
  world.mating.preferWeight = pf.preferWeight;
  world.fertBias = pf.fertBias;
  world.profileId = pf.id;
  world.budget = pf.id === 'martial'
    ? { military: 0.55, agri: 0.30, civil: 0.15 }
    : pf.id === 'agrarian'
      ? { military: 0.15, agri: 0.60, civil: 0.25 }
      : { military: 0.34, agri: 0.33, civil: 0.33 };
}

/**
 * 1世代分の「オーナーの手」。advanceGeneration の直前に呼ぶ。
 * 使う動詞：置く（任命・移住）／裁く（具申）／殺す（粛清）／敷く（カードの微調整）。
 * ぶつける（宣戦）は roster.js が担当する。
 */
export function runRivalTurn(world, owner, rng) {
  const pf = owner.profile;
  const events = [];
  if (world.people.size === 0) return events;

  // --- 置く：局長の任命 ---
  if (pf.id !== 'laissez' || world.gen % 6 === 0) {
    for (const bkey of Object.values(BUREAU)) {
      const cur = world.bureaus[bkey];
      if (cur != null && world.people.has(cur) && rng.next() > 0.12) continue;
      const cand = pickChief(world, pf, bkey, rng);
      if (cand) { appointBureau(world, bkey, cand.id); owner.appointed++; }
    }
  }

  // --- 置く：居住区。辺境は練度が伸びるが死ぬ。中心は安全だが軟弱になる ---
  const wantFrontier = pf.frontier;
  const people = [...world.people.values()];
  const nFrontier = people.filter((p) => p.district === DISTRICT.FRONTIER).length;
  const target = Math.round(people.length * wantFrontier);
  if (nFrontier < target) {
    const movable = people.filter((p) => p.district === DISTRICT.CENTER);
    rng.shuffle(movable);
    for (let i = 0; i < Math.min(target - nFrontier, movable.length, 6); i++) {
      setDistrict(world, movable[i].id, DISTRICT.FRONTIER);
    }
  } else if (nFrontier > target + 2) {
    const movable = people.filter((p) => p.district === DISTRICT.FRONTIER);
    rng.shuffle(movable);
    for (let i = 0; i < Math.min(nFrontier - target, movable.length, 4); i++) {
      setDistrict(world, movable[i].id, DISTRICT.CENTER);
    }
  }

  // --- 裁く：具申。承認の傾きがプロファイルそのもの ---
  const pets = petitions(world, rng);
  for (const p of pets) {
    events.push(...resolvePetition(world, p.id, approves(pf, p, world, rng), rng));
  }

  // --- 殺す：粛清。これが一番強い淘汰圧になる ---
  if (pf.purgeRate > 0 && world.people.size > 6) {
    const scorer = PURGE_SCORE[pf.id] || (() => 0);
    const cands = [...world.people.values()]
      .filter((p) => p.age >= C.ADULT_AGE && !p.founder)
      .map((p) => [p, scorer(p, world)])
      .filter(([, s]) => s >= pf.purgeThreshold)
      .sort((a, b) => b[1] - a[1]);
    const cap = Math.max(1, Math.round(world.people.size * pf.purgeRate));
    for (let i = 0; i < Math.min(cap, cands.length); i++) {
      const ev = purge(world, cands[i][0].id, rng, '粛清');
      if (ev) { events.push(ev); owner.purged++; }
    }
  }

  // --- 敷く：飢えたら派遣を絞る（放任だけはやらない） ---
  if (pf.id !== 'laissez') {
    const foodPer = world.food / Math.max(1, world.people.size);
    if (foodPer < 1.2) setCard(world, 'deploy_top', true, 10);
    else if (world.cards.deploy_top?.on) setCard(world, 'deploy_top', true, pf.cards.deploy_top ?? 40);
  }
  return events;
}

function pickChief(world, pf, bkey, rng) {
  const pool = [...world.people.values()].filter(
    (p) => p.age >= C.ADULT_AGE && !p.bureau && p.alive !== false
  );
  if (!pool.length) return null;
  if (pf.promote === 'dynastic') {
    // 前任者の子を継がせる。いなければ既存局長の血縁、それもなければ最年長
    const prev = world.lastChief?.[bkey];
    const heirs = pool.filter((p) => p.fatherId === prev || p.motherId === prev);
    if (heirs.length) return heirs.sort((a, b) => citizenPower(b) - citizenPower(a))[0];
    const kin = pool.filter((p) => Object.values(world.bureaus).includes(p.fatherId));
    if (kin.length) return kin[0];
    return pool.sort((a, b) => b.age - a.age)[0];
  }
  const fn = PROMOTE[pf.promote] || PROMOTE.merit;
  return pool.sort((a, b) => fn(b) - fn(a))[0];
}

function approves(pf, p, world, rng) {
  switch (p.kind) {
    case '粛清具申': return pf.purgeRate > 0;
    case '讒言': return pf.id === 'terror' || pf.id === 'dynastic';
    case '世襲固定': return pf.transparency < 0.4;
    case '抜擢': return pf.transparency > 0.6;
    case '開戦具申': return rng.next() < pf.warAppetite;
    case '温存': return pf.warAppetite < 0.3;
    case '増産': return pf.id === 'agrarian' || world.food < world.people.size * 1.5;
    case '慰撫': return pf.id !== 'terror' && pf.id !== 'purist';
    case '叙勲要求': return pf.id !== 'terror';
    case '予算要求': return rng.next() < 0.5;
    case '引抜': return pf.transparency > 0.5;
    default: return rng.bool(0.5);
  }
}

/** 国境処理の方針。捕虜を受け入れるか、誅殺するか、送還するか。 */
export function borderPolicy(pf, captive, world, rng) {
  switch (pf.captive) {
    case 'kill': return rng.next() < 0.85 ? 'kill' : 'accept';
    case 'return': return rng.next() < 0.75 ? 'return' : 'accept';
    case 'accept': default:
      // 融和以外は、弱い個体を国境で捨てることがある（未発現の才能が優先的に間引かれる）
      if (pf.id === 'melting') return 'accept';
      return citizenPower(captive) < 0.18 && rng.next() < 0.4 ? 'kill' : 'accept';
  }
}

/** 降伏の判断。武断は絶対に折らない。 */
export function wantsSurrender(pf, battle) {
  if (!pf.surrenderAt) return false;
  const h = battle.sides.home;
  return h.cohesion / h.c0 < pf.surrenderAt;
}
