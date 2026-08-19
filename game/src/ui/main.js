// 画面のシェル。ルーティング・ループ・トップバー。
// 依存の向きは ui -> sim -> core の一方向。sim へは必ず api.js 越しに触る。

import { api, SIM_SOURCE, registerRoster } from './api.js';
import { RNG } from '../core/rng.js';
import { PHASE, ROLE, BUREAU_LABEL, GEN_MS } from '../core/model.js';
import { el, clear, num, pct, toast, modal, mount } from './dom.js';
import { seedCards } from './cards.js';
import { Dish } from './dish.js';
import { swatchColor, strainName, lineageHue } from './color.js';

import { openOpening } from './panels/opening.js';
import { renderInspector } from './panels/inspector.js';
import { renderRoles } from './panels/roles.js';
import { renderPolicy } from './panels/policy.js';
import { renderPetitions, petitionCount } from './panels/petitions.js';
import { renderSearch } from './panels/search.js';
import { renderChronicle } from './panels/chronicle.js';
import { openReport } from './panels/report.js';
import { openOpponents } from './panels/opponents.js';
import { openBattle } from './panels/battle.js';

// ------------------------------------------------------------------ 世代の尺
//
// 世代の長さは2つの数の積で決まる。画面が勝手に決めてよいのは**片方もない**。
//
//   TICKS_PER_GEN … 1世代が何tickか。sim の経済（産出・練度の伸び）はこの粒度で
//                   調律されている。画面が独自に120刻みで回していたときは、
//                   1世代あたり10倍の産出と練度が入っていた。api 越しに sim から引く。
//   GEN_MS        … 1世代が実時間で何ミリ秒か。core/model.js の設計値。
//                   P1=2分／世代、P2=60分／世代。
//
// 倍速ボタン（×1/×2/×4/×8）は **この尺に対する倍率**。×1 が設計値そのもの。
// sim の実測では10体到達が3〜4世代なので、×1 で 6〜8分。完成基準7（P1が5〜10分）は
// ここが繋がって初めて測れる。
const TICKS_PER_GEN = api.TICKS_PER_GEN ?? 12;
const genMs = (w) => GEN_MS[w ? w.phase : 1] ?? GEN_MS[1];
const tickMs = (w) => genMs(w) / TICKS_PER_GEN;

const SEED = 20260819;

const state = {
  world: null, roster: null, rng: null, dish: null,
  speed: 1, paused: false, selected: null, tab: 'ind',
  castPick: null, openBureau: null, search: null, chron: null,
  battle: null, rosterDebug: false, autoReport: true,
  firstWarSeen: false, elapsedMs: 0, hadForeign: false, species: null,
};

const ctx = {
  get world() { return state.world; },
  get rng() { return state.rng; },
  api, state,
  refresh, select, afterBorder,
};

const TABS = [
  { key: 'ind', label: '個体', render: renderInspector },
  { key: 'roles', label: '配役', render: renderRoles, badge: () => idleCount() },
  { key: 'policy', label: '方針', render: renderPolicy },
  { key: 'pet', label: '具申', render: renderPetitions, badge: () => petitionCount(ctx) },
  { key: 'search', label: '検索', render: renderSearch },
  { key: 'chron', label: '年代記', render: renderChronicle },
];

// ------------------------------------------------------------------ 起動
//
// 診断は2段に分かれる。
//   build … 回答から世界を作る（まだ時計は回さない）。診断の最終画面が
//           「重心から引かれた実物の2匹」を見せるために、世界がその時点で要る
//   start … 本編へ。**世界の時計の原点はここ**。診断に何分かけても世界には入らない
//           （完成基準7「P1が5〜10分」は診断終了時点から測る）
openOpening({
  build: (answers, opts) => buildWorld(answers, opts),
  start: (mode) => startWorld(mode),
});

function buildWorld(answers, opts = {}) {
  state.rng = new RNG(SEED);
  // sim の受け口は第2引数。`{centroid}` を渡すと「種族の重心」として読まれ、
  // 二匹はそこから spread（sim が実測で決めた既定値）で独立に引かれる。
  // mock は旧形式の配列しか食えないので、そのときだけ配列を渡す。
  const spec = opts.centroid ? { centroid: opts.centroid } : answers;
  state.world = api.createWorld(SEED, SIM_SOURCE === 'sim' ? spec : answers, {
    name: '我らのシャーレ',
    species: opts.species || null,
    responses: opts.responses || null,
  });
  state.species = opts.species || null;
  seedCards(api, state.world);
  try { state.roster = api.createRoster ? api.createRoster(SEED) : null; }
  catch (e) { console.warn('roster 生成に失敗', e); state.roster = null; }
  registerRoster(state.roster);
  return state.world;
}

function startWorld(mode) {
  document.getElementById('app').hidden = false;

  const badge = document.getElementById('sim-badge');
  badge.textContent = SIM_SOURCE === 'sim' ? 'sim' : 'mock sim';
  badge.className = 'badge ' + (SIM_SOURCE === 'sim' ? 'live' : 'mock');

  state.dish = new Dish(document.getElementById('dish'));
  state.dish.onPick = (id) => { if (id != null) select(id); };

  buildTabs();
  buildSpeed();
  document.getElementById('btn-report').onclick = () => showReport();
  document.getElementById('btn-war').onclick = () => startWarFlow();

  if (mode === 2) demoSetup();
  if (state.species) toast(`種族：${state.species.name}（${state.species.code}）`, 'warn');

  // 時計の原点はここ。診断に何分かけていても世界の時間には入れない。
  // （`last` はモジュール評価時に置かれているので、リセットしないと初回フレームで
  //   答えていた時間ぶんの tick が一気に流れ込む）
  last = performance.now(); acc = 0; tickInGen = 0; state.elapsedMs = 0;

  setInterval(loop, FRAME_MS);
  refresh();
}

// ------------------------------------------------------------------ ループ
// requestAnimationFrame ではなくタイマーで回す。rAF は裏タブで止まるので、
// タブを切り替えただけで世界の時計まで止まってしまう（「不在中も世界は進む」に反する）。
// ここで使う実時間は描画とtickの間隔だけで、シミュレーションの状態には入らない。
// 歴史の再現性は RNG と tick 数が担保しているので決定性は壊れない。
const FRAME_MS = 33;
let last = performance.now(), acc = 0, tickInGen = 0, dockAcc = 0;

function loop() {
  const now = performance.now();
  const w = state.world;
  if (!w) { last = now; return; }

  // 1フレームで進めてよい実時間の上限は「1世代ぶん」。
  //
  // ここを 160ms のような固定値に切ってはいけない。ブラウザは裏に回したタブの
  // setInterval を1秒〜1分に絞る（可視性によっては完全に凍る）ので、固定値で切ると
  // **裏に回した分だけ世界の時計が実時間から遅れていく**。設計は逆で、
  // 「不在中も世界は進む」。起きた瞬間に、寝ていたぶんを取り戻すのが正しい。
  //
  // 上限が1世代なのは、長時間の休止から復帰したときに1フレームで何十世代も
  // 走らせないため。取り戻しは次のフレーム以降も続くので、止まりはしない。
  const dt = Math.min(genMs(w), now - last); last = now;
  state.elapsedMs += dt;

  if (!state.paused && state.speed > 0) {
    acc += dt * state.speed;
    const step = tickMs(w);
    let guard = 0;
    while (acc >= step && guard++ < TICKS_PER_GEN) {
      acc -= step;
      api.stepTick(w, state.rng);
      tickInGen++;
      if (tickInGen >= TICKS_PER_GEN) { tickInGen = 0; onGeneration(); }
    }
    // 取り戻しきれなかった分は1世代ぶんまでに切る（無限に溜めない）
    if (acc > step * TICKS_PER_GEN) acc = step * TICKS_PER_GEN;
  }

  state.dish.sync(w);
  state.dish.selected = state.selected;
  state.dish.update(w, dt / 1000);
  state.dish.draw(w);

  dockAcc += dt;
  if (dockAcc > 250) { dockAcc = 0; renderTop(); renderStrains(); }
  paintGenBar(w);
}

function onGeneration() {
  const w = state.world;
  const wasPhase = w.phase;
  const wasBureaus = { ...w.bureaus };
  const evs = api.advanceGeneration(w, state.rng) || [];

  // 局長が死んで空位になった。sim はこれを事件として書かないが、
  // 「叩き起こされる条件」の筆頭なので画面で拾う。空位の局は報告も具申も出さない。
  for (const k in wasBureaus) {
    if (wasBureaus[k] != null && w.bureaus[k] == null) {
      toast(`${BUREAU_LABEL[k]}が空位になった。誰も報告してこない。`, 'bad');
    }
  }
  try { if (api.stepRoster) api.stepRoster(state.roster, state.rng); } catch (e) { /* ロスターは無くても続く */ }

  // 死亡は世代あたり複数出る。1件ずつ流すとトーストが埋まって他が読めないので束ねる。
  const dead = [];
  for (const e of evs) {
    switch (e.kind) {
      case '死亡': dead.push(e); break;
      case '一揆': case '粛清': case '空位': toast(e.text, 'bad'); break;
      case '発現': case '潜伏形質の発現': toast(e.text); break;
      case '帰化': case '任命': toast(e.text, 'warn'); break;
      // 初戦の予兆とフェーズ移行はトーストでは足りない。下でモーダルにする。
      default: break;
    }
  }
  if (dead.length === 1) toast(dead[0].text, 'bad');
  else if (dead.length > 1) toast(`この世代で ${dead.length} 体が死んだ。`, 'bad');

  // 外来の血が絶えた瞬間。P1の捕虜は1体なので、その1体が子を残す前に死ぬと
  // 色は単色に戻る。画面から斑が消えたことは、黙って起きてはいけない。
  const hasForeign = (w.mixState ? w.mixState.foreign : 0) > 0.0001;
  if (state.hadForeign && !hasForeign) {
    toast('外来の血が絶えた。色は単色に戻った。', 'bad');
  }
  state.hadForeign = hasForeign;

  if (w.collapsing) toast('産出率が消費を下回っている。', 'bad');

  refresh();

  // 村が部族になった瞬間。ここで配役の画面が消える。
  if (wasPhase === PHASE.VILLAGE && w.phase !== PHASE.VILLAGE) { announcePhase2(); return; }

  // 10体に達した。sim はここでフェーズ移行を止めて初戦を待っている。
  if (w.pendingFirstWar && !state.firstWarSeen) { state.firstWarSeen = true; announceFirstWar(); return; }

  // フェーズ1に報告は存在しない（全個体が画面にいるので自分で見ている）。
  // 世代境界で止めるのは、統治が人づてになるフェーズ2から。
  if (state.autoReport && w.phase !== PHASE.VILLAGE && w.gen > 0 && !document.querySelector('.scrim')) showReport();
}

// ------------------------------------------------------------------ 節目
//
// 「10体 → 初戦 → 捕虜1体 → フェーズ2」はこのゲームのビートシート。
// 通り過ぎさせないために、この2つだけはモーダルで止める。

function announceFirstWar() {
  const wasPaused = state.paused;
  state.paused = true;
  const body = el('div');
  mount(body,
    el('div', { class: 'card' },
      el('h4', {}, '村は10体で止まる'),
      el('p', {}, 'ここから先へ進む道は戦しかない。増えるだけでは部族にならない。'
        + '部族の幕を開けるのは人口ではなく、外から入ってくる血のほうだ。'),
    ),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, '規模'), el('div', { class: 'v' }, '5 対 5'),
      el('div', { class: 'k' }, '派遣'), el('div', { class: 'v' }, '初戦は派遣カードが効かない（同数・上位から）'),
      el('div', { class: 'k' }, '取り分'), el('div', { class: 'v' }, '勝っても負けても捕虜は1体'),
    ),
    el('p', { class: 'hint' },
      '5対5なら1体ずつ見える。攻撃素質が高い個体が、恐怖で固まったまま死ぬことがある。'
      + '素質と練度は別物だという話は、ここで一度だけ目で確認できる。'),
  );
  const m = modal({
    title: '10体になった', sub: '隣のシャーレが見えている',
    body, dismissable: false,
    footer: [
      el('button', {
        class: 'btn ghost', onclick: () => {
          m.close(); state.paused = wasPaused;
          toast('「隣のシャーレ」はいつでも押せる。押すまで村は10体のまま。', 'warn');
          refresh();
        },
      }, 'もう少し村を見る'),
      el('div', { style: { flex: 1 } }),
      el('button', {
        class: 'btn primary', onclick: () => { m.close(); startWarFlow(); },
      }, '隣のシャーレを見る'),
    ],
  });
  return m;
}

function announcePhase2() {
  const w = state.world;
  state.paused = true;
  const body = el('div');
  mount(body,
    el('div', { class: 'card' },
      el('h4', {}, '一体ずつ置く画面は、いま消えた'),
      el('p', {}, '外から血が1体入り、村は部族になった。'
        + '100体は手で置けない。誰をどこへ置くかは、これから局長が決める。'),
    ),
    // 何が奪われたのかを、タブそのものの形で見せる
    el('div', { class: 'ctl', style: { justifyContent: 'center', gap: '10px', margin: '12px 0' } },
      el('span', { class: 'tag bad', style: { textDecoration: 'line-through', opacity: '.7' } }, '配役'),
      el('span', { class: 'mut' }, '→'),
      el('span', { class: 'tag ac' }, '人事'),
    ),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, '残った手'), el('div', { class: 'v' }, '誰を局長に据えるか（人事）'),
      el('div', { class: 'k' }, '失った手'), el('div', { class: 'v' }, '一体ずつの配役・居住区の指定'),
      el('div', { class: 'k' }, 'これから'), el('div', { class: 'v' }, '報告は人づてになる。事実は正確に届くが、原因と帰属は歪む'),
    ),
    el('p', { class: 'hint' },
      'これは解禁ではなく喪失。この先も、増えるたびに手は1つずつ剥がされていく。'),
  );
  const m = modal({
    title: '村が部族になった', sub: `第 ${w.gen} 世代 ・ ${w.people.size} 体`,
    body, dismissable: false,
    footer: [
      el('div', { style: { flex: 1 } }),
      el('button', {
        class: 'btn primary', onclick: () => {
          m.close(); state.paused = false; state.tab = 'roles';
          toast('局長を任命するまで、誰も報告してこない。', 'warn');
          refresh();
        },
      }, '手を離す'),
    ],
  });
  return m;
}

// ------------------------------------------------------------------ トップバー
function renderTop() {
  const w = state.world;
  const box = document.getElementById('stats');
  const ratio = w.consumption ? w.yieldRate / w.consumption : 1;
  const rows = [
    ['フェーズ', w.phase === PHASE.VILLAGE ? '村' : '部族'],
    ['世代', String(w.gen)],
    ['人口', String(w.people.size)],
    ['備蓄', num(w.food, 1)],
    ['産出 / 消費', num(ratio, 2), ratio < 1],
    ['民心', pct(w.morale)],
    ['体制怨恨', num(w.regimeGrudge, 1), w.regimeGrudge > 4],
    ['国力', api.nationPower ? String(api.nationPower(w)) : '—'],
  ];
  clear(box);
  for (const [k, v, alarm] of rows) {
    box.appendChild(el('div', { class: 'stat' + (alarm ? ' alarm' : '') },
      el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)));
  }
  document.getElementById('btn-war').hidden = !(w.warReady && !w.borderQueue.length);
  renderClock(w);
}

// 世代の尺を画面に出す。倍速がこの尺の倍率であることが読めないと、
// 「1世代＝2分」という設計値が画面のどこにも無いのと同じになる。
function renderClock(w) {
  const box = document.getElementById('clock');
  if (!box) return;
  const effective = state.speed > 0 ? genMs(w) / state.speed : 0;
  clear(box);
  mount(box,
    el('b', {}, '経過 ' + mmss(state.elapsedMs)),
    el('span', {}, state.speed > 0
      ? `1世代 ${mmss(effective)}（設計値 ${mmss(genMs(w))} ×${state.speed}）`
      : `停止中（設計値 1世代 ${mmss(genMs(w))}）`),
  );
}

// 世代の進み。tick は P1 で10秒に1回しか来ないので、これが無いと
// 「動いているのに何も起きない2分間」がフリーズと区別できない。
function paintGenBar(w) {
  const bar = document.getElementById('genbar');
  if (!bar || !bar.firstChild) return;
  const withinTick = state.speed > 0 ? Math.min(1, acc / tickMs(w)) : 0;
  const p = (tickInGen + withinTick) / TICKS_PER_GEN;
  bar.firstChild.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderStrains() {
  const w = state.world;
  const box = document.getElementById('strains');
  const acc = {};
  let n = 0;
  for (const p of w.people.values()) {
    const L = p.lineage || { self: 1 };
    for (const k in L) acc[k] = (acc[k] || 0) + L[k];
    n++;
  }
  const rows = Object.entries(acc).map(([k, v]) => [k, v / (n || 1)]).sort((a, b) => b[1] - a[1]);
  clear(box);
  if (rows.length <= 1) return;
  box.appendChild(el('div', { class: 'strain', style: { color: '#525c72', marginBottom: '2px' } }, '血統の内訳'));
  for (const [k, v] of rows) {
    box.appendChild(el('div', { class: 'strain' },
      el('i', { style: { background: swatchColor(w, k) } }),
      el('span', {}, strainName(w, k)),
      el('u', {}, Math.round(v * 100) + '%')));
  }

  // 同化の進み。**外来血の量ではなく混血度（1 − 血統の最大成分）で出す。**
  // 隔離するとよそ者どうしで繁殖するので、量は多いまま混ざらない。
  // 量で判定すると「隔離しているのに混ざってきた」と表示してしまう。
  const st = w.mixState;
  if (!st) return;
  box.appendChild(el('div', { class: 'strain mix' },
    el('span', {}, mixLabel(st, rows.length)),
    el('u', {}, `混血度 ${st.admixture.toFixed(2)} ・ 純血 ${Math.round(st.pure * 100)}%`)));
}

/** 設計文書の語彙（単色／斑／混色）に落とす。 */
function mixLabel(st, strains) {
  if (strains <= 1) return '単色';
  if (st.admixture >= 0.25) return '混色';
  if (st.admixture >= 0.08) return '混ざりはじめ';
  return '斑（固定）';
}

function buildSpeed() {
  const box = document.getElementById('speed');
  clear(box);
  for (const s of [0, 1, 2, 4, 8]) {
    box.appendChild(el('button', {
      class: state.speed === s ? 'on' : '',
      title: s === 0 ? '止める' : `設計値の${s}倍（1世代 ${mmss(genMs(state.world) / s)}）`,
      onclick: () => { state.speed = s; buildSpeed(); if (state.world) renderClock(state.world); },
    }, s === 0 ? '⏸' : '×' + s));
  }
}

// ------------------------------------------------------------------ タブ
function buildTabs() {
  const nav = document.getElementById('tabs');
  clear(nav);
  for (const t of TABS) {
    if (t.key === 'roles' && state.world.phase !== PHASE.VILLAGE) t.label = '人事';
    const b = el('button', { class: state.tab === t.key ? 'on' : '', onclick: () => { state.tab = t.key; refresh(); } }, t.label);
    const n = t.badge ? t.badge() : 0;
    if (n) b.appendChild(el('span', { class: 'dot' }, String(n)));
    nav.appendChild(b);
  }
}

function refresh() {
  if (!state.world) return;
  renderTop(); renderStrains(); buildTabs();
  const body = document.getElementById('tabbody');
  const t = TABS.find(x => x.key === state.tab) || TABS[0];
  try { t.render(ctx, body); }
  catch (e) { clear(body); body.appendChild(el('div', { class: 'empty' }, '描画に失敗した：' + e.message)); console.error(e); }
}

function select(id, switchTab = true) {
  state.selected = id;
  if (switchTab) state.tab = 'ind';
  refresh();
}

// ------------------------------------------------------------------ 報告
function showReport() {
  const wasPaused = state.paused;
  state.paused = true;
  openReport(ctx, { onClose: () => { state.paused = wasPaused; refresh(); } });
}

// ------------------------------------------------------------------ 戦争
function startWarFlow() {
  state.paused = true;
  openOpponents(ctx,
    (opponent) => { openBattle(ctx, opponent); },
    // 相手を選ばずに閉じたときに止まったままにしない。
    // 世界が動かないのに理由が画面に出ていない状態は、行き止まりと区別がつかない。
    () => { state.paused = false; refresh(); });
}

function afterBorder() {
  state.paused = false;
  const w = state.world;
  document.getElementById('btn-war').hidden = !(w.warReady && !w.borderQueue.length);
  if (w.phase === PHASE.TRIBE && !Object.values(w.bureaus).some(v => v)) {
    state.tab = 'roles';
    toast('部族になった。局長を任命するまで、誰も報告してこない。', 'warn');
  }
  refresh();
}

// ------------------------------------------------------------------ デモ
// 「斑（まだら）→ 混色」を最初から見せるための開発用セットアップ。
function demoSetup() {
  const w = state.world, rng = state.rng;
  state.firstWarSeen = true;   // 初戦はこの中で済ませるので、あとから予兆を出さない

  // フェーズ1のあいだはオーナー（＝この関数）が配役する。放っておくと産出が止まる。
  const cast = () => {
    if (w.phase !== PHASE.VILLAGE) return;      // P2 以降は局長の仕事
    const list = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
    list.forEach((p, i) => {
      p.role = (i % 5 < 3) ? ROLE.FARM : (i % 5 === 3 ? ROLE.HUNT : ROLE.DRILL);
    });
  };
  // 実時間は待たない。tick数だけ sim と同じ粒度で回す（advanceGeneration は
  // 足りない分を自分で埋めるので、ここで多く回してはいけない）。
  const runGens = (n) => {
    for (let g = 0; g < n; g++) {
      cast();
      for (let t = 0; t < TICKS_PER_GEN; t++) api.stepTick(w, rng);
      api.advanceGeneration(w, rng);
    }
  };
  const fightAndAccept = (opp) => {
    if (!opp) return;
    const b = api.startWar(w, rng, opp);
    let guard = 0;
    while (!b.over && guard++ < 400) api.stepBattle(b, rng);
    api.takeCaptives(w, b, '攻撃素質', rng);
    for (const c of [...w.borderQueue]) api.borderDecision(w, c.id, 'accept');
    if (api.settleWar) api.settleWar(w, b);
  };

  runGens(6);                                   // 10体まで増やす

  const opps = api.listOpponents ? api.listOpponents(state.roster) : [];
  // 緑側と紫側から1国ずつ。赤・緑・紫は互いに100度以上離れるので斑が最も分かりやすく、
  // 混色（橙とピンク）も必ず親の間に落ちる。
  const nearest = (target) => [...opps].sort((a, b) => hueDist(a.hue, target) - hueDist(b.hue, target))[0];
  const far = [nearest(108), nearest(276)];

  fightAndAccept(far[0]);                       // ここでフェーズ2に入る
  // 局長を据えないと誰も配役しないので、この時点で任命する
  const cands = [...w.people.values()].filter(p => p.role !== ROLE.CHILD)
    .sort((a, b) => (api.powerOf ? api.powerOf(b) - api.powerOf(a) : 0));
  ['military', 'agri', 'civil'].forEach((k, i) => { if (cands[i]) api.appointBureau(w, k, cands[i].id); });

  runGens(3);
  fightAndAccept(far[1]);
  api.setCard(w, 'mix_policy', true, 100);      // 融和：色を溶かす
  runGens(4);

  w.food += 60;
  toast('デモ：外来の血が2系統入った状態から始める。融和度100なので世代ごとに色が溶ける。', 'warn');
}

// 無役の数。P1 では成熟した個体が無役で出てくるので、放っておくと産出が追いつかない。
// タブのバッジで気づかせる（配役はP1の主活動）。
function idleCount() {
  const w = state.world;
  if (!w) return 0;
  if (w.phase !== PHASE.VILLAGE) return Object.values(w.bureaus).filter(v => v == null).length;
  return [...w.people.values()].filter(p => p.role === ROLE.IDLE).length;
}

// 色相の円環上の距離
function hueDist(a, b) { const d = Math.abs((((a - b) % 360) + 360) % 360); return Math.min(d, 360 - d); }

// 開発用フック
window.増殖 = { state, api, ctx };
