// ============================================================================
// flow-route.js — 「UIの経路」を1つの入口にまとめる層。G群（test/flow.js）専用。
//
// 【この層が要る理由】
//   G群が見張るのは **継ぎ目** であって sim ではない。sim を直接叩く検査は
//   「UIが本当に踏んでいる順番」を一度も通らないので、13項目が緑のまま
//   ゲームが起動していない、という事故をそのまま素通しする（REQUIREMENTS 10章 段0）。
//   だから G群は必ずこのファイル越しに世界を触る。
//
// 【2つの経路】
//   'flow' … `src/flow/` があればそれを使う（段1以降の本番の経路）。契約は §B。
//   'ui'   … まだ `src/flow/` が無いときの経路。**いまのUIが実際に踏んでいる順番**を
//            そのまま再現する。呼び口は `ui/adapter.js` の `makeAdapter` と、
//            `ui/api.js` と同じ解決順（bridge → 生の sim）。
//            再現元は次の4か所で、ここを直したらこのファイルも直すこと：
//              ui/main.js:141,169        tick と世代
//              ui/panels/battle.js:12    startWar → stepBattle → surrender
//              ui/panels/border.js:13,54,66,124
//                                        captiveOptions → takeCaptives
//                                        → borderDecision → **settleWar（最後）**
//              ui/main.js:82             createRoster / registerRoster
//
// 【順番はこの層が持つ。検査は結果だけを読む】
//   G群のそれぞれは「どういう順で呼ぶか」を書かない。`warOnce()` が返す記録を読むだけ。
//   順番が変わる（＝段1で flow/ が入る）とき、書き換わるのはこのファイル1枚で済む。
//
// 絶対規則：Math.random() を書かない / Date.now() に依存した挙動を書かない。
// ============================================================================

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { RNG } from '../src/core/rng.js';
import { PHASE } from '../src/core/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// 世界の名前は main.js と同じにしておく（画面の文言がここから出る）
const WORLD_NAME = '我らのシャーレ';

// ---------------------------------------------------------------------------
// §A  経路をひらく
// ---------------------------------------------------------------------------

/**
 * 検査に使う経路を1つ返す。
 * @param {{prefer?: 'flow'|'ui'}} opts
 */
export async function openRoute(opts = {}) {
  const sim = await import(pathToFileURL(join(SRC, 'sim', 'index.js')).href);
  const flowRun = join(SRC, 'flow', 'run.js');
  const wantFlow = opts.prefer !== 'ui';

  if (wantFlow && existsSync(flowRun)) {
    try {
      return await makeFlowRoute(sim);
    } catch (e) {
      // flow/ はあるが契約と合わない。黙って ui 経路に落ちると
      // 「flow を検査したつもりで UI を検査していた」になるので、必ず言う。
      const r = await makeUiRoute(sim);
      r.warn = `src/flow/ はあるが契約と合わない（${e.message}）。UI経路で測っている。`;
      return r;
    }
  }
  return await makeUiRoute(sim);
}

// ---------------------------------------------------------------------------
// §B  flow 経路（段1で `src/flow/` が入ったらここが本番になる）
//
// 期待している公開面。段1の実装と食い違ったら、**実装側ではなくここを直す**
// （検査が実装に合わせて曲がると、検査の意味が消える。ただし名前だけの違いは
//  ここで吸収してよい。順番の違いは吸収してはいけない）。
//
//   flow/run.js   createRun({ seed, answers, name }) -> run
//                 run.world / run.roster / run.rng / run.stage / run.prev
//                 advanceTicks(run, n) -> 実際に進んだ tick 数
//                 advanceGeneration(run) -> events[]
//   flow/war.js   warReason(run) -> { ok, reason, remainMs }
//                 listTargets(run) -> 相手候補[]
//                 plannedForce(run, target) -> { n, units }
//                 beginWar(run, target) -> war | null       （S0）
//                 stepWar(run, war) -> void                 （S1）
//                 surrenderWar(run, war) -> { options[] }   （S2）
//                 settle(run, war, { priceIndex }) -> void  （S3〜S5）
//                 captiveOptions(run, war) -> { axes[] }    （S6）
//                 takeCaptives(run, war, axis) -> captives[]（S7）
//                 borderDecide(run, capId, decision)        （S8）
//                 finishWar(run, war)                       （S9）
// ---------------------------------------------------------------------------

async function makeFlowRoute(sim) {
  const run = await import(pathToFileURL(join(SRC, 'flow', 'run.js')).href);
  const war = await import(pathToFileURL(join(SRC, 'flow', 'war.js')).href);
  const need = {
    'run.js': ['createRun', 'advanceTicks', 'advanceGeneration'],
    'war.js': ['warReason', 'listTargets', 'plannedForce', 'beginWar', 'stepWar',
      'surrenderWar', 'settle', 'captiveOptions', 'takeCaptives', 'borderDecide'],
  };
  const missing = [];
  for (const k of need['run.js']) if (typeof run[k] !== 'function') missing.push(`run.${k}`);
  for (const k of need['war.js']) if (typeof war[k] !== 'function') missing.push(`war.${k}`);
  if (missing.length) throw new Error(`足りない：${missing.join(', ')}`);

  return {
    kind: 'flow',
    label: 'src/flow/（進行層）',
    sim,
    hasFlow: true,
    newRun(seed, answers = {}) {
      const r = run.createRun({ seed, answers, name: WORLD_NAME });
      return wrapRun(r, {
        sim,
        kind: 'flow',
        ticks: (n) => run.advanceTicks(r, n),
        // 1世代ぶん（tick も含めて）進める。flow 側が刻みを持つ。
        generation: () => run.advanceGeneration(r),
        stage: () => r.stage,
        prev: () => r.prev,
        warReason: () => war.warReason(r),
        targets: () => war.listTargets(r),
        plannedForce: (t) => war.plannedForce(r, t),
        war: warSteps(war, r),
      });
    },
  };
}

/** flow/war.js の S0〜S9 を warOnce が呼ぶ形にそろえる。順番は flow 側が持つ。 */
function warSteps(war, r) {
  return {
    begin: (t) => war.beginWar(r, t),
    step: (w) => war.stepWar(r, w),
    surrender: (w) => war.surrenderWar(r, w),
    settle: (w, o) => war.settle(r, w, o),
    captiveOptions: (w) => war.captiveOptions(r, w),
    takeCaptives: (w, axis) => war.takeCaptives(r, w, axis),
    borderDecide: (id, d) => war.borderDecide(r, id, d),
    finish: (w) => (war.finishWar ? war.finishWar(r, w) : undefined),
    // flow 経路の決着後の順番は flow/war.js が持つ（S3→S4→S5→S6→S7→S8→S9）。
    order: 'settle-first',
  };
}

// ---------------------------------------------------------------------------
// §C  ui 経路（いまここ）
// ---------------------------------------------------------------------------

async function makeUiRoute(sim) {
  const { makeAdapter, setRoster } = await import(pathToFileURL(join(SRC, 'ui', 'adapter.js')).href);
  const A = makeAdapter(sim);

  // ui/api.js と同じ解決順。mock は入れない（mock で埋まったまま緑になると、
  // 「本物が無い」ことが検査から見えなくなる）。
  const api = new Proxy({}, {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (k in A && A[k] !== undefined) return A[k];
      return sim[k];
    },
  });

  // ui/cards.js の既定値流し込み（main.js:81）。段1で消える予定のファイルなので、
  // 消えていても検査が落ちないようにする。
  let seedCards = null;
  try {
    const m = await import(pathToFileURL(join(SRC, 'ui', 'cards.js')).href);
    seedCards = m.seedCards || null;
  } catch { seedCards = null; }

  const TPG = A.TICKS_PER_GEN ?? 12;

  return {
    kind: 'ui',
    label: 'ui/adapter.js（いまのUIの呼び順）',
    sim,
    hasFlow: false,
    note: 'src/flow/ がまだ無い。段1でここが flow 経路に切り替わる。',
    newRun(seed, answers = {}) {
      const world = api.createWorld(seed, answers, { name: WORLD_NAME });
      const rng = new RNG(seed);
      if (seedCards) { try { seedCards(api, world); } catch { /* 既定値は無くても続く */ } }
      let roster = null;
      try { roster = api.createRoster ? api.createRoster(seed) : null; } catch { roster = null; }
      setRoster(roster);

      const r = { world, roster, rng, api, seed };

      return wrapRun(r, {
        sim, api, kind: 'ui',
        // 【UIの tick】main.js:141。止める仕組みは無い。頼まれた数だけ必ず進む。
        ticks: (n) => { for (let i = 0; i < n; i++) api.stepTick(world, rng); return n; },
        // 【UIの1世代】main.js:141+169+176。12tick 刻んでから世代を進め、roster も進める。
        generation: () => {
          for (let t = 0; t < TPG; t++) api.stepTick(world, rng);
          const evs = api.advanceGeneration(world, rng) || [];
          try { if (api.stepRoster) api.stepRoster(roster, rng); } catch { /* ロスターは無くても続く */ }
          return evs;
        },
        // UI に stage という概念は無い。世界の値から見えるところまでを写す。
        stage: () => (world.people.size < 2 ? 'ENDED'
          : world.phase !== PHASE.VILLAGE ? 'TRIBE'
            : world.pendingFirstWar ? 'VILLAGE_FULL(相当。時計は止まっていない)'
              : 'VILLAGE_GROW'),
        // R-941 の prev を持っている層が無い（world.stats は世代境界で焼いた履歴で、
        // 「前の値」として画面に渡される経路が存在しない）。
        prev: () => undefined,
        // 【いまの「戦いに行けるか」】adapter.js:refreshWarReady。真偽値だけで、
        // 理由も残り時間も作っていない（07-A-3 が指している当のもの）。
        warReason: () => ({ ok: !!world.warReady, reason: null, remainMs: null }),
        targets: () => {
          // UIの相手選択（panels/opponents.js:17）。初戦もここから選ばせている。
          const list = api.listOpponents ? (api.listOpponents(roster) || []) : [];
          // 「迷ったら、いちばん上（＝強さの数字がいちばん小さい相手）」と画面が薦める順。
          return [...list].sort((a, b) => (a.power ?? 0) - (b.power ?? 0));
        },
        // 開戦前に顔ぶれを見せる画面が無い（R-944 / 07-A-2）。
        // 数字だけは出せるので synthetic の印を付けて返す。
        plannedForce: () => {
          if (typeof api.selectDeployment !== 'function') return null;
          const n = (api.selectDeployment(world, rng) || []).length;
          return { n, synthetic: true };
        },
        war: {
          begin: (t) => api.startWar(world, rng, t),
          step: (w) => api.stepBattle(w, rng),
          surrender: (w) => api.surrender(w),
          settle: (w) => api.settleWar(world, w),
          captiveOptions: (w) => api.captiveOptions(w),
          takeCaptives: (w, axis) => api.takeCaptives(world, w, axis, rng) || [],
          borderDecide: (id, d) => api.borderDecision(world, id, d),
          finish: () => undefined,
          // 【いまのUIの順番】border.js が captiveOptions → takeCaptives →
          // borderDecision → settleWar の順で呼ぶ。settleWar が最後に来る。
          order: 'settle-last',
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// §D  run の共通面（G群はここだけを触る）
// ---------------------------------------------------------------------------

function wrapRun(inner, io) {
  const world = () => inner.world;

  const run = {
    kind: io.kind,
    get world() { return inner.world; },
    get roster() { return inner.roster; },
    get rng() { return inner.rng; },
    get inner() { return inner; },
    api: io.api ?? null,
    sim: io.sim,

    stage: () => io.stage(),
    prev: () => io.prev(),
    pop: () => inner.world.people.size,
    gen: () => inner.world.gen,
    phase: () => inner.world.phase,

    /** n tick 進めようとして、実際に進んだ数を返す（止まっていれば 0）。 */
    pushTicks(n) {
      const before = inner.world.tick ?? 0;
      const said = io.ticks(n) ?? 0;
      const moved = (inner.world.tick ?? 0) - before;
      // world.tick が世代で巻き戻る実装もあるので、進行層の申告と実測の大きいほうを取る
      return Math.max(0, Number.isFinite(moved) && moved > 0 ? moved : said);
    },

    /** 1世代進める。刻み方は経路が持つ。 */
    advance() { return io.generation() || []; },

    /**
     * 検査のための下ごしらえ：世界を空にする（G-20 の「人口0で開戦を頼む」）。
     * ここは測定ではなく状態づくりなので sim の kill を直接使う。
     */
    emptyWorld() {
      const w = inner.world;
      for (const p of [...w.people.values()]) io.sim.kill(w, p, '検査');
      return w.people.size;
    },

    /**
     * 村がいっぱいになるまで進める。
     * 「いっぱい」の合図は `pendingFirstWar`（sim が 10体で立てる旗）か、
     * 進行層が VILLAGE_FULL を名乗ったとき。
     */
    growUntilFull(maxGen = 30) {
      let gens = 0;
      while (gens < maxGen) {
        if (isFull(inner.world, io)) break;
        if (inner.world.people.size < 2) break;      // 行き止まり
        run.advance();
        gens++;
      }
      return {
        reached: isFull(inner.world, io),
        gens,
        pop: inner.world.people.size,
        gen: inner.world.gen,
      };
    },

    warReason: () => io.warReason(),
    targets: () => io.targets(),
    plannedForce: (t) => io.plannedForce(t),

    /**
     * 戦争を1回、経路が持っている順番で通す。返すのは**記録だけ**。
     * G群はこの記録を読む。順番の知識は検査側に持たせない。
     */
    warOnce(o = {}) { return warOnce(run, inner, io, o); },
  };
  return run;
}

function isFull(w, io) {
  const st = io.stage ? String(io.stage() ?? '') : '';
  if (st.startsWith('VILLAGE_FULL')) return true;
  return !!w.pendingFirstWar;
}

// ---------------------------------------------------------------------------
// §E  戦争1回の記録
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   ok:boolean, refused:string|null, error:string|null,
 *   firstWar:boolean, homeN:number, awayN:number,
 *   plannedN:number|null, plannedSynthetic:boolean,
 *   foeSkillMax:number, foeAges:number[],
 *   rounds:number, outcome:string|null,
 *   deathsShownAtClose:number, worldDeaths:number,
 *   captives:number, captivesFromCorpse:number, captivesMissing:number,
 *   surrenderOptions:number|null, foodWrites:Array<[number,number]>,
 *   oppPopBefore:number|null, oppPopAfter:number|null,
 *   borderEmpty:boolean, popBefore:number, popAfter:number,
 * }}
 */
function warOnce(run, inner, io, o) {
  const { target = null, axis = '総合', decision = 'accept', surrenderAtRound = null } = o;
  const w = inner.world;
  const rec = {
    ok: false, refused: null, error: null,
    firstWar: false, homeN: 0, awayN: 0,
    plannedN: null, plannedSynthetic: false,
    foeSkillMax: 0, foeAges: [],
    rounds: 0, outcome: null,
    deathsShownAtClose: 0, worldDeaths: 0,
    captives: 0, captivesFromCorpse: 0, captivesMissing: 0,
    surrenderOptions: null, foodWrites: [],
    oppPopBefore: null, oppPopAfter: null,
    borderEmpty: false,
    popBefore: w.people.size, popAfter: w.people.size,
  };

  // 開戦前に「出す顔ぶれ」の人数（R-944 / G-23）
  try {
    const pf = io.plannedForce(target);
    if (pf) { rec.plannedN = pf.n; rec.plannedSynthetic = !!pf.synthetic; }
  } catch { /* 顔ぶれが出せない経路もある */ }

  const oppWorld = target && (target.world || target._world) || null;
  rec.oppPopBefore = oppWorld && oppWorld.people ? oppWorld.people.size : null;

  const food = spyOnFood(w, rec.foodWrites);
  try {
    let battle = null;
    try {
      battle = io.war.begin(target);
    } catch (e) {
      rec.error = e && e.message ? e.message : String(e);
      return rec;
    }
    if (!battle) { rec.refused = '開戦しなかった'; return rec; }

    const sb = battle._sim || battle;      // ui 経路は view、flow 経路は素の battle
    if (!sb.sides) { rec.error = 'battle.sides が無い'; return rec; }
    rec.ok = true;
    rec.firstWar = !!sb.firstWar;
    rec.homeN = sb.sides.home.units.length;
    rec.awayN = sb.sides.away.units.length;
    rec.foeAges = sb.sides.away.units.map(u => (u.ind ? u.ind.age : 0));
    rec.foeSkillMax = maxSkill(sb.sides.away.units);
    const homeIds = sb.sides.home.units.map(u => u.id);

    // S1：決着まで
    let guard = 0;
    while (!sb.over && guard++ < 400) {
      io.war.step(battle);
      if (surrenderAtRound != null && !sb.over && (sb.round ?? 0) >= surrenderAtRound) {
        const t = io.war.surrender(battle) || {};
        rec.surrenderOptions = Array.isArray(t.options) ? t.options.length : 0;
        rec.surrenderTerms = t;
        // 【UIの二重引き】panels/battle.js:182。降伏の代価を画面が自分で引く。
        if (io.kind === 'ui' && t.accepted !== false) {
          w.food = Math.max(0, w.food - (t.food ?? 0));
        }
        break;
      }
    }
    rec.rounds = sb.round ?? 0;
    // ui 経路のビューは 'win'/'lose'/'surrender' の文字列、flow 経路は sim の生の
    // outcome オブジェクト。同じ語彙に揃える（名前だけの違いはこの層で吸収してよい）。
    rec.outcome = normalizeOutcome(battle, sb);

    // 【戦闘画面が閉じる時点】は経路が持つ知識。
    //   R-952 は「戦闘画面は戦死が確定する（S3 settleWar）まで閉じない」と決めている。
    //   だから settle-first の経路では **settle を通したあと** が「閉じる時点」で、
    //   settle-last（いまのUI）は締めより前に閉じている。
    //   ここを両経路で同じ位置にすると、順番の違いそのものが測れなくなる。
    const shown = () => (battle.deaths ? battle.deaths.a.length
      : sb.sides.home.units.filter(u => u.dead).length);

    // S3以降。順番は経路が持つ。
    let got = [];
    const entered = [];
    if (io.war.order === 'settle-first') {
      io.war.settle(battle, { priceIndex: 0 });
      rec.deathsShownAtClose = shown();   // S5：確定した損耗を出してから閉じる
      got = takeAndDecide();
    } else {
      rec.deathsShownAtClose = shown();   // ← いまのUI：締めより前に閉じている
      got = takeAndDecide();
      io.war.settle(battle);              // ← いまのUI：締めが最後に来る
    }
    if (io.war.finish) io.war.finish(battle);

    function takeAndDecide() {
      const co = io.war.captiveOptions(battle) || {};
      const axes = co.axes || [];
      const pick = axes.length ? (axes.find(a => (a.key ?? a) === axis) || axes[0]) : null;
      const list = io.war.takeCaptives(battle, pick ? (pick.key ?? pick) : axis) || [];
      rec.captives = list.length;
      const queue = w.border instanceof Map ? [...w.border.values()] : [];
      for (const c of queue) {
        const ev = io.war.borderDecide(c.id, decision);
        // 帰化した個体は **新しい id で spawn される**（捕虜の id のままではない）。
        // 入国後の id は「帰化」の事件の target。ここを見ないと、ゴースト由来の
        // 文字列 id を world.people に問い合わせて必ず「いない」になる（＝空振り）。
        entered.push(ev && ev.target != null ? ev.target : c.id);
      }
      return list;
    }

    // 【必ず全部が終わってから数える】G-08 が聞いているのは
    // 「引いた**そのあと**で死んだか」。引いた瞬間に見ると、決着の追い討ち（settleWar
    // の中の applyRout）がまだ走っていないので、いつでも 0件になって空振りする。
    const away = sb.sides.away.units;
    rec.captivesFromCorpse = got.filter(c => {
      const u = away.find(x => x.id === (c.sourceId ?? c.id));
      return !!(u && u.dead);
    }).length;
    if (decision === 'accept') {
      rec.captivesMissing = entered.filter(id => !w.people.has(id)).length;
    }

    rec.worldDeaths = homeIds.filter(id => !w.people.has(id)).length;
    rec.borderEmpty = (w.border instanceof Map ? w.border.size : 0) === 0;
    rec.oppPopAfter = oppWorld && oppWorld.people ? oppWorld.people.size : null;
    rec.popAfter = w.people.size;
    return rec;
  } finally {
    food.restore();
  }
}

/** world.food への書き込みを数える（G-12 の二重引き検出）。 */
function spyOnFood(w, log) {
  const own = Object.getOwnPropertyDescriptor(w, 'food');
  let v = w.food;
  try {
    Object.defineProperty(w, 'food', {
      configurable: true, enumerable: true,
      get() { return v; },
      set(next) { log.push([v, next]); v = next; },
    });
  } catch {
    return { restore() {} };
  }
  return {
    restore() {
      const last = v;
      if (own) Object.defineProperty(w, 'food', own);
      else delete w.food;
      w.food = last;
    },
  };
}

/** 決着の呼び名を経路のあいだで揃える。ui のビューは文字列、flow は sim の生の値。 */
function normalizeOutcome(battle, sb) {
  const o = battle.outcome ?? (sb && sb.outcome) ?? null;
  if (o == null) return null;
  if (typeof o === 'string') return o;
  if (o.kind === 'サレンダー') return 'surrender';
  return o.winner === 'home' ? 'win' : 'lose';
}

function maxSkill(units) {
  let m = 0;
  for (const u of units) {
    const s = u.ind && u.ind.skills ? u.ind.skills : null;
    if (!s) continue;
    for (const k in s) if (s[k] > m) m = s[k];
  }
  return m;
}

// ---------------------------------------------------------------------------
// §F  静的検査（G-18）：戦争の呼び口が何か所あるか
// ---------------------------------------------------------------------------

export const WAR_ENTRIES = ['startWar', 'settleWar', 'takeCaptives', 'borderDecision'];

// 呼んでよい場所。
//   flow/war.js  … R-951 が唯一許した呼び口
//   ui/adapter.js… sim の形をUIの形に写す層。flow が呼ぶ相手なので通す
//   sim/ ui/mock.js … 定義している側（呼び口ではない）
export const WAR_ENTRY_ALLOW = [
  'src/flow/war.js',
  'src/ui/adapter.js',
  'src/ui/mock.js',
];

/** src/ 以下の .js から、戦争4関数の呼び出し／import を拾う。 */
export async function scanWarCallSites() {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.js')) continue;         // .bak は配信にも検査にも入れない
      const rel = 'src/' + p.slice(SRC.length + 1).split(/[\\/]/).join('/');
      if (WAR_ENTRY_ALLOW.some(a => rel.endsWith(a))) continue;
      if (rel.includes('src/sim/')) continue;      // 定義している側
      const src = stripComments(readFileSync(p, 'utf8'));
      src.split('\n').forEach((line, i) => {
        for (const fn of WAR_ENTRIES) {
          // 呼び出し（api.startWar( / sim.startWar( / startWar( ）だけを拾う。
          // 定義（export function startWar(）と別名（startWarFlow(）は拾わない。
          const call = new RegExp(`(^|[^A-Za-z0-9_$])${fn}\\s*\\(`);
          if (call.test(line) && !/\bfunction\s+$/.test(line.slice(0, line.indexOf(fn)))) {
            out.push({ file: rel, line: i + 1, fn, text: line.trim() });
          } else if (new RegExp(`import[^\\n]*\\b${fn}\\b`).test(line)) {
            out.push({ file: rel, line: i + 1, fn, text: line.trim() });
          }
        }
      });
    }
  };
  walk(SRC);
  return out;
}

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => {
      const i = l.indexOf('//');
      if (i < 0) return l;
      // 文字列の中の // は落とさない（雑でよい。URLくらいしか無い）
      const before = l.slice(0, i);
      const q = (before.match(/'/g) || []).length + (before.match(/"/g) || []).length
        + (before.match(/`/g) || []).length;
      return q % 2 === 1 ? l : before;
    }).join('\n');
}

export { PHASE };
