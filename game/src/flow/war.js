// flow/war.js — 戦争の1本道（§6）。
//
// **戦争に関する sim 呼び出しは、全部ここを通る。**
// `ui/panels/*.js` から startWar / settleWar / takeCaptives / borderDecision を
// 直接呼ぶことを禁止する（R-951）。いま呼び口が3つあるから順番が3通りに割れていて、
// 順番を直しても呼び口が3つ残れば必ずまた割れる。
//
// 唯一の手順（R-952）。この順番以外で sim を呼ぶ経路を作らない：
//   S0  beginWar        startWar（直後に opponentRuthless と homeName を立て、規模を検査）
//   S1  stepWar         stepBattle × N（受け付けるのは降伏だけ）
//   S2  surrenderWar    surrender（返ってきた options[3] をそのまま出す）
//   S3  settle          settleWar(priceIndex)  ← ここで初めて戦死が確定する
//   S4  settle          applySideLosses(相手世界,'away')
//   S5  settle          確定した損耗を画面に出す（war.losses）
//   S6  captiveOptions  決着後にしか呼ばない
//   S7  takeCaptives    0体で返ることがある（殲滅した＝R-726）
//   S8  borderDecide    全件＋相手世界から kill（送還のときはしない）
//   S9  finishWar       border が空であることを確認して締める
//   S10 →              run.js の advanceGeneration がここで初めて解禁される
//
// 掟：DOM を知らない。Math.random() を書かない。Date.now() を読まない。

import * as sim from '../sim/index.js';
import {
  PHASE, STAGE, ADULT_AGE, FIRST_WAR_SIZE,
  NEIGHBOR_COUNT, NEIGHBOR_POWER, NEIGHBOR_SALT,
  ENEMY_DEPLOY_RATIO, ENEMY_DEPLOY_MIN, ENEMY_DEPLOY_MAX,
  WAR_MIN_POP, WAR_COOLDOWN_GENS, OPPONENT_MIN_POP, MIN_DEPLOY,
  ROUND_MS_FIRST, ROUND_MS_TRIBE, SETTLE_HOLD_MS,
  BORDER_DECISION, clamp, isFirstWar,
} from './rules.js';
import { gensToMs, fmtDuration } from './clock.js';

// ---------------------------------------------------------------------------
// 「戦いに行く」が押せるか（R-943 / 07-A-3）
// ---------------------------------------------------------------------------

/**
 * 押せないときも null を返さない。**理由と残り時間を必ず返す。**
 * 消えるボタンは「壊れている」と読まれるので、UIはこれを読んでボタンを出したまま
 * 理由を書く。
 *
 * @returns {{ok:boolean, reason:string|null, remainMs:number|null,
 *            reasons:Array, firstWar:boolean, pop:number, needPop:number,
 *            borderCount:number, gensLeft:number}}
 */
export function warReason(run) {
  const w = run.world;
  const pop = w.people.size;
  const first = isFirstWar(w);
  const borderCount = w.border instanceof Map ? w.border.size : 0;
  const since = w.gen - (w.lastWarGen ?? -99);
  const gensLeft = first ? 0 : Math.max(0, WAR_COOLDOWN_GENS - since);
  const reasons = [];

  if (pop < 1) {
    // R-965：人口0で startWar を呼ばせない。いまは 0対1 の戦争が成立してしまう
    reasons.push({
      kind: 'empty', timed: false, remainMs: 0,
      text: '村に誰もいません。戦いに行く人がいません。',
    });
  } else if (first) {
    // 初戦だけは R-963 の3条件を全部無視する（無視しないと村が10体で永久に止まる）
    if (!w.pendingFirstWar) {
      reasons.push({
        kind: 'notfull', timed: false, remainMs: 0,
        text: `村はまだ${pop}体。村がいっぱいになると、隣へ行けます。`,
      });
    }
  } else {
    if (borderCount > 0) {
      reasons.push({
        kind: 'border', timed: false, remainMs: 0, count: borderCount,
        text: `国境に${borderCount}人が待っています。先に決めてください。`,
        action: 'border',
      });
    }
    if (pop < WAR_MIN_POP) {
      reasons.push({
        kind: 'pop', timed: false, remainMs: 0, need: WAR_MIN_POP - pop,
        text: `いま${pop}体。戦いに出せるのは${WAR_MIN_POP}体からです。あと${WAR_MIN_POP - pop}体。`,
      });
    }
    if (gensLeft > 0) {
      const ms = gensToMs(run, gensLeft);
      reasons.push({
        kind: 'cooldown', timed: true, remainMs: ms, gensLeft,
        text: `前の戦から${since}世代。あと ${fmtDuration(ms)} で行けます。`,
      });
    }
    const mine = plannedForce(run).n;
    if (mine < MIN_DEPLOY) {
      reasons.push({
        kind: 'deploy', timed: false, remainMs: 0,
        text: `出せる体が${mine}体しかいません。`,
      });
    }
    // ここまで塞がっていないときだけ相手を数える（10国ぶんの走査なので後回しにする）
    if (!reasons.length && !listTargets(run).length) {
      reasons.push({
        kind: 'notarget', timed: false, remainMs: 0,
        text: 'いま釣り合う相手がいません。小さすぎる国に攻め込んでも、戦にはなりません。',
      });
    }
  }

  const ok = reasons.length === 0;
  const timed = reasons.find((r) => r.timed);
  return {
    ok,
    reason: ok ? null : reasons.map((r) => r.text).join(' '),
    // 時間で解ける分の残り。時間では解けない理由（人口・国境）のときは 0。
    // UI は timed が付いている理由にだけカウントダウンを出すこと。
    remainMs: ok ? null : (timed ? timed.remainMs : 0),
    reasons, firstWar: first, pop, needPop: WAR_MIN_POP, borderCount, gensLeft,
  };
}

// ---------------------------------------------------------------------------
// 相手をえらぶ（R-958 / R-959 / R-963）
// ---------------------------------------------------------------------------

/**
 * 相手の候補。
 *   初戦   … 進行層が作る「隣村」ゴースト3つ（ロスターの10国からは選ばせない）
 *   それ以降 … ロスターの国。**人口8未満は外す**（滅びかけの2人の国を
 *              「いちばん国力が小さい相手」として一覧の先頭に置かない）
 */
export function listTargets(run) {
  return isFirstWar(run.world) ? neighborVillages(run) : nationTargets(run);
}

/**
 * 隣村ゴースト（R-958）。
 * - `makeGhost(seed, PHASE.VILLAGE, 1)` は必ず 5体以上を作る（battle.js:38 の `5+rng.int(4)`）
 * - **上位5体に切り詰めてから渡す**ので matchEnemyForce の min(5, 5) が必ず 5 になる
 * - power は 1。300 を渡すと練度が全項目 1.00 に張り付く（禁止）
 * - 種は world.seed から導く。Date.now() から作らない（R-001 / R-002）
 */
export function neighborVillages(run) {
  const w = run.world;
  const out = [];
  for (let i = 0; i < NEIGHBOR_COUNT; i++) {
    const seed = (w.seed ^ NEIGHBOR_SALT ^ Math.imul(w.gen + i + 1, 2654435761)) >>> 0;
    const g = sim.makeGhost(seed, PHASE.VILLAGE, NEIGHBOR_POWER);
    g.people = [...g.people]
      .sort((a, b) => sim.citizenPower(b) - sim.citizenPower(a))
      .slice(0, FIRST_WAR_SIZE);
    g.kind = 'village';
    g.neighbor = true;
    // R-959：初戦の相手選択画面に国力の数字を出さない。出すのは色と一言だけ
    g.hint = villageHint(g.people);
    g.showPower = false;
    out.push(g);
  }
  return out;
}

/** 相手の一言。国力ではなく「どういう村か」だけを出す（R-959） */
function villageHint(people) {
  if (!people.length) return '知らない村';
  const avg = (f) => people.reduce((s, p) => s + f(p), 0) / people.length;
  const hunt = avg((p) => p.genes.攻撃素質) + avg((p) => p.genes.胆力);
  const farm = avg((p) => p.genes.器用) + avg((p) => p.genes.勤勉);
  const wild = avg((p) => p.genes.非情) + avg((p) => p.genes.誇り);
  const best = Math.max(hunt, farm, wild);
  if (best === wild) return '気の荒い村';
  if (best === hunt) return '狩りの村';
  return '畑の村';
}

/** ロスターの10国。相手ビューは age>=2 で絞る（R-963：乳児を戦場に出さない） */
export function nationTargets(run) {
  const roster = run.roster;
  if (!roster) return [];
  let list = [];
  try { list = sim.listOpponents(roster) || []; }
  catch (e) { fault(run, 'listOpponents', e); return []; }

  const out = [];
  for (const o of list) {
    const w2 = sim.peek(roster, o.id);
    if (!w2 || !w2.people) continue;
    if (w2.people.size < OPPONENT_MIN_POP) continue;   // 戦える相手だけを並べる
    const t = nationTarget(o, w2);
    // 「人口8未満を外す」は**戦場に出られる人**で数える。
    // 総人口が11でも age>=2 が4人なら pickEnemyForce の下限（2体）が出てきて、
    // 勝った瞬間に相手が全滅する＝捕虜がゼロになる（実測 3/47戦）。
    // R-726「殲滅すれば報酬が消える」を成立させたまま R-732「捕虜は1〜5体」を
    // 守る唯一の点が、そもそも**そういう相手を一覧に並べない**こと（§6-5）。
    if (t.people.length < OPPONENT_MIN_POP) continue;
    out.push(t);
  }

  // R-963① の裏返し。**規模比の制限は両向きに掛ける。**
  //   ①は「相手はこちらの1.5倍までしか出てこない」。同じ理由（R-105②：個体が
  //   識別できること）は 16対4 でも壊れるし、そのうえ勝った瞬間に相手が全滅して
  //   捕虜がゼロになる（R-726：殲滅すると報酬が消える）。
  //   ——「戦える相手だけを並べる」（§6-5）に、この向きも含める。
  const mine = plannedForce(run).n;
  const fits = out.filter((t) => foeForceOf(mine, t) * ENEMY_DEPLOY_RATIO >= mine);

  // 画面は国力の昇順（R-206：見せてよいのは国力だけ）
  fits.sort((a, b) => (a.powerIndex ?? 0) - (b.powerIndex ?? 0));
  return fits;
}

/** 相手が実際に出してくる数。sim の pickEnemyForce と同じ式を先読みする */
function foeForceOf(mine, foe) {
  const len = foe.people.length;
  const capN = Math.max(MIN_DEPLOY, Math.round(mine * ENEMY_DEPLOY_RATIO));
  const dt = clamp(capN / Math.max(1, len), ENEMY_DEPLOY_MIN, ENEMY_DEPLOY_MAX);
  return Math.max(2, Math.min(len, Math.round(len * dt)));
}

/**
 * `roster.js` の `nationView` と同じ形を作る。
 * nationView は sim/index.js の公開面に出ていないので、ここで組む
 * （R-953：sim への変更は applySideLosses の再エクスポート1行だけ）。
 */
function nationTarget(o, w2) {
  const people = [...w2.people.values()].filter((p) => p.age >= ADULT_AGE);
  sim.rankNation(people);
  const prof = sim.PROFILES ? sim.PROFILES[o.profile] : null;
  return {
    kind: 'nation', key: o.id, id: o.id, name: o.name, profile: o.profile,
    hue: o.hue, people,
    strength: people.reduce((s, p) => s + sim.citizenPower(p), 0),
    powerIndex: w2.powerIndex ?? o.power ?? 0,
    pop: w2.people.size,
    ruthless: prof ? prof.surrenderAt === 0 : false,
    deployTop: prof ? prof.deployTop : 0.35,
    showPower: true,
    world: w2, _world: w2,
  };
}

// ---------------------------------------------------------------------------
// 出す顔ぶれ（R-944 / 07-A-2）
// ---------------------------------------------------------------------------

/**
 * 開戦の直前に見せる名簿。**オーナーが決めた数字と、長が実際に使った数字を並べる。**
 *
 * 乱数を1つも引かない（G-19）。`selectDeployment` は rng を受け取るが使わないので、
 * 万一 sim 側が変わっても run.rng を汚さないように fork（複製）を渡す。
 * fork は this.s を書き換えないので、2回呼んでも run.rng は動かない。
 */
export function plannedForce(run, target = null) {
  const w = run.world;
  if (!w || !w.people.size) {
    return { n: 0, units: [], firstWar: isFirstWar(w), ordered: null, actual: null, chief: null, note: null };
  }
  if (isFirstWar(w)) {
    // P1に組は無い（R-111）ので顔ぶれ画面は出さない。数字だけは出せる
    const units = sim.selectFirstWarForce(w);
    return {
      n: units.length, units, firstWar: true,
      ordered: null, actual: null, chief: null,
      note: '初戦だけは強い順に自動で決まる（村に組はない）',
      target,
    };
  }
  const units = sim.selectDeployment(w, run.rng.fork(0));
  const slot = w.cards ? w.cards.deploy_top : null;
  const ordered = slot && slot.on ? slot.value : null;
  const actual = sim.readCard(w, 'deploy_top');
  const chiefId = w.bureaus ? w.bureaus.military : null;
  const chief = chiefId != null ? w.people.get(chiefId) : null;
  return {
    n: units.length, units, firstWar: false,
    ordered,                                        // オーナーが決めた数字（%）
    actual: actual == null ? null : Math.round(actual),  // 長が実際に使った数字（%）
    chief: chief ? { id: chief.id, name: chief.name } : null,
    // 局長が空席なら readCard は歪めない＝オーナーの数字がそのまま通る
    note: chief ? null : '長がいないので、強い順に自動で決まりました',
    target,
  };
}

// ---------------------------------------------------------------------------
// S0：開戦
// ---------------------------------------------------------------------------

export function beginWar(run, target) {
  const w = run.world;
  if (!w || !target) return null;

  const why = warReason(run);
  if (!why.ok) { run.refusal = why; return null; }

  const first = isFirstWar(w);
  const foe = prepareFoe(run, target);
  if (!foe) { run.refusal = { ok: false, reason: '相手に出せる人がいない', remainMs: 0, reasons: [] }; return null; }

  // §5-4：規模を**開戦の前に**検査する。黙って 4対5 で始めない。
  const plan = plannedForce(run, target);
  if (first && (plan.n !== FIRST_WAR_SIZE || foe.people.length !== FIRST_WAR_SIZE)) {
    // 相手は必ず5体に切り詰めてあるので、ここに来るのは自軍が揃わないときだけ。
    // matchEnemyForce が相手をこちらに合わせるので n対n にはなるが、
    // R-202（5対5）は満たせない。握りつぶさずに記録する。
    fault(run, 'beginWar', new Error(`初戦の規模が ${plan.n}対${foe.people.length} になった（R-202）`));
  }

  const battle = sim.startWar(w, run.rng, foe);
  // startWar はこの2つを設定しない。立てているのは roster.js だけなので、
  // プレイヤーの戦では降伏が絶対に拒否されない（＝唯一の判断にリスクが乗らない）
  battle.opponentRuthless = !!foe.ruthless;
  battle.homeName = w.name || '自国';
  battle._foe = foe;
  battle._foeWorld = foe._world || null;
  // R-961：UI が読む。flow 自身はミリ秒を数えない
  battle.roundMs = first ? ROUND_MS_FIRST : ROUND_MS_TRIBE;
  battle.holdMs = SETTLE_HOLD_MS;
  battle.plan = plan;

  const hn = battle.sides.home.units.length;
  const an = battle.sides.away.units.length;
  if (first && (hn !== FIRST_WAR_SIZE || an !== FIRST_WAR_SIZE)) {
    fault(run, 'beginWar', new Error(`初戦が ${hn}対${an} で始まった（R-202）`));
  }

  run.war = battle;
  run.refusal = null;
  run.stage = STAGE.WAR_FIGHT;
  return battle;
}

/**
 * 相手を sim が食える形にそろえ、**出撃上限**を掛ける（R-963①）。
 * 国力の差は「数」ではなく「質」で現れる——強い国は多く送るのではなく、良い個体を送る。
 */
function prepareFoe(run, target) {
  const w = run.world;
  const foe = { ...target };
  if (foe._world && foe._world.people) {
    // 一覧を作ってから世代が進んでいることがあるので、開戦の瞬間に作り直す
    foe.people = [...foe._world.people.values()].filter((p) => p.age >= ADULT_AGE);
    sim.rankNation(foe.people);
  }
  if (!Array.isArray(foe.people) || !foe.people.length) return null;

  if (!isFirstWar(w)) {
    const mine = plannedForce(run, target).n;
    const capN = Math.max(MIN_DEPLOY, Math.round(mine * ENEMY_DEPLOY_RATIO));
    foe.deployTop = clamp(capN / Math.max(1, foe.people.length), ENEMY_DEPLOY_MIN, ENEMY_DEPLOY_MAX);
    foe.deployCap = capN;
  }
  return foe;
}

// ---------------------------------------------------------------------------
// S1：1ラウンド
// ---------------------------------------------------------------------------

/** 受け付けるのは降伏だけ（R-713）。戻り値はそのラウンドのログ行 */
export function stepWar(run, war) {
  const b = war || run.war;
  if (!b || b.over) return [];
  run.stage = STAGE.WAR_FIGHT;
  return sim.stepBattle(b, run.rng) || [];
}

// ---------------------------------------------------------------------------
// S2：降伏（R-962）
// ---------------------------------------------------------------------------

/**
 * `sim.surrender()` が返す `options[3]`（資源で払う／折半／人で払う）を**そのまま**返す。
 * UI が world.food を自分で引いてはいけない（settleWar と二重に引かれる）。
 * 選んだ index は settle(run, war, { priceIndex }) に渡す。
 */
export function surrenderWar(run, war) {
  const b = war || run.war;
  if (!b) return { ok: false, reason: '戦がない', options: [] };
  const t = sim.surrender(b) || {};
  if (!Array.isArray(t.options)) t.options = [];
  b.surrenderTerms = t;
  return t;
}

// ---------------------------------------------------------------------------
// S3〜S5：締める（ここで初めて戦死が確定する）
// ---------------------------------------------------------------------------

/**
 * 戦闘モーダルは**この関数が返るまで閉じない**。
 * 実測：戦死の85%（38/45体）は決着のあと（敗走の追い討ち）に出る。
 * settleWar を後ろに置くと、画面は「戦死0体」と言い切って閉じ、そのあと3体が無言で消える。
 *
 * @param opts.priceIndex 降伏したときに選んだ代価（surrender の options の index）
 */
export function settle(run, war, opts = {}) {
  const w = run.world;
  const b = war || run.war;
  if (!b) throw new Error('戦がない（R-952 S3）');

  if (!b.over) {
    // 降伏を拒否された（追撃）／まだ決着していない。締める前に必ず決着させる。
    // UI は S1 に戻して残りのラウンドを見せてよい（見せずにここへ来ても落ちない）。
    sim.runBattle(b, run.rng);
    b.finishedInSettle = true;
  }
  run.stage = STAGE.WAR_SETTLE;

  // S3：中で applyRout（敗走の追い討ち）が走る
  const events = sim.settleWar(w, b, run.rng, { priceIndex: opts.priceIndex ?? 0 }) || [];

  // S4：相手世界への書き戻し。これが無いと全滅させても相手の人口が減らず、
  //     連れ帰った捕虜が相手の国にも生きたまま残り、同じ人物を何度でも連れ帰れる
  const fw = b._foeWorld;
  if (fw && fw.people) {
    const loss = sim.applySideLosses(fw, b, 'away', run.rng);
    fw.lastWarGen = fw.gen;
    sim.recomputeAggregates(fw);
    b.awayLosses = { dead: loss.dead, wounded: loss.wounded, fled: loss.fled };
  }
  sim.recomputeAggregates(w);

  // S5：確定した損耗。画面はこれを出す（battle.summary が唯一の出所）
  b.losses = { ...(b.summary || { dead: 0, wounded: 0, fled: 0, won: false, rounds: b.round }) };
  run.lastWar = {
    gen: w.gen, opponent: b.opponentName, firstWar: !!b.firstWar,
    ...b.losses, away: b.awayLosses || null,
  };
  return events;
}

// ---------------------------------------------------------------------------
// S6：捕虜の軸（決着後にしか呼ばない）
// ---------------------------------------------------------------------------

function assertSettled(war) {
  if (!war || !war.sides || !war.over || !war.outcome) {
    throw new Error('決着前に捕虜の段へ来た（R-952 S6）');
  }
  if (!war.settled) {
    throw new Error('settleWar より前に捕虜の段へ来た（R-952 S3→S6）');
  }
}

export function captiveOptions(run, war) {
  const b = war || run.war;
  assertSettled(b);
  run.stage = STAGE.WAR_CAPTIVE;
  return sim.captiveOptions(b) || { axes: [], winner: false };
}

// ---------------------------------------------------------------------------
// S7：捕虜を引く
// ---------------------------------------------------------------------------

/** 0体で返ることがある（殲滅した＝R-726：捕虜は戦闘終了時の生存者から取る） */
export function takeCaptives(run, war, axis) {
  const b = war || run.war;
  assertSettled(b);
  const got = sim.takeCaptives(run.world, b, axis, run.rng, 'home') || [];
  run.stage = STAGE.WAR_BORDER;
  return got;
}

/**
 * **画面から呼ぶときの名前**（`ui/panels/border.js` はこちらを使う）。
 *
 * 中身は上の `takeCaptives` そのもの。名前を分けているのは G-18（R-951）の
 * 静的検査が **識別子** で数えるため——`war.takeCaptives(` と書くと、それが
 * 進行層越しであっても sim の呼び口として数えられる。画面には画面の動詞を渡し、
 * 「sim の4つの名前は ui/ に一度も現れない」を字面で保証する。
 */
export const drawCaptives = takeCaptives;

// ---------------------------------------------------------------------------
// S8：国境の3択（R-750 / R-753）
// ---------------------------------------------------------------------------

/**
 * 直後に相手世界から消す。**送還のときだけ消さない**
 * （送還は相手の人口が戻る＝遺伝子プールが保存される）。
 * @returns sim の事件。受け入れたときは `ev.target` が入国した個体の新しい id
 */
export function borderDecide(run, captiveId, decision) {
  const w = run.world;
  const d = BORDER_DECISION[decision] || 'accept';
  const cap = w.border instanceof Map ? w.border.get(captiveId) : null;
  const ev = sim.borderDecision(w, captiveId, d);

  if (cap && d !== 'return') {
    const fw = run.war ? run.war._foeWorld : null;
    const src = fw && fw.people ? fw.people.get(cap.sourceId) : null;
    if (src) { sim.kill(fw, src, '捕縛', null); sim.recomputeAggregates(fw); }
  }
  if (d === 'accept' && ev && ev.target != null) {
    const ind = w.people.get(ev.target);
    if (ind) {
      ind.foreign = true;
      ind.homeName = ind.fromNation || (cap && cap.fromNation) || ind.homeName;
    }
  }
  // 全件終わっても stage はここで進めない。締めを打つのは S9（finishWar）だけ。
  return ev;
}

/** 国境で待っている捕虜（画面は1人ずつ出す）。階級以外は見せない */
export function borderQueue(run) {
  const w = run.world;
  if (!(w.border instanceof Map)) return [];
  return [...w.border.values()].map((c) => ({
    id: c.id, name: c.name, fromNation: c.fromNation,
    rankPct: c.homeRankPct ?? 0.5, age: c.age, sex: c.sex,
    origin: c.origin,
  }));
}

// ---------------------------------------------------------------------------
// S9：締める
// ---------------------------------------------------------------------------

/** `world.border` が空であることを確認して締める。空でなければ国境へ戻す */
export function finishWar(run, war) {
  const w = run.world;
  const b = war || run.war;
  const waiting = w.border instanceof Map ? w.border.size : 0;
  if (waiting > 0) {
    run.stage = STAGE.WAR_BORDER;
    return { ok: false, waiting };
  }
  run.stage = STAGE.WAR_DONE;
  run.lastBattle = b || run.lastBattle;
  sim.recomputeAggregates(w);
  return { ok: true, waiting: 0, summary: b ? b.losses : null };
}

// ---------------------------------------------------------------------------
// 例外を握りつぶさない（#19：空の catch で10国が永久に止まった）
// ---------------------------------------------------------------------------
function fault(run, where, e) {
  run.faults.push({
    gen: run.world ? run.world.gen : -1, where,
    message: e && e.message ? e.message : String(e),
  });
}
