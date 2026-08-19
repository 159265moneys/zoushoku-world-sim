// 画面のシェル。ルーティング・ループ・トップバー。
// 依存の向きは ui -> sim -> core の一方向。sim へは必ず api.js 越しに触る。

import { api, SIM_SOURCE, registerRoster } from './api.js';
import { RNG } from '../core/rng.js';
import { PHASE, ROLE, BUREAU_LABEL } from '../core/model.js';
import { el, clear, num, pct, toast } from './dom.js';
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

const TICK_MS = 220;
const TICKS_PER_GEN = 120;
const SEED = 20260819;

const state = {
  world: null, roster: null, rng: null, dish: null,
  speed: 1, paused: false, selected: null, tab: 'ind',
  castPick: null, openBureau: null, search: null, chron: null,
  battle: null, rosterDebug: false, autoReport: true,
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
openOpening((answers, mode) => {
  document.getElementById('app').hidden = false;
  boot(answers, mode);
});

function boot(answers, mode) {
  state.rng = new RNG(SEED);
  state.world = api.createWorld(SEED, answers, { name: '我らのシャーレ' });
  seedCards(api, state.world);
  try { state.roster = api.createRoster ? api.createRoster(SEED) : null; }
  catch (e) { console.warn('roster 生成に失敗', e); state.roster = null; }
  registerRoster(state.roster);

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
  const dt = Math.min(160, now - last); last = now;
  const w = state.world;
  if (!w) return;

  if (!state.paused && state.speed > 0) {
    acc += dt * state.speed;
    let guard = 0;
    while (acc >= TICK_MS && guard++ < 12) {
      acc -= TICK_MS;
      api.stepTick(w, state.rng);
      tickInGen++;
      if (tickInGen >= TICKS_PER_GEN) { tickInGen = 0; onGeneration(); }
    }
  }

  state.dish.sync(w);
  state.dish.selected = state.selected;
  state.dish.update(w, dt / 1000);
  state.dish.draw(w);

  dockAcc += dt;
  if (dockAcc > 450) { dockAcc = 0; renderTop(); renderStrains(); }
}

function onGeneration() {
  const w = state.world;
  const evs = api.advanceGeneration(w, state.rng) || [];
  try { if (api.stepRoster) api.stepRoster(state.roster, state.rng); } catch (e) { /* ロスターは無くても続く */ }

  for (const e of evs) {
    // 叩き起こされる条件：局長の死・空位／フェーズ転換／産出が消費を下回った
    if (e.kind === 'フェーズ' || e.kind === '接触') toast(e.text, 'warn');
    else if (e.kind === '空位') toast(e.text, 'bad');
    else if (e.kind === '死亡') toast(e.text, 'bad');
    else if (e.kind === '発現') toast(e.text);
  }
  if (w.warReady && !w.borderQueue.length) document.getElementById('btn-war').hidden = false;
  if (w.collapsing) toast('産出率が消費を下回っている。', 'bad');

  refresh();
  // フェーズ1に報告は存在しない（全個体が画面にいるので自分で見ている）。
  // 世代境界で止めるのは、統治が人づてになるフェーズ2から。
  if (state.autoReport && w.phase !== PHASE.VILLAGE && w.gen > 0 && !document.querySelector('.scrim')) showReport();
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
}

function buildSpeed() {
  const box = document.getElementById('speed');
  clear(box);
  for (const s of [0, 1, 2, 4, 8]) {
    box.appendChild(el('button', {
      class: state.speed === s ? 'on' : '',
      onclick: () => { state.speed = s; buildSpeed(); },
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
  openOpponents(ctx, (opponent) => {
    openBattle(ctx, opponent);
  });
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

  // フェーズ1のあいだはオーナー（＝この関数）が配役する。放っておくと産出が止まる。
  const cast = () => {
    if (w.phase !== PHASE.VILLAGE) return;      // P2 以降は局長の仕事
    const list = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
    list.forEach((p, i) => {
      p.role = (i % 5 < 3) ? ROLE.FARM : (i % 5 === 3 ? ROLE.HUNT : ROLE.DRILL);
    });
  };
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
