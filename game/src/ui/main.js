// 画面のシェル。ルーティング・ループ・トップバー。
// 依存の向きは ui -> sim -> core の一方向。sim へは必ず api.js 越しに触る。

import { api, SIM_SOURCE } from './api.js';
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
const TICKS_PER_GEN = 40;
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
  { key: 'roles', label: '配役', render: renderRoles },
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

  requestAnimationFrame(loop);
  refresh();
}

// ------------------------------------------------------------------ ループ
let last = performance.now(), acc = 0, tickInGen = 0, dockAcc = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(80, now - last); last = now;
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
    if (e.kind === 'フェーズ') toast(e.text, 'warn');
    else if (e.kind === '死亡') toast(e.text, 'bad');
    else if (e.kind === '発現') toast(e.text);
  }
  if (w.warReady && !w.borderQueue.length) document.getElementById('btn-war').hidden = false;
  if (w.collapsing) toast('産出率が消費を下回っている。', 'bad');

  refresh();
  if (state.autoReport && w.gen > 0 && !document.querySelector('.scrim')) showReport();
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
  for (let g = 0; g < 4; g++) {
    for (let t = 0; t < TICKS_PER_GEN; t++) api.stepTick(w, rng);
    api.advanceGeneration(w, rng);
  }
  const opps = api.listOpponents ? api.listOpponents(state.roster) : [];
  for (const pick of [opps[3], opps[4]].filter(Boolean)) {     // 純血 と 融和
    const b = api.startWar(w, rng, pick);
    let guard = 0;
    while (!b.over && guard++ < 300) api.stepBattle(b, rng);
    api.takeCaptives(w, b, '攻撃素質', rng);
    for (const c of [...w.borderQueue]) api.borderDecision(w, c.id, 'accept');
    for (let g = 0; g < 2; g++) {
      for (let t = 0; t < TICKS_PER_GEN; t++) api.stepTick(w, rng);
      api.advanceGeneration(w, rng);
    }
  }
  // 局長を据えておく
  const cands = [...w.people.values()].filter(p => p.role !== ROLE.CHILD)
    .sort((a, b) => (api.powerOf ? api.powerOf(b) - api.powerOf(a) : 0));
  ['military', 'agri', 'civil'].forEach((k, i) => { if (cands[i]) api.appointBureau(w, k, cands[i].id); });
  w.food += 40;
  toast('デモ：外来の血が2系統入った状態から始める。融和度を上げると色が溶ける。', 'warn');
}

// 開発用フック
window.増殖 = { state, api, ctx };
