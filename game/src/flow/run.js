// flow/run.js — 1回のプレイ＝ `run`。状態遷移の本体（R-950）。
//
//   ui  →  flow  →  sim  →  core
//
// run が持つもの：world / roster / rng / stage / clock / prev。
// **状態は world に持つ。flow は状態を溜め込まない**——ここに置いてあるのは
// 「world から作り直せない進行の都合」だけ（stage・tickInGen・prev・notices・faults）。
//
// この層は戦争の4関数（startWar / settleWar / takeCaptives / borderDecision）を
// 一度も呼ばない。呼べるのは flow/war.js だけ（R-951）。
//
// 掟：DOM も window も知らない。Math.random() を書かない。Date.now() を読まない。

import * as sim from '../sim/index.js';
import { RNG } from '../core/rng.js';
import {
  PHASE, STAGE, WAR_STAGES, TICKS_PER_GEN, EXTINCT_POP, HUNDRED,
  TRIBE_CARDS, TRIBE_TRANSPARENCY, VILLAGE_CAP, stageOf,
} from './rules.js';
import * as clock from './clock.js';
import * as village from './village.js';

export { STAGE };

/**
 * 世界をひらく。
 * @param {{seed:number, answers?:any, name?:string, foundSeed?:number, roster?:boolean}} o
 */
export function createRun(o = {}) {
  const seed = (o.seed ?? 1) >>> 0;
  const answers = o.answers ?? [];
  const world = sim.createWorld(seed, answers, {
    name: o.name ?? '我らのシャーレ',
    species: o.species ?? null,
    responses: o.responses ?? null,
    ...(o.foundSeed != null ? { foundSeed: o.foundSeed } : {}),
  });

  const run = {
    seed,
    world,
    rng: new RNG(seed),
    roster: null,
    stage: STAGE.VILLAGE_GROW,

    // 時計（clock.js が読む）
    speed: 1,
    paused: false,
    tickInGen: 0,

    // R-941：前の世代の値。**進行層が持っていないと UI は差分を出せない**
    prev: null,
    report: null,

    // 進行中の戦（war.js が入れる）
    war: null,
    lastBattle: null,
    lastWar: null,
    refusal: null,

    // 一度だけ出す知らせ（上限・旅立ち・部族・100体・行き止まり）
    notices: [],
    // 握りつぶさない失敗。ロスターが1回落ちて永久に止まる事故（#19）を見えるようにする
    faults: [],

    tribeStarted: false,
    fullNoticed: false,
    hundredNoticed: false,
    endNoticed: false,
  };

  if (o.roster !== false) {
    try { run.roster = sim.createRoster(seed); }
    catch (e) { fault(run, 'createRoster', e); run.roster = null; }
  }

  // P1では方針カードを1枚も立てない（R-964）。既定は sim の defaultCards（全オフ）のまま
  village.beforeGeneration(run);          // 第0世代から fertBias と透過率を効かせる
  run.stage = stageOf(world);
  return run;
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

/** world の値から stage を作り直す。戦争の途中（WAR_STAGES）では触らない */
export function refreshStage(run) {
  if (WAR_STAGES.has(run.stage)) return run.stage;
  run.stage = stageOf(run.world);
  return run.stage;
}

/** 世代を進めてよい stage か。S10：戦争が締まるまで advanceGeneration は解禁されない */
export function canAdvanceGeneration(run) {
  const st = refreshStage(run);
  return st === STAGE.VILLAGE_GROW || st === STAGE.TRIBE;
}

/** いま時計が動いてよいか（R-956） */
export function isRunning(run) { return clock.isRunning(run); }
/** 動いていない理由（R-943） */
export function stopReason(run) { return clock.stopReason(run); }

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

/**
 * n tick 進めようとして、**実際に進んだ数**を返す。
 * - `VILLAGE_FULL` / 戦争中 / 行き止まり では **1回も進まない**（R-956）
 * - 世代の境界では止まる。そこから先は advanceGeneration の仕事
 */
export function advanceTicks(run, n = 1) {
  if (!run || !run.world) return 0;
  refreshStage(run);
  if (!clock.isRunning(run)) return 0;

  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (run.tickInGen >= TICKS_PER_GEN) break;      // 世代境界。advanceGeneration を待つ
    sim.stepTick(run.world, run.rng);
    run.tickInGen++;
    moved++;
    if (run.world.people.size < EXTINCT_POP) { refreshStage(run); break; }
  }
  return moved;
}

/** 世代の境界に着いていて、advanceGeneration を待っているか */
export function atGenBoundary(run) {
  return run.tickInGen >= TICKS_PER_GEN;
}

// ---------------------------------------------------------------------------
// 世代
// ---------------------------------------------------------------------------

/**
 * 1世代進める。刻み（残りの tick）もここで消化する。
 * @returns {Array} その世代の事件（旅立ちも含む）。進めなかったときは空配列
 */
export function advanceGeneration(run) {
  const w = run.world;
  if (!canAdvanceGeneration(run)) return [];

  // R-941：**世代を触る前**の値を1つ前として残す。UI はこれと現在値の差を出す
  run.prev = snapshot(w);

  // 段A（R-954）：fertBias を絞り、P1の透過率を 0.9 に固定する（R-957）
  village.beforeGeneration(run);

  let res;
  try {
    res = sim.advanceGeneration(w, run.rng) || {};
  } catch (e) {
    fault(run, 'advanceGeneration', e);
    throw e;                         // 世代が進まないのは致命。握りつぶさない
  }
  const events = res.events || [];
  run.report = res.report || null;
  run.tickInGen = 0;

  // 段B（R-954 / R-955）：あふれた新生児だけを村から出す
  events.push(...village.afterGeneration(run));

  stepRoster(run);

  if (w.phase !== PHASE.VILLAGE && !run.tribeStarted) enterTribe(run);

  refreshStage(run);
  noticeMilestones(run);
  return events;
}

/** 前の世代の値（R-941 / 07-A-1）。前の値が無い数字は増減すら伝わらない */
function snapshot(w) {
  return {
    gen: w.gen,
    pop: w.people.size,
    food: w.food,
    yieldRate: w.yieldRate,
    consumption: w.consumption,
    morale: w.morale,
    land: w.land,
    landFactor: w.landFactor,
  };
}

/**
 * ロスターを1世代進める。
 * 空の catch で握りつぶすと、1回落ちただけで隣の10国が永久に止まる（#19）。
 * 落ちたことは run.faults に残して先へ進む。
 */
function stepRoster(run) {
  if (!run.roster) return;
  try { sim.advanceRoster(run.roster, run.rng); }
  catch (e) { fault(run, 'advanceRoster', e); }
}

// ---------------------------------------------------------------------------
// 部族に上がった瞬間（R-964 / R-320）
// ---------------------------------------------------------------------------

function enterTribe(run) {
  const w = run.world;
  run.tribeStarted = true;
  // 透過率を 0.5 に戻す。**ここが「世襲が起動する」瞬間**（以降は hereditary が握る）
  w.transparency = TRIBE_TRANSPARENCY;
  const put = [];
  for (const c of TRIBE_CARDS) {
    const slot = sim.setCard(w, c.id, true, c.value);
    if (slot) put.push({ id: c.id, value: slot.value, why: c.why });
    else fault(run, 'setCard', new Error(`カード ${c.id} が sim に無い`));
  }
  run.notices.push({
    kind: '部族', gen: w.gen, cards: put,
    text: '村が部族になった。もう一人ずつ手で置くことはできない。',
  });
}

// ---------------------------------------------------------------------------
// 節目の知らせ（R-965：崩壊を宣言しない）
// ---------------------------------------------------------------------------

function noticeMilestones(run) {
  const w = run.world;

  // 上限に着いた。時計はここで完全に止まる（R-956）
  if (run.stage === STAGE.VILLAGE_FULL) {
    if (!run.fullNoticed) {
      run.fullNoticed = true;
      run.notices.push(village.fullNotice(w));
    }
  } else {
    run.fullNoticed = false;
  }

  // v2の終端。**世界は止めない**（R-011）
  if (!run.hundredNoticed && w.people.size >= HUNDRED) {
    run.hundredNoticed = true;
    run.notices.push({
      kind: '百', gen: w.gen, pop: w.people.size,
      text: `${w.people.size}人になりました。村は部族になり、部族は国になろうとしています。`
        + 'ここから先は、まだ作られていません。',
      choices: ['年代記を最初から読む', 'このまま続ける'],
    });
  }

  // 止めるのはここだけ。「負け」とは書かない（R-010 / R-965）
  if (!run.endNoticed && w.people.size < EXTINCT_POP) {
    run.endNoticed = true;
    const last = [...w.people.values()][0] || null;
    run.notices.push({
      kind: '行き止まり', gen: w.gen, pop: w.people.size,
      last: last ? { id: last.id, name: last.name } : null,
      yieldRate: w.yieldRate, consumption: w.consumption, food: w.food,
      text: last
        ? `この村はもう増えません。残っているのは ${last.name} ひとりです。`
        : 'この村はもう増えません。誰もいなくなりました。',
      choices: ['この世界を最後まで見る', '同じ種族で、もう一度はじめる'],
    });
  }
}

/** 溜まった知らせを取り出す（取り出したら消える） */
export function takeNotices(run) {
  const out = run.notices;
  run.notices = [];
  return out;
}

// ---------------------------------------------------------------------------
// 上帯が読む値（R-987 / R-941）
// ---------------------------------------------------------------------------

/** 世界の現在値と、1つ前の世代との差。**差が出せるのは進行層が prev を持つから** */
export function readTop(run) {
  const w = run.world;
  const now = snapshot(w);
  const prev = run.prev;
  const d = (k) => (prev && prev[k] != null ? now[k] - prev[k] : null);
  return {
    stage: run.stage,
    gen: w.gen, pop: w.people.size, cap: w.phase === PHASE.VILLAGE ? VILLAGE_CAP : HUNDRED,
    food: w.food, yieldRate: w.yieldRate, consumption: w.consumption, morale: w.morale,
    delta: { pop: d('pop'), food: d('food'), yieldRate: d('yieldRate'), consumption: d('consumption'), morale: d('morale') },
    running: clock.isRunning(run),
    stopReason: clock.stopReason(run),
    genProgress: clock.genProgress(run),
    genMs: clock.genMs(w),
  };
}

// ---------------------------------------------------------------------------
function fault(run, where, e) {
  run.faults.push({
    gen: run.world ? run.world.gen : -1, where,
    message: e && e.message ? e.message : String(e),
  });
}
