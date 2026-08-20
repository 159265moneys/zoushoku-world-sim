#!/usr/bin/env node
// tools/eval.js — 方針評価器（黒箱）。
//
//   echo '{"policies":[...],"seeds":[...],"gens":200,"opponents":["martial"]}' | node tools/eval.js
//
// stdin から JSON を読み、stdout に JSON だけを返す。進捗は stderr。
// 契約は tools/SEARCH.md。
//
// 絶対規則（SPEC.md / SEARCH.md）
//   ・本物の src/sim/ を叩く。ゲームは書き直さない
//   ・Math.random() は使わない。core/rng.js の RNG だけ。同じ入力から同じ出力
//   ・stdout には JSON 以外を一切出さない
//   ・並列度（--workers）を変えても結果は1ビットも変わらない
//     （1行は (seed, opponent, policy) だけから決まる。スケジューリングに依存しない）
//
// このファイルは tools/ の外を **読むだけ**。src/ と test/ は書き換えない。

import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

import { RNG } from '../src/core/rng.js';
import { PHASE } from '../src/core/model.js';
import {
  createWorld, advanceGeneration, recomputeAggregates,
  setCard, cardOr, CARDS, CARD_BY_ID,
  makeGhost, startWar, stepBattle, runBattle, surrender, settleWar, applyRout,
  takeCaptives, borderDecision, rankNation, CAPTIVE_AXES, citizenPower,
  PROFILES, makeRivalOwner, runRivalTurn,
  createRoster, advanceRoster,
} from '../src/sim/index.js';
// applyProfileToWorld は index.js の公開APIに出ていないので rival.js から直に読む（読むだけ）。
import { applyProfileToWorld } from '../src/sim/rival.js';

// ---------------------------------------------------------------------------
// 方針の語彙
// ---------------------------------------------------------------------------

/** 抜擢の基準。sim の PROFILES[*].promote と同じ語彙でなければならない。 */
export const PROMOTE_IDS = [...new Set(Object.values(PROFILES).map((p) => p.promote))];
export const BORDER_IDS = ['accept', 'kill', 'return'];
/** 捕虜の軸。SEARCH.md はラベル（武力/知性/…）で書くが sim のキーは 武/知/…。両方受ける。 */
const AXIS_BY_ANY = new Map();
for (const a of CAPTIVE_AXES) { AXIS_BY_ANY.set(a.key, a.key); AXIS_BY_ANY.set(a.label, a.key); }
export const AXIS_IDS = CAPTIVE_AXES.map((a) => a.label);
export const OPPONENT_IDS = [...Object.keys(PROFILES), 'ghost'];

// sim が実際に読むカード（cardOr/readCard の呼び出しがある）
const CARDS_READ_BY_SIM = ['deploy_top', 'spare_old', 'raise_young', 'guards', 'drill', 'hunt_ratio', 'mix_policy'];
// オーナー層（この評価器＝rival.js と同じ立場）が配線するカード
const CARDS_WIRED_BY_OWNER = ['frontier', 'surrender_at', 'hereditary'];
// どこにも読み手がいないカード。**評価器では効かない**（不感次元）。
// 勝手に効果を作るとゲームを書き直したことになるので、意図的に空のままにする。
const CARDS_INERT = CARDS.map((c) => c.id)
  .filter((id) => !CARDS_READ_BY_SIM.includes(id) && !CARDS_WIRED_BY_OWNER.includes(id));

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

const DEF = {
  gens: 200,
  warCooldown: 4,        // 連戦の不応期（世代）。roster.js の maybeWars と同じ
  warMinPop: 25,         // これ未満では戦に出さない。roster.js と同じ
  warRule: 'mean',       // 'mean'（roster準拠：双方の戦意の平均） / 'player'（方針の戦意そのもの）
  snapshots: 24,         // 相手国のスナップショット数（世代方向の解像度）
  answers: null,         // 創世の12問。探索空間の外なので既定は中立（0.5）
  foundSeed: null,       // 創始者の遺伝子だけ固定したいとき（ロスターと同じ対照実験にする）
};

const NEUTRAL_ANSWERS = new Array(12).fill(0.5);

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) || 1;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

// ---------------------------------------------------------------------------
// 入力の正規化
// ---------------------------------------------------------------------------

function normalizePolicy(raw, i) {
  const id = raw?.id != null ? String(raw.id) : `p${i}`;
  const cards = {};
  for (const c of CARDS) {
    const v = num(raw?.cards?.[c.id], c.def);
    cards[c.id] = clamp(Math.round(v / c.step) * c.step, c.min, c.max);
  }
  const axis = AXIS_BY_ANY.get(String(raw?.captiveAxis ?? '総合'));
  if (!axis) throw new Error(`policy ${id}: 未知の captiveAxis「${raw?.captiveAxis}」（可: ${AXIS_IDS.join('/')}）`);
  const border = String(raw?.border ?? 'accept');
  if (!BORDER_IDS.includes(border)) throw new Error(`policy ${id}: 未知の border「${border}」（可: ${BORDER_IDS.join('/')}）`);
  const promote = String(raw?.promote ?? 'merit');
  if (!PROMOTE_IDS.includes(promote)) throw new Error(`policy ${id}: 未知の promote「${promote}」（可: ${PROMOTE_IDS.join('/')}）`);
  const warAppetite = clamp(num(raw?.warAppetite, 0.5), 0, 1);
  return { id, cards, captiveAxis: axis, border, promote, warAppetite };
}

function normalizeRequest(input) {
  if (!input || typeof input !== 'object') throw new Error('入力が JSON オブジェクトではない');
  const policies = (input.policies ?? []).map(normalizePolicy);
  if (!policies.length) throw new Error('policies が空');
  const seeds = (input.seeds ?? [1]).map((s) => (Number(s) >>> 0) || 1);
  const gens = Math.max(1, Math.round(num(input.gens, DEF.gens)));
  const opponents = (input.opponents ?? ['ghost']).map(String);
  for (const o of opponents) {
    if (!OPPONENT_IDS.includes(o)) throw new Error(`未知の opponent「${o}」（可: ${OPPONENT_IDS.join('/')}）`);
  }
  const opts = {
    warCooldown: Math.max(1, Math.round(num(input.warCooldown, DEF.warCooldown))),
    warMinPop: Math.max(2, Math.round(num(input.warMinPop, DEF.warMinPop))),
    warRule: input.warRule === 'player' ? 'player' : DEF.warRule,
    snapshots: clamp(Math.round(num(input.snapshots, DEF.snapshots)), 2, 200),
    answers: Array.isArray(input.answers) && input.answers.length ? input.answers.map(Number) : NEUTRAL_ANSWERS,
    foundSeed: input.foundSeed != null ? (Number(input.foundSeed) >>> 0) : null,
  };
  return { policies, seeds, gens, opponents, opts };
}

// ---------------------------------------------------------------------------
// プレイヤーの世界：方針を焼き付ける
// ---------------------------------------------------------------------------

/**
 * 世襲カード → 透過率。
 * 「世襲を尊重する」が高いほど、候補が名家に絞られる（pickChief の透過率）。
 * rival.js の実測値（dynastic hereditary100/透過0.05, merit 0/0.95, melting 10/0.8）に合わせた線形。
 */
const transparencyOf = (hereditary) => clamp(0.95 - 0.9 * (hereditary / 100), 0.05, 0.95);

/**
 * 方針から「自動オーナー」のプロファイルを作る。
 *
 * rival.js の runRivalTurn をそのまま使う（＝ライバル国と同じ手つきで運転する）が、
 * 中身の6項目は外から与えられた方針で置き換える。
 * 探索空間の外にある項目は**中立**に置く。promote を選ぶと prefer や粛清まで
 * 付いてくる形にすると、「抜擢基準」ではなく「思想を丸ごと選ぶ」探索になってしまう。
 */
function makePlayerOwner(policy) {
  const pf = {
    id: 'player', name: 'player', label: 'search policy',
    promote: policy.promote,
    captive: policy.border,
    frontier: policy.cards.frontier / 100,          // 毎世代カードから読み直す
    surrenderAt: policy.cards.surrender_at / 100,   // 同上
    transparency: transparencyOf(policy.cards.hereditary),
    warAppetite: policy.warAppetite,
    // 「殺す」「配る」は v2 のオーナーに解禁されていない（SPEC「v2で解禁されるのは
    // 読む・置く・敷く・裁く まで」）ので、粛清はゼロ、予算は中立。
    purgeThreshold: 1.5, purgeRate: 0, purgeTrigger: 9,
    foreignBias: (policy.cards.mix_policy - 50) / 50,  // 以降は mix_policy カードが毎世代上書きする
    inbreedGuard: 0.25,
    fertBias: 1,
    prefer: null,
    cards: { ...policy.cards },
  };
  return { profile: pf, id: 'player', purged: 0, appointed: 0, wars: 0 };
}

function createPlayerWorld(policy, seed, opts) {
  const world = createWorld(seed, opts.answers, opts.foundSeed != null ? { foundSeed: opts.foundSeed } : {});
  const owner = makePlayerOwner(policy);
  // 「敷く」：12枚を全部オンにして置く。オフのカードは効かない仕様なので、
  // 探索空間＝12次元の連続値であるためには全部オンでなければならない。
  applyProfileToWorld(world, owner);   // カード・透過率・交配レバー・予算をまとめて焼く
  for (const c of CARDS) setCard(world, c.id, true, policy.cards[c.id]);
  world.profileId = 'player';
  return { world, owner };
}

/** 毎世代、局長の人格を通した実効値でオーナー側の配線を引き直す。 */
function refreshOwnerWiring(world, owner) {
  const pf = owner.profile;
  pf.frontier = cardOr(world, 'frontier', 20) / 100;
  world.transparency = transparencyOf(cardOr(world, 'hereditary', 50));
}

// ---------------------------------------------------------------------------
// 戦争
// ---------------------------------------------------------------------------

/** 1戦を最後まで回して、勝ったかどうかを返す。roster.js の warBetween と同じ順番。 */
function fight(world, oppView, rng, policy) {
  const battle = startWar(world, rng, oppView);
  battle.homeName = '自国';
  battle.opponentRuthless = !!oppView.ruthless;

  // 降伏は「団結がN%を割ったら降伏具申」カード。0 なら折らない。
  // 局長の人格で歪んだ実効値を使う（cardOr）。
  const surrenderAt = cardOr(world, 'surrender_at', 0) / 100;
  let guard = 80;
  while (!battle.over && guard-- > 0) {
    if (!battle.surrenderOffered && surrenderAt > 0) {
      const h = battle.sides.home;
      if (h.cohesion / h.c0 < surrenderAt) { surrender(battle); if (battle.over) break; }
    }
    stepBattle(battle, rng);
  }
  if (!battle.outcome) runBattle(battle, rng);

  applyRout(battle, rng);
  settleWar(world, battle, rng);

  // 捕虜：勝者だけが軸を選べる。国境処理は方針そのまま（誅殺／送還／受け入れ）。
  const caps = takeCaptives(world, battle, policy.captiveAxis, rng, 'home') ?? [];
  for (const c of caps) borderDecision(world, c.id, policy.border);
  recomputeAggregates(world);

  return { won: battle.outcome?.winner === 'home', captives: caps.length };
}

/** 初戦（10体到達時の強制戦争）の相手は「隣の村」。設計どおり同格・同規模のゴースト。 */
function villageGhost(seed, gen) {
  return makeGhost(hash32(`first|${seed}|${gen}`), PHASE.VILLAGE, 1);
}

// ---------------------------------------------------------------------------
// 相手国：実際に走ったロスターのスナップショット
// ---------------------------------------------------------------------------

/**
 * 個体を凍らせる。genes と hap は生成後に書き換わらない（gamete が値コピーを返す）ので
 * 参照のまま共有し、時間で変わるもの（練度・発現・年齢・怨恨…）だけ複製する。
 */
function freezeIndividual(p) {
  return {
    ...p,
    skills: { ...p.skills },
    expressed: { ...p.expressed },
    lineage: { ...p.lineage },
    grudges: {},
    deeds: p.deeds.length > 4 ? p.deeds.slice(-4) : p.deeds.slice(),
    titles: p.titles.slice(),
    ledger: [],
  };
}

/** その世代の相手国の姿。roster.js の nationView と同じ形（startWar が食える）。 */
function freezeNation(nation) {
  const people = [];
  for (const p of nation.world.people.values()) {
    if (p.age < 2) continue;              // nationView と同じ足切り
    people.push(freezeIndividual(p));
  }
  rankNation(people);
  let strength = 0;
  for (const p of people) strength += citizenPower(p);   // nationView と同じ出し方
  const pf = PROFILES[nation.profile];
  return {
    gen: nation.world.gen,
    view: {
      key: nation.id, name: nation.name, people, strength,
      deployTop: pf.deployTop, ruthless: pf.surrenderAt === 0,
      powerIndex: nation.world.powerIndex,
    },
  };
}

/**
 * 10国のロスターを gens 世代走らせて、必要な国だけスナップショットを取る。
 *
 * 相手は「作者が書いたCPU」ではなく、同じ createWorld / advanceGeneration で
 * 実際に走った世界でなければならない（SPEC の第2の柱）。だからここは roster.js を
 * そのまま回して、途中経過を凍らせて使う。
 * 走らせ終わったらロスター本体は捨てる（スナップショットだけ残す）。
 */
export function buildOpponentSnapshots(seed, gens, wanted, snapshots, onTick) {
  const roster = createRoster(seed);
  const rng = new RNG(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
  const need = roster.nations.filter((n) => wanted.includes(n.id));
  const every = Math.max(1, Math.round(gens / snapshots));
  const out = new Map(need.map((n) => [n.id, []]));

  for (const n of need) out.get(n.id).push(freezeNation(n));
  for (let g = 1; g <= gens; g++) {
    advanceRoster(roster, rng, 1);
    if (g % every === 0 || g === gens) {
      for (const n of need) out.get(n.id).push(freezeNation(n));
    }
    if (onTick && g % 25 === 0) onTick(g, gens);
  }
  return out;
}

/** その世代に一番近い（それ以前の）スナップショット。 */
function snapAt(list, gen) {
  let best = list[0];
  for (const s of list) { if (s.gen <= gen) best = s; else break; }
  return best;
}

// ---------------------------------------------------------------------------
// 1行の評価
// ---------------------------------------------------------------------------

function evaluate(policy, seed, opponentId, gens, opts, snaps) {
  const { world, owner } = createPlayerWorld(policy, seed, opts);
  // 乱数列は (seed, opponent) だけから決める。方針が違っても同じ場所から始まるので、
  // 方針どうしの比較が対応のある比較になる（common random numbers）。
  const rng = new RNG(hash32(`play|${seed}|${opponentId}`));

  const oppPf = PROFILES[opponentId];
  const warProb = opts.warRule === 'player' || !oppPf
    ? policy.warAppetite
    : (policy.warAppetite + oppPf.warAppetite) / 2;

  let wins = 0, losses = 0, wars = 0, captives = 0, lastWar = -99, gensDone = 0;
  let error = null;

  try {
    for (let g = 0; g < gens; g++) {
      refreshOwnerWiring(world, owner);
      runRivalTurn(world, owner, rng);       // 置く／裁く／敷く（殺すは v2 の枠外なので撃たない）
      advanceGeneration(world, rng);
      gensDone = world.gen;
      if (!world.people.size) break;

      // 初戦：10体に達したら強制。ここを通さないとフェーズ2に上がれない
      if (world.pendingFirstWar) {
        const r = fight(world, villageGhost(seed, world.gen), rng, policy);
        wars++; captives += r.captives; lastWar = world.gen;
        if (r.won) wins++; else losses++;
      } else if (
        world.phase === PHASE.TRIBE &&
        world.people.size >= opts.warMinPop &&
        (world.gen - lastWar) >= opts.warCooldown &&
        rng.bool(warProb)
      ) {
        const view = opponentId === 'ghost'
          ? makeGhost(hash32(`ghost|${seed}|${world.gen}`), world.phase, 1)
          : snapAt(snaps.get(opponentId), world.gen).view;
        if (view.people.length >= 2) {
          const r = fight(world, view, rng, policy);
          wars++; captives += r.captives; lastWar = world.gen;
          if (r.won) wins++; else losses++;
        }
      }
      if (!world.people.size) break;
    }
  } catch (e) {
    error = String(e?.message ?? e);
  }

  const st = world.stats[world.stats.length - 1] || {};
  const pop = world.people.size;
  const row = {
    id: policy.id, seed, opponent: opponentId,
    power: pop ? world.powerIndex : 0,
    pop,
    gens: gensDone,
    extinct: pop === 0,
    wins, losses,
    admixture: r3(st.admixture ?? 0),
    morale: r3(pop ? world.morale : 0),
    regimeGrudge: r3((world.regimeGrudge ?? 0) * 100),
    yieldRate: r3(world.yieldRate ?? 0),
    // 以下は契約の外。クラスタリング用に安いものだけ添える（無視してよい）
    wars, captives,
    phase: world.phase,
    homoz: r3(st.homoz ?? 0),
    foreign: r3(st.foreign ?? 0),
    rebellions: world.rebellions ?? 0,
    food: r3(world.food ?? 0),
  };
  if (error) row.error = error;
  return row;
}

// ---------------------------------------------------------------------------
// タスク（1タスク＝1つの種。相手国のロスターは種ごとに1回だけ走らせる）
// ---------------------------------------------------------------------------

function buildTasks(req, workers) {
  const nSeeds = req.seeds.length;
  const nPol = req.policies.length;
  // 相手国のロスター（10国×gens世代）は種ごとに1回しか作りたくないので、
  // 1タスク＝1つの種を原則にする。種がワーカーより少ないときだけ方針側を割る。
  // 割った分だけロスターを作り直すことになるが、同時に走るので実時間は増えない。
  const chunksPerSeed = nSeeds >= workers ? 1 : Math.max(1, Math.min(nPol, Math.ceil(workers / nSeeds)));
  const size = Math.ceil(nPol / chunksPerSeed);
  const tasks = [];
  for (let si = 0; si < nSeeds; si++) {
    for (let s = 0; s < nPol; s += size) {
      tasks.push({ seed: req.seeds[si], from: s, to: Math.min(nPol, s + size) });
    }
  }
  return tasks;
}

/** ワーカー1つぶんの仕事。ロスターは種ごとにキャッシュして使い回す。 */
function runTask(req, task, cache, log) {
  const rosterOpps = req.opponents.filter((o) => o !== 'ghost');
  let snaps = new Map();
  if (rosterOpps.length) {
    const key = `${task.seed}|${req.gens}|${req.opts.snapshots}|${rosterOpps.slice().sort().join(',')}`;
    if (cache.has(key)) {
      snaps = cache.get(key);
      cache.delete(key); cache.set(key, snaps);   // 参照したものを新しい側へ（LRU）
    } else {
      const t0 = Date.now();
      snaps = buildOpponentSnapshots(task.seed, req.gens, rosterOpps, req.opts.snapshots);
      if (log) log(`roster seed=${task.seed} 10国×${req.gens}世代 ${Date.now() - t0}ms`);
      cache.set(key, snaps);
      // メモリの上限。1件（相手3国×24枚）で実測65MBある。増やすときは覚悟して増やす
      while (cache.size > (req.opts.rosterCache ?? 2)) cache.delete(cache.keys().next().value);
    }
  }
  const rows = [];
  for (let i = task.from; i < task.to; i++) {
    for (const opp of req.opponents) {
      rows.push(evaluate(req.policies[i], task.seed, opp, req.gens, req.opts, snaps));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ワーカー側
// ---------------------------------------------------------------------------

if (!isMainThread) {
  let REQ = null;
  const cache = new Map();
  parentPort.on('message', (msg) => {
    try {
      if (msg.type === 'batch') { REQ = msg.req; parentPort.postMessage({ type: 'ready' }); return; }
      if (msg.type === 'task') {
        const rows = runTask(REQ, msg.task, cache, (s) => parentPort.postMessage({ type: 'log', text: s }));
        parentPort.postMessage({ type: 'result', id: msg.id, rows });
        return;
      }
      if (msg.type === 'stop') process.exit(0);
    } catch (e) {
      parentPort.postMessage({ type: 'fatal', id: msg?.id ?? null, error: String(e?.stack ?? e) });
    }
  });
}

// ---------------------------------------------------------------------------
// 親側：ワーカープール
// ---------------------------------------------------------------------------

/**
 * ワーカープール。ハンドラは1度だけ張って、リクエストごとに差し替えない
 * （常駐モードでバッチを繰り返してもリスナが積み上がらないようにする）。
 */
class Pool {
  constructor(n) {
    this.workers = [];
    this.state = null;      // 実行中のバッチ
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL(import.meta.url));
      w.on('message', (m) => this._onMessage(w, m));
      w.on('error', (e) => this.state?.reject(e));
      this.workers.push(w);
    }
  }
  _onMessage(w, m) {
    const st = this.state;
    if (!st) return;
    if (m.type === 'log') { st.onLog?.(m.text); return; }
    if (m.type === 'ready') { st.ready?.(w); return; }
    if (m.type === 'fatal') { st.reject(new Error(m.error)); return; }
    if (m.type !== 'result') return;
    st.results[m.id] = m.rows;
    st.done++;
    st.onRows?.(m.rows.length, st.done, st.tasks.length);
    if (st.done === st.tasks.length) { this.state = null; st.resolve(st.results.flat()); }
    else st.feed(w);
  }
  broadcast(req) {
    return new Promise((resolve, reject) => {
      let n = 0;
      this.state = {
        tasks: [], results: [], done: 0, reject,
        ready: () => { if (++n === this.workers.length) { this.state = null; resolve(); } },
      };
      for (const w of this.workers) w.postMessage({ type: 'batch', req });
    });
  }
  run(tasks, onRows, onLog) {
    if (!tasks.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      // 動的ディスパッチ＋種の親和性。同じ種のタスクは同じワーカーへ寄せて、
      // ロスターのキャッシュに当てる（作り直すと1回10秒級の無駄になる）。
      const pending = tasks.map((t, id) => ({ id, task: t }));
      const lastSeed = new Map();
      const feed = (w) => {
        if (!pending.length) return;
        const want = lastSeed.get(w);
        let i = want != null ? pending.findIndex((p) => p.task.seed === want) : -1;
        if (i < 0) i = 0;
        const [job] = pending.splice(i, 1);
        lastSeed.set(w, job.task.seed);
        w.postMessage({ type: 'task', id: job.id, task: job.task });
      };
      this.state = {
        tasks, results: new Array(tasks.length), done: 0,
        resolve, reject, onRows, onLog, feed,
      };
      for (const w of this.workers) feed(w);
    });
  }
  async stop() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

// ---------------------------------------------------------------------------
// バッチ実行
// ---------------------------------------------------------------------------

async function runBatch(input, cfg, pool) {
  const req = normalizeRequest(input);
  req.opts.rosterCache = cfg.rosterCache;
  const total = req.policies.length * req.seeds.length * req.opponents.length;
  const t0 = Date.now();
  const say = (s) => { if (!cfg.quiet) process.stderr.write(`[eval] ${s}\n`); };
  say(`policies=${req.policies.length} seeds=${req.seeds.length} opponents=${req.opponents.length} gens=${req.gens} → ${total}行`);

  const tasks = buildTasks(req, cfg.workers);
  let rows;
  if (!pool) {
    const cache = runBatch.cache || (runBatch.cache = new Map());
    rows = [];
    for (const t of tasks) {
      rows.push(...runTask(req, t, cache, say));
      say(`${rows.length}/${total}行 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  } else {
    await pool.broadcast(req);
    let doneRows = 0, lastSay = 0;
    rows = await pool.run(tasks, (n, done) => {
      doneRows += n;
      if (Date.now() - lastSay > 1500 || done === tasks.length) {
        lastSay = Date.now();
        const el = (Date.now() - t0) / 1000;
        const eta = doneRows ? (el / doneRows) * (total - doneRows) : 0;
        say(`${doneRows}/${total}行 ${el.toFixed(1)}s（残り ${eta.toFixed(0)}s）`);
      }
    }, say);
  }

  const ms = Date.now() - t0;
  say(`完了 ${rows.length}行 ${(ms / 1000).toFixed(1)}s（1行あたり ${(ms / Math.max(1, rows.length)).toFixed(0)}ms・並列${cfg.workers}）`);
  return {
    results: rows,
    meta: {
      rows: rows.length, ms, workers: cfg.workers, gens: req.gens,
      seeds: req.seeds.length, policies: req.policies.length, opponents: req.opponents,
      warRule: req.opts.warRule, warCooldown: req.opts.warCooldown, warMinPop: req.opts.warMinPop,
      // 探索側への申し送り：この2枚は sim にもオーナー層にも読み手がいない＝効かない次元
      inertCards: CARDS_INERT,
      cardsReadBySim: CARDS_READ_BY_SIM,
      cardsWiredByOwner: CARDS_WIRED_BY_OWNER,
      errors: rows.filter((r) => r.error).length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { workers: Math.max(1, (availableParallelism?.() ?? 4) - 1), quiet: false, serve: false, rosterCache: 2 };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--workers' || s === '-w') a.workers = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (s.startsWith('--workers=')) a.workers = Math.max(1, parseInt(s.split('=')[1], 10) || 1);
    else if (s === '--roster-cache') a.rosterCache = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (s.startsWith('--roster-cache=')) a.rosterCache = Math.max(1, parseInt(s.split('=')[1], 10) || 1);
    else if (s === '--quiet' || s === '-q') a.quiet = true;
    else if (s === '--serve') a.serve = true;
    else if (s === '--help' || s === '-h') a.help = true;
  }
  return a;
}

const HELP = `方針評価器。stdin から JSON、stdout に JSON。

  node tools/eval.js [--workers N] [--quiet] [--serve] < request.json

  --workers N   ワーカースレッド数（既定：コア数-1）。結果は並列度に依存しない
  --quiet       stderr の進捗を止める
  --serve       常駐モード。stdin の1行＝1リクエスト、stdout の1行＝1レスポンス。
                相手国のロスターをリクエスト間で使い回すので、反復探索が速い
  --roster-cache N  ワーカー1つが抱える相手国スナップショットの数（既定2）。
                    1件＝相手3国×24枚で実測65MB。--serve で種を固定するなら増やす価値がある

入力: {"policies":[{"id","cards":{12枚},"captiveAxis","border","promote","warAppetite"}],
       "seeds":[...], "gens":200, "opponents":["martial",...,"ghost"]}
      任意: "warRule":"mean"|"player"（既定 mean＝roster.js と同じ「双方の戦意の平均」。
            player にすると戦の頻度が warAppetite だけで決まる）
            "warCooldown":4  "warMinPop":25  "snapshots":24
            "answers":[12個]（創世の12問。既定は中立0.5）  "foundSeed":N（創始者を固定）
出力: {"results":[{"id","seed","opponent","power","pop","gens","extinct","wins","losses",
                  "admixture","morale","regimeGrudge","yieldRate", ...}], "meta":{...}}
      meta.inertCards ＝ sim にもオーナー層にも読み手がいないカード（動かしても何も起きない）

captiveAxis: ${AXIS_IDS.join(' / ')}
border:      ${BORDER_IDS.join(' / ')}
promote:     ${PROMOTE_IDS.join(' / ')}
opponents:   ${OPPONENT_IDS.join(' / ')}
`;

function readStdin() {
  return new Promise((res, rej) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', rej);
  });
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) { process.stderr.write(HELP); return; }

  const pool = cfg.workers > 1 ? new Pool(cfg.workers) : null;

  if (!cfg.serve) {
    const text = await readStdin();
    let out;
    try {
      out = await runBatch(JSON.parse(text), cfg, pool);
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }) + '\n');
      await pool?.stop();
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(out) + '\n');
    await pool?.stop();
    return;
  }

  // 常駐モード：NDJSON。1行1リクエスト。
  let buf = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        try {
          const out = await runBatch(JSON.parse(line), cfg, pool);
          process.stdout.write(JSON.stringify(out) + '\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }) + '\n');
        }
      });
    }
  });
  process.stdin.on('end', () => { chain.then(async () => { await pool?.stop(); }); });
}

if (isMainThread && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
