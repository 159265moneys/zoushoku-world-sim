// 画面のシェル。ルーティング・ループ・トップバー。
//
// 依存の向きは **ui → flow → sim → core** の一方向（R-950）。
//   進む・止まる・戦う      … `src/flow/`（run / war / clock / rules）だけを呼ぶ
//   読む・書く（役・カード） … `api.js` 越しに sim を読む
// **世界を作るのも、tick を刻むのも、世代を進めるのも、戦争も、もう画面の仕事ではない。**
// 画面が sim の startWar / settleWar / takeCaptives / borderDecision を呼ぶことは
// 禁止されている（R-951・静的検査 G-18）。
//
// 【画面の設計方針】
//   1. 薄い文字を書かない。読めない説明文は無いほうがマシ
//   2. スコープの違うものを同じ見た目で並べない。
//      「一体だけ」の画面（左のオーバーレイ）と「国ぜんたい」の画面（右のドック）は
//      場所も色も分ける。以前はタブ列に「個体」と「方針」が並んでいて、
//      「他のタブも個体にかかる」と読まれていた
//   3. 「何が置いてあるか」ではなく「何をすればいいか」。
//      ドックの最上段は常に “いまやること”

import { api, SIM_SOURCE, registerRoster, adapt } from './api.js';
import { PHASE, ROLE, BUREAU_LABEL } from '../core/model.js';
import * as flow from '../flow/run.js';
import * as war from '../flow/war.js';
import * as clock from '../flow/clock.js';
import { RUNNING_STAGES, TICKS_PER_GEN } from '../flow/rules.js';
import { el, clear, num, pct, toast, modal, mount, DEV } from './dom.js';
import { Dish } from './dish.js';
import { swatchColor, strainName } from './color.js';

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
// 世代の長さ（1世代＝何ミリ秒か）は **進行層の時計** が持つ（flow/clock.js）。
// 画面はそれを読むだけ。倍速はこの尺に対する倍率で、×1 が設計値。
const genMs = (w) => clock.genMs(w);
const tickMs = (w) => clock.tickMs(w);

const SEED = 20260819;

const state = {
  run: null,                 // ← 1回のプレイ。world / roster / rng / stage の持ち主
  world: null, roster: null, dish: null,
  speed: 1, paused: false, selected: null, tab: 'roles',
  castPick: null, openBureau: null, search: null, chron: null,
  battle: null, rosterDebug: false, autoReport: true,
  elapsedMs: 0, hadForeign: false, species: null,
};

const ctx = {
  get world() { return state.world; },
  get run() { return state.run; },
  get rng() { return state.run ? state.run.rng : null; },
  api, state,
  refresh, select, afterBorder,
};

// ドックに置くのは **国ぜんたい** にかかるものだけ。
// 「一体だけ」を見る画面はここに入れない（左のオーバーレイが担当）。
const TABS = [
  { key: 'roles', label: '仕事', render: renderRoles, badge: () => idleCount() },
  { key: 'policy', label: 'きまり', render: renderPolicy },
  { key: 'pet', label: '願い', render: renderPetitions, badge: () => petitionCount(ctx) },
  { key: 'search', label: '名簿', render: renderSearch },
  { key: 'chron', label: '年代記', render: renderChronicle },
];

// ------------------------------------------------------------------ 起動
openOpening({
  build: (answers, opts) => buildWorld(answers, opts),
  start: (mode) => startWorld(mode),
});

function buildWorld(answers, opts = {}) {
  const spec = opts.centroid ? { centroid: opts.centroid } : answers;
  // 世界も10国も乱数も、作るのは進行層。画面は出来たものを受け取るだけ（R-950）。
  state.run = flow.createRun({
    seed: SEED,
    answers: SIM_SOURCE === 'sim' ? spec : answers,
    name: '我らのシャーレ',
    species: opts.species || null,
    responses: opts.responses || null,
  });
  state.world = adapt(state.run.world);   // 画面が読む面（血すじ・推移・国境）を生やす
  state.roster = state.run.roster;
  state.species = opts.species || null;
  registerRoster(state.roster);
  // P1では方針カードを1枚も立てない（R-964）。5枚が立つのは部族に上がった瞬間で、
  // それは進行層（flow/run.js の enterTribe）の仕事になった。
  reportFaults();
  return state.world;
}

/** 進行層が握りつぶさずに積んだ失敗。無言で消さない（#19：空の catch で10国が止まった） */
function reportFaults() {
  const R = state.run;
  if (!R || !R.faults.length) return;
  for (const f of R.faults.splice(0)) {
    console.warn(`[flow] 第${f.gen}世代 ${f.where}: ${f.message}`);
    if (DEV) toast(`[flow] ${f.where}: ${f.message}`, 'bad');
  }
}

function startWorld(mode) {
  document.getElementById('app').hidden = false;

  // どの実装が動いているかは開発者にしか意味がない。遊ぶ人には出さない。
  // ただしモック（＝壊れたビルド）で動いているときは、黙っていてはいけない。
  const badge = document.getElementById('sim-badge');
  const isMock = SIM_SOURCE !== 'sim';
  badge.hidden = !isMock && !DEV;
  badge.textContent = isMock ? 'mock sim' : 'sim';
  badge.className = 'badge ' + (isMock ? 'mock' : 'live');

  state.dish = new Dish(document.getElementById('dish'));
  state.dish.onPick = (id) => { if (id != null) select(id); };

  document.getElementById('ind-close').onclick = () => closeIndividual();
  document.getElementById('legend').innerHTML =
    '<b>色</b> 血すじ　<b>濃さ</b> 熟練　<b>明るさ</b> 若さ　<b>目</b> 大きいほど鋭い';

  buildTabs();
  buildSpeed();

  if (mode === 2) demoSetup();
  if (state.species) toast(`種族：${state.species.name}（${state.species.code}）`, 'warn');

  // 時計の原点はここ。診断に何分かけていても世界の時間には入れない。
  last = performance.now(); lastDraw = last; acc = 0; state.elapsedMs = 0;

  setInterval(loop, FRAME_MS);
  refresh();
}

// ------------------------------------------------------------------ ループ
// requestAnimationFrame ではなくタイマーで回す。rAF は裏タブで止まるので、
// タブを切り替えただけで世界の時計まで止まってしまう。
const FRAME_MS = 33;
let last = performance.now(), lastDraw = performance.now(), acc = 0, dockAcc = 0;

function loop() {
  const now = performance.now();
  const R = state.run, w = state.world;
  if (!R || !w) { last = now; return; }

  // 止める／速さは画面の持ちものだが、**進めてよいかどうかを決めるのは進行層**。
  // 村がいっぱいのあいだ（R-956）と戦のあいだは、押しても1tickも進まない。
  R.paused = state.paused;
  R.speed = state.speed;

  // 1フレームで進めてよい実時間の上限は「1世代ぶん」。裏タブでタイマーが絞られても、
  // 起きた瞬間に寝ていたぶんを取り戻す（「不在中も世界は進む」）。
  const dt = Math.min(genMs(w), now - last); last = now;
  state.elapsedMs += dt;

  if (flow.isRunning(R)) {
    acc += dt * state.speed;
    const step = tickMs(w);
    let guard = 0;
    while (acc >= step && guard++ < TICKS_PER_GEN) {
      acc -= step;
      // 進行層が「進んだ数」を返す。0 なら世界が止まっている（世代境界・上限・戦）。
      if (flow.advanceTicks(R, 1) === 0) { acc = 0; break; }
      if (flow.atGenBoundary(R)) onGeneration();
    }
    if (acc > step * TICKS_PER_GEN) acc = step * TICKS_PER_GEN;
  } else {
    acc = 0;
  }

  state.dish.sync(w);
  state.dish.selected = state.selected;
  // **見た目の dt に世界の取り戻しぶんを流しこまない。**
  //   世界の dt は「1世代ぶん」まで許す（裏タブで寝ていた分を取り戻すため）が、
  //   それを住人の運動にそのまま渡すと dt が最大 75 秒（P2 では 180 秒）になり、
  //   ばね（速度 += 変位 × 係数 × dt）の利得が 1 を大きく超えて **発散する**。
  //   実測：1度でも詰まると座標が -741045 まで飛び、住人が永久に画面外＝盤面が真っ黒。
  //   アニメーションは実時間の1フレーム分だけでよい。
  state.dish.update(w, Math.min(0.1, (now - lastDraw) / 1000));
  lastDraw = now;
  state.dish.draw(w);

  dockAcc += dt;
  if (dockAcc > 250) { dockAcc = 0; renderTop(); renderStrains(); renderTodo(); }
  paintGenBar(w);
}

function onGeneration() {
  const R = state.run, w = state.world;
  const wasBureaus = { ...w.bureaus };

  // 1世代ぶんを進行層に頼む。中でやっているのは
  //   段A（fertBias・透過率0.9）→ sim の世代 → 段B（あふれた新生児の旅立ち）
  //   → 10国を1世代 → 部族に上がったなら既定カード5枚 → 節目の知らせ
  // （R-954 / R-955 / R-957 / R-964）。落ちたら握りつぶさずに止める。
  let evs = [];
  try { evs = flow.advanceGeneration(R) || []; }
  catch (e) {
    console.error(e);
    state.paused = true; buildSpeed();
    toast('世代を進められなかった。ここで時間を止める：' + e.message, 'bad');
    return;
  }
  reportFaults();

  for (const k in wasBureaus) {
    if (wasBureaus[k] != null && w.bureaus[k] == null) {
      toast(`${BUREAU_LABEL[k]}の長が死んだ。空席のあいだ、この局からは何も報告が来ない。`, 'bad');
    }
  }

  // 死亡は世代あたり複数出る。1件ずつ流すとトーストが埋まって他が読めないので束ねる。
  const dead = [];
  for (const e of evs) {
    switch (e.kind) {
      case '死亡': dead.push(e); break;
      case '一揆': case '粛清': case '空位': toast(e.text, 'bad'); break;
      case '発現': case '潜伏形質の発現': toast(e.text); break;
      case '帰化': case '任命': toast(e.text, 'warn'); break;
      default: break;
    }
  }
  if (dead.length === 1) toast(dead[0].text, 'bad');
  else if (dead.length > 1) toast(`この世代で ${dead.length} 体が死んだ。`, 'bad');

  // 外来の血が絶えた瞬間。画面から斑が消えたことは、黙って起きてはいけない。
  const hasForeign = (w.mixState ? w.mixState.foreign : 0) > 0.0001;
  if (state.hadForeign && !hasForeign) toast('外来の血が絶えた。色は単色に戻った。', 'bad');
  state.hadForeign = hasForeign;

  if (w.collapsing) toast('作る量より食べる量のほうが多い。このままだと飢える。', 'bad');

  refresh();

  // 節目は進行層が「知らせ」として積む。画面はどれをモーダルにするかを決めるだけ。
  if (showNotices(flow.takeNotices(R))) return;

  // フェーズ1に報告は存在しない（全個体が画面にいるので自分で見ている）。
  if (state.autoReport && w.phase !== PHASE.VILLAGE && w.gen > 0 && !document.querySelector('.scrim')) showReport();
}

/**
 * 進行層の知らせを画面に出す。**モーダルは1画面に1つ**なので、
 * 束で来たときは重いほうを1つだけ出し、残りはトーストにする（R-904）。
 * @returns true … モーダルを出した（＝このあと帰還報告を自動で開かない）
 */
function showNotices(list) {
  if (!list.length) return false;
  const rank = { 行き止まり: 4, 部族: 3, 上限: 2, 百: 1, 旅立ち: 0 };
  const sorted = [...list].sort((a, b) => (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0));
  const top = sorted[0];
  for (const n of sorted.slice(1)) if (n.text) toast(n.text, 'warn');
  switch (top.kind) {
    case '上限': announceFirstWar(top); return true;
    case '部族': announcePhase2(); return true;
    case '百': case '行き止まり': announceNotice(top); return true;
    default: if (top.text) toast(top.text, 'warn'); return false;
  }
}

// ------------------------------------------------------------------ 節目
// 「10体 → 初戦 → 捕虜1体 → フェーズ2」はこのゲームのビートシート。
// 通り過ぎさせないために、この2つだけはモーダルで止める。1画面に1つの用件。

function announceFirstWar(notice = null) {
  const w = state.world;
  const pop = notice && notice.pop != null ? notice.pop : w.people.size;
  const wasPaused = state.paused;
  state.paused = true;
  const body = el('div');
  mount(body,
    el('p', { style: { fontSize: '17px', lineHeight: '1.75', margin: '0 0 14px' } },
      '村は10体で止まります。これ以上は増えません。'),
    el('p', { style: { fontSize: '17px', lineHeight: '1.75', margin: '0 0 16px' } },
      '先へ進む道は戦いだけです。勝っても負けても相手から1体を連れ帰り、'
      + 'その1体がよそ者の血を持ちこんだとき、村は部族になります。'),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, '規模'), el('div', { class: 'v' }, '5対5'),
      el('div', { class: 'k' }, '連れ帰る数'), el('div', { class: 'v' }, '勝っても負けても1体'),
      el('div', { class: 'k' }, '出す顔ぶれ'), el('div', { class: 'v' }, '初戦だけは強い順に自動で決まる'),
    ),
  );
  const m = modal({
    title: `${pop}体になった`, sub: '隣のシャーレが見えている',
    body, cls: 'narrow', dismissable: false,
    footer: [
      el('button', {
        class: 'btn', onclick: () => {
          m.close(); state.paused = wasPaused;
          toast('「隣のシャーレへ」はいつでも押せる。押すまで村は10体のまま。時間も止まっている。', 'warn');
          buildSpeed(); refresh();
        },
      }, 'もう少し村を見る'),
      el('div', { style: { flex: 1 } }),
      el('button', {
        class: 'btn primary big', onclick: () => { m.close(); startWarFlow(); },
      }, '隣のシャーレへ行く'),
    ],
  });
  return m;
}

function announcePhase2() {
  const w = state.world;
  state.paused = true;
  const body = el('div');
  mount(body,
    el('p', { style: { fontSize: '17px', lineHeight: '1.75', margin: '0 0 14px' } },
      'よそ者の血が1体入り、村は部族になりました。'),
    el('p', { style: { fontSize: '17px', lineHeight: '1.75', margin: '0 0 8px' } },
      'ここから先は、一体ずつ仕事を決めることができなくなります。'),
    el('div', { class: 'ctl', style: { justifyContent: 'center', gap: '14px', margin: '16px 0' } },
      el('span', { class: 'tag bad', style: { textDecoration: 'line-through', fontSize: '15px', padding: '5px 12px' } }, '一体ずつ仕事を決める'),
      el('span', { class: 'mut', style: { fontSize: '18px' } }, '→'),
      el('span', { class: 'tag ac', style: { fontSize: '15px', padding: '5px 12px' } }, '3人の長を選ぶ'),
    ),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'あなたの手に残るもの'), el('div', { class: 'v' }, '軍務・農業・民生の3つの局に、誰を長として据えるか'),
      el('div', { class: 'k' }, '奪われるもの'), el('div', { class: 'v' }, '一体ずつの仕事と住む場所の指定'),
      el('div', { class: 'k' }, 'これから'), el('div', { class: 'v' }, '数字は正確に届く。歪むのは「なぜそうなったか」だけ'),
      // 数字を手で書かない。GEN_MS が動いたら（R-960）この文もついてくる
      el('div', { class: 'k' }, '時間の流れ'), el('div', { class: 'v' },
        `1世代が ${clock.fmtDuration(clock.genMs({ phase: PHASE.VILLAGE }))} から `
        + `${clock.fmtDuration(clock.genMs({ phase: PHASE.TRIBE }))} に伸びる。急ぐときは右上の ×8 を押す`),
    ),
  );
  const m = modal({
    title: '村が部族になった', sub: `第 ${w.gen} 世代 ・ ${w.people.size} 体`,
    body, cls: 'narrow', dismissable: false,
    footer: [
      el('div', { style: { flex: 1 } }),
      el('button', {
        class: 'btn primary big', onclick: () => {
          m.close(); state.paused = false; state.tab = 'roles';
          toast('長を1人も置かないと、誰も報告してこない。', 'warn');
          buildSpeed(); refresh();
        },
      }, '3人の長を選ぶ'),
    ],
  });
  return m;
}

/**
 * 進行層の知らせ（人口100・行き止まり）をそのまま出す。**「負け」とは書かない**（R-965）。
 * 文も選択肢も進行層が持っている。画面はそれを並べるだけ。
 */
function announceNotice(n) {
  const end = n.kind === '行き止まり';
  state.paused = true;
  const body = el('div');
  mount(body,
    el('p', { style: { fontSize: '17px', lineHeight: '1.75', margin: '0 0 14px' } }, n.text),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, '世代'), el('div', { class: 'v' }, `第 ${n.gen} 世代`),
      el('div', { class: 'k' }, '人口'), el('div', { class: 'v' }, String(n.pop)),
      ...(end ? [
        el('div', { class: 'k' }, '作る量'), el('div', { class: 'v' }, num(n.yieldRate ?? 0, 2)),
        el('div', { class: 'k' }, '食べる量'), el('div', { class: 'v' }, num(n.consumption ?? 0, 2)),
        el('div', { class: 'k' }, '蔵'), el('div', { class: 'v' }, num(n.food ?? 0, 0)),
      ] : []),
    ),
  );
  // 出せるのは「閉じて世界を見続ける」ほうだけ。「もう一度はじめる」は段4（入口）の担当。
  const choices = n.choices || ['閉じる'];
  const label = end ? choices[0] : choices[choices.length - 1];
  const m = modal({
    title: end ? 'この村はもう増えない' : 'ここまで',
    sub: `第 ${n.gen} 世代 ・ ${n.pop} 体`,
    body, cls: 'narrow', dismissable: !end,
    footer: [
      el('div', { style: { flex: 1 } }),
      el('button', {
        class: 'btn primary big',
        onclick: () => { m.close(); state.paused = false; buildSpeed(); refresh(); },
      }, label),
    ],
  });
  return m;
}

// ------------------------------------------------------------------ トップバー
// 出すのは数値と、その数値が「良いのか悪いのか」の一言だけ。
// 素の 1.15 や 0.0 は、それ単体では意味が読めない。
function renderTop() {
  const w = state.world;
  const box = document.getElementById('stats');
  const ratio = w.consumption ? w.yieldRate / w.consumption : 1;

  const food = w.collapsing ? ['危ない', 'alarm']
    : ratio < 1 ? ['減っている', 'alarm']
    : ratio < 1.15 ? ['ぎりぎり', '']
    : ['増えている', 'good'];
  const mor = w.morale >= 0.6 ? ['良い', 'good'] : w.morale >= 0.4 ? ['ふつう', ''] : ['悪い', 'alarm'];
  const gr = w.regimeGrudge >= 4 ? ['危険', 'alarm'] : w.regimeGrudge >= 1.5 ? ['くすぶる', ''] : ['なし', 'good'];

  const rows = [
    ['いま', w.phase === PHASE.VILLAGE ? '村' : '部族', ''],
    ['世代', String(w.gen), ''],
    ['人口', String(w.people.size), ''],
    ['食べもの', num(w.food, 0), food[1], food[0]],
    ['民心', pct(w.morale), mor[1], mor[0]],
    ['国への恨み', num(w.regimeGrudge, 1), gr[1], gr[0]],
    ['国の強さ', api.nationPower ? String(api.nationPower(w)) : '—', ''],
  ];
  clear(box);
  for (const [k, v, cls, sub] of rows) {
    box.appendChild(el('div', { class: 'stat' + (cls ? ' ' + cls : '') },
      el('div', { class: 'k' }, k),
      el('div', { class: 'v' }, v, sub ? el('small', {}, sub) : null)));
  }
  renderClock(w);
}

function renderClock(w) {
  const box = document.getElementById('clock');
  if (!box) return;
  const R = state.run;
  const running = !!R && flow.isRunning(R);
  const effective = state.speed > 0 ? genMs(w) / state.speed : 0;
  clear(box);
  mount(box,
    el('b', {}, '経過 ' + mmss(state.elapsedMs)),
    // 進行層が「動いていない」と言っているときに「1世代 2:00」と出さない。
    // 止まっているかどうかを決めるのは画面ではなく進行層（R-956）。
    el('span', { title: running ? '' : (flow.stopReason(R) || '') },
      running ? `1世代 ${mmss(effective)}` : '止まっている'),
  );
}

function paintGenBar(w) {
  const bar = document.getElementById('genbar');
  if (!bar || !bar.firstChild) return;
  const R = state.run;
  const withinTick = state.speed > 0 ? Math.min(1, acc / tickMs(w)) : 0;
  // 世代のどこまで来ているかを数えているのは進行層（run.tickInGen）。
  const p = ((R ? R.tickInGen : 0) + withinTick) / TICKS_PER_GEN;
  bar.firstChild.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ 血すじHUD
function renderStrains() {
  const w = state.world;
  const box = document.getElementById('strains');
  const acc2 = {};
  let n = 0;
  for (const p of w.people.values()) {
    const L = p.lineage || { self: 1 };
    for (const k in L) acc2[k] = (acc2[k] || 0) + L[k];
    n++;
  }
  const rows = Object.entries(acc2).map(([k, v]) => [k, v / (n || 1)]).sort((a, b) => b[1] - a[1]);
  clear(box);
  if (rows.length <= 1) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.appendChild(el('div', { class: 'strain-title' }, '血すじの内わけ'));
  for (const [k, v] of rows) {
    box.appendChild(el('div', { class: 'strain' },
      el('i', { style: { background: swatchColor(w, k) } }),
      el('span', {}, strainName(w, k)),
      el('u', {}, Math.round(v * 100) + '%')));
  }

  // 同化の進みは「外来血の量」ではなく混血度で出す。
  // 隔離するとよそ者どうしで繁殖するので、量は多いまま混ざらない。
  const st = w.mixState;
  if (!st) return;
  box.appendChild(el('div', { class: 'strain mix' },
    el('span', {}, mixLabel(st, rows.length)),
    el('u', {}, `混ざり具合 ${st.admixture.toFixed(2)}　まじりけ無し ${Math.round(st.pure * 100)}%`)));
}

function mixLabel(st, strains) {
  if (strains <= 1) return '単色';
  if (st.admixture >= 0.25) return '溶けあっている';
  if (st.admixture >= 0.08) return '混ざりはじめ';
  return 'まだら（混ざっていない）';
}

// ------------------------------------------------------------------ 時間
function buildSpeed() {
  const box = document.getElementById('speed');
  if (!box) return;
  const R = state.run;
  // 世界の時計が動いてよい局面かどうかを決めるのは進行層（R-956）。
  // 村がいっぱいのあいだは ▶ も ×8 も押せない。**押せない理由をホバーで出す**（R-943）。
  const live = !!R && RUNNING_STAGES.has(R.stage);
  const why = live ? '' : (R ? (flow.stopReason(R) || '') : '');
  clear(box);
  // 「止める／進める」は状態の切り替え。「速さ」は倍率。種類が違うので升を分ける。
  box.appendChild(el('button', {
    class: 'pause' + (state.paused ? ' on' : ''),
    disabled: !live, title: why,
    onclick: () => { state.paused = !state.paused; buildSpeed(); if (state.world) renderClock(state.world); },
  }, state.paused ? '▶ 進める' : '⏸ 止める'));
  const rates = el('div', { class: 'rates' });
  for (const s of [1, 2, 4, 8]) {
    rates.appendChild(el('button', {
      class: state.speed === s ? 'on' : '',
      disabled: !live,
      title: why || `設計値の${s}倍`,
      onclick: () => { state.speed = s; buildSpeed(); if (state.world) renderClock(state.world); },
    }, '×' + s));
  }
  box.appendChild(rates);
}

// ------------------------------------------------------------------ いまやること
//
// この箱がこの画面の主役。「何が置いてあるか」ではなく「何をすればいいか」を出す。
// 用件は多くて3つまで。それ以上並べると、また読まれなくなる。
function renderTodo() {
  const w = state.world;
  const R = state.run;
  const box = document.getElementById('todo');
  if (!box) return;
  const items = [];

  const push = (tone, title, why, label, act) => items.push({ tone, title, why, label, act });

  if (w.borderQueue && w.borderQueue.length) {
    push('hot', `連れ帰った ${w.borderQueue.length} 体の処遇が決まっていない`,
      '受け入れるか、殺すか、返すか。', '決める', () => afterBorder());
  }
  // 「戦いに行けるか」を決めるのは進行層。人口・不応期・国境・相手の有無を
  // 1か所で見て、押せないときは理由を持って返す（R-943 / R-963 / R-965）。
  const why = R ? war.warReason(R) : { ok: false };
  if (why.ok) {
    push('hot', '隣のシャーレが見えている',
      why.firstWar ? '戦って1体を連れ帰らないと、村は10体のまま止まる。' : '勝てば相手の血が手に入る。',
      '戦いに行く', () => startWarFlow());
  }

  if (w.phase === PHASE.VILLAGE) {
    const idle = [...w.people.values()].filter(p => p.role === ROLE.IDLE).length;
    if (idle) {
      push('', `${idle} 体が何もしていない`,
        '無役は食べるだけで何も作らない。畑か狩りに置く。', '仕事を割りふる',
        () => { state.tab = 'roles'; refresh(); });
    }
  } else {
    const empty = Object.entries(w.bureaus).filter(([, v]) => v == null);
    if (empty.length) {
      push('', `${empty.length} つの局に長がいない`,
        '長がいない局からは、報告も願いも来ない。', '長を選ぶ',
        () => { state.tab = 'roles'; refresh(); });
    }
    const pets = petitionCount(ctx);
    if (pets) {
      push('', `${pets} 件の願いが届いている`,
        '通すか断るか。どちらでも誰かが不満を持つ。', '読んで決める',
        () => { state.tab = 'pet'; refresh(); });
    }
  }

  // 「産出/消費が赤いが、何をすれば直るのか書いていない」への答え。
  // 崩壊の一歩手前（比が1未満）で拾い、**放っておくとどうなるかまで**書く。
  const ratio = w.consumption ? w.yieldRate / w.consumption : 1;
  if (w.collapsing) {
    push('hot', '食べ物が尽きかけている',
      'このままだと飢えて死にはじめる。畑に回す人を増やす。',
      w.phase === PHASE.VILLAGE ? '仕事を見直す' : 'きまりを見直す',
      () => { state.tab = w.phase === PHASE.VILLAGE ? 'roles' : 'policy'; refresh(); });
  } else if (ratio < 1 && w.food < 40) {
    push('', '作る量より食べる量のほうが多い',
      '備蓄が減っていく。子どもが育てば自然に戻ることも多いが、'
      + '備蓄が尽きる前に畑を増やしておくと安全。',
      w.phase === PHASE.VILLAGE ? '畑を増やす' : 'きまりを見直す',
      () => { state.tab = w.phase === PHASE.VILLAGE ? 'roles' : 'policy'; refresh(); });
  }

  clear(box);
  box.appendChild(el('div', { class: 'todo-title' }, 'いまやること'));
  if (!items.length) {
    box.appendChild(el('div', { class: 'todo-ok' }, 'いまは無い。世界が進むのを待つ。'));
  }
  for (const it of items.slice(0, 3)) {
    box.appendChild(el('div', { class: 'todo ' + it.tone },
      el('div', { class: 't' }, el('b', {}, it.title), el('span', {}, it.why)),
      el('button', { class: 'btn ' + (it.tone === 'hot' ? 'war' : 'primary'), onclick: it.act }, it.label),
    ));
  }
  // 報告はいつでも読めるべきだが、用件ではない。行動の列とは別の行に置く。
  box.appendChild(el('button', {
    class: 'btn sm block', style: { marginTop: '8px' }, onclick: () => showReport(),
  }, '国のようすを読む（帰還報告）'));
}

// ------------------------------------------------------------------ タブ（国）
function buildTabs() {
  const nav = document.getElementById('tabs');
  clear(nav);
  for (const t of TABS) {
    let label = t.label;
    if (t.key === 'roles') label = state.world.phase === PHASE.VILLAGE ? '仕事' : '長を選ぶ';
    const b = el('button', {
      class: state.tab === t.key ? 'on' : '',
      onclick: () => { state.tab = t.key; refresh(); },
    }, label);
    const n = t.badge ? t.badge() : 0;
    if (n) b.appendChild(el('span', { class: 'dot' }, String(n)));
    nav.appendChild(b);
  }
}

function refresh() {
  if (!state.world) return;
  renderTop(); renderStrains(); renderTodo(); buildTabs(); buildSpeed();

  const body = document.getElementById('tabbody');
  const t = TABS.find(x => x.key === state.tab) || TABS[0];
  try { t.render(ctx, body); }
  catch (e) { clear(body); body.appendChild(el('div', { class: 'empty' }, '描画に失敗した：' + e.message)); console.error(e); }

  renderIndividual();
}

// ------------------------------------------------------------------ 個体（一体だけ）
function renderIndividual() {
  const panel = document.getElementById('indpanel');
  const body = document.getElementById('indbody');
  if (!panel || !body) return;
  const id = state.selected;
  const ind = id != null ? (state.world.people.get(id) || state.world.dead.get(id)) : null;
  const stage = document.getElementById('stage');
  if (!ind) { panel.hidden = true; stage.classList.remove('ind-open'); clear(body); return; }
  panel.hidden = false;
  stage.classList.add('ind-open');
  try { renderInspector(ctx, body); }
  catch (e) { clear(body); body.appendChild(el('div', { class: 'empty' }, '描画に失敗した：' + e.message)); console.error(e); }
}

function closeIndividual() {
  state.selected = null;
  document.getElementById('indpanel').hidden = true;
  document.getElementById('stage').classList.remove('ind-open');
  clear(document.getElementById('indbody'));
}

/**
 * 個体を選ぶ。**タブは切り替えない。**
 * 個体は左のオーバーレイに出るので、右のドック（国ぜんたい）はそのまま残る。
 * 第2引数は旧シグネチャの名残（呼び出し側を壊さないために受けるだけ）。
 */
function select(id, _switchTab = true) {
  state.selected = id;
  refresh();
}

// ------------------------------------------------------------------ 報告
function showReport() {
  const wasPaused = state.paused;
  state.paused = true;
  openReport(ctx, { onClose: () => { state.paused = wasPaused; refresh(); } });
}

// ------------------------------------------------------------------ 戦争
// 画面がやるのは「相手を選ぶ → 戦闘を見る → 捕虜と国境を決める」の3枚を順に開くことだけ。
// 呼ぶ順番（S0〜S10）を持っているのは flow/war.js で、画面はそれを見ない（R-951 / R-952）。
function startWarFlow() {
  state.paused = true;
  openOpponents(ctx,
    (target) => { openBattle(ctx, target); },
    // 相手を選ばずに閉じたときに止まったままにしない。
    () => { state.paused = false; buildSpeed(); refresh(); });
}

function afterBorder() {
  state.paused = false;
  const R = state.run, w = state.world;
  // 戦が締まった（S9）ので、stage を世界の値から作り直す＝ここで時計が戻る（S10）。
  if (R) flow.refreshStage(R);
  reportFaults();
  if (w.phase === PHASE.TRIBE && !Object.values(w.bureaus).some(v => v)) {
    state.tab = 'roles';
    toast('部族になった。長を1人も置かないと、誰も報告してこない。', 'warn');
  }
  buildSpeed(); refresh();
}

// ------------------------------------------------------------------ デモ
// 「まだら → 混色」を最初から見せるための開発用セットアップ（?dev=1 のときだけ）。
//
// **ここも進行層越しに走らせる**（R-950 / C-13）。前は sim を直に叩いていたので、
// 10国が1世代も進まないまま「国の強さ7」で横並びになり、15対2の初戦が出ていた（#10）。
function demoSetup() {
  const R = state.run, w = state.world;

  const cast = () => {
    if (w.phase !== PHASE.VILLAGE) return;
    const list = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
    list.forEach((p, i) => {
      p.role = (i % 5 < 3) ? ROLE.FARM : (i % 5 === 3 ? ROLE.HUNT : ROLE.DRILL);
    });
  };
  // 進行層は「進めてよい局面か」を自分で判断する。村がいっぱいなら1世代も進まない。
  const runGens = (n) => {
    for (let g = 0; g < n; g++) {
      cast();
      if (!flow.canAdvanceGeneration(R)) break;
      flow.advanceGeneration(R);
    }
  };
  // S0〜S9 を人手の代わりに撃つ。順番は進行層が持っているので、ここでは並べるだけ。
  const fightAndAccept = (target, axis) => {
    if (!target) return false;
    const b = war.beginWar(R, target);
    if (!b) return false;
    let guard = 0;
    while (!b.over && guard++ < 400) war.stepWar(R, b);
    war.settle(R, b, { priceIndex: 0 });
    const opt = war.captiveOptions(R, b);
    war.drawCaptives(R, b, opt.winner ? axis : null);
    for (const c of war.borderQueue(R)) war.borderDecide(R, c.id, 'accept');
    war.finishWar(R, b);
    flow.refreshStage(R);
    return true;
  };

  runGens(12);                       // 村がいっぱいになるまで（着いた時点で止まる）
  fightAndAccept(war.listTargets(R)[0], '武');   // 初戦＝隣村ゴースト

  runGens(3);                        // ここで部族に上がる（既定カード5枚は進行層が立てる）
  // 長は**部族に上がってから、生きている個体で**選ぶ（先に選ぶと3世代のあいだに死ぬ）
  const cands = [...w.people.values()].filter(p => p.role !== ROLE.CHILD)
    .sort((a, b) => (api.powerOf ? api.powerOf(b) - api.powerOf(a) : 0));
  ['military', 'agri', 'civil'].forEach((k, i) => { if (cands[i]) api.appointBureau(w, k, cands[i].id); });

  // 2戦目は条件（人口16・不応期2世代）を満たしたときだけ。血の色がいちばん遠い相手を選ぶ。
  runGens(4);
  if (war.warReason(R).ok) {
    const home = 0;                  // 自国の表示色は常に 0度（赤）
    const far = [...war.listTargets(R)]
      .sort((a, b) => hueDist(api.targetHue(b), home) - hueDist(api.targetHue(a), home))[0];
    fightAndAccept(far, '武');
  }
  api.setCard(w, 'mix_policy', true, 100);
  runGens(4);

  w.food += 60;
  // 溜まった知らせ（上限・部族）はデモの中で消化済み。本編の最初の世代で
  // まとめて出てこないように捨てる。
  flow.takeNotices(R);
  reportFaults();
  toast('デモ：外来の血が入った状態から始める。', 'warn');
}

// 無役の数（P1）／空席の局の数（P2）。タブのバッジで気づかせる。
function idleCount() {
  const w = state.world;
  if (!w) return 0;
  if (w.phase !== PHASE.VILLAGE) return Object.values(w.bureaus).filter(v => v == null).length;
  return [...w.people.values()].filter(p => p.role === ROLE.IDLE).length;
}

// 色相の円環上の距離
function hueDist(a, b) { const d = Math.abs((((a - b) % 360) + 360) % 360); return Math.min(d, 360 - d); }

// 開発用フック
window.増殖 = { state, api, ctx, flow, war, clock, get run() { return state.run; } };
