// 起動。十匹を置いて、時計を回して、押されたものに応える。
//
// 確定事項より：
//   A-10  創世は十匹＋最初の10年は配給。十匹のうち3人が2ヶ月ずらして妊娠済み
//         常に動いているもの3つ：細胞が増える／蔵が満ちる／季節が変わる
//         チュートリアルは出来事ごとに、初めて起きたときに1つだけ出す
//   A-11  1倍＝1日1分。本番の上限60倍。**500倍は ?dev=1 のときだけ**
//   A-7   オーナーは全部見える。数値ではっきりと
//
// 掟：**壁時計を触るのはこの頁だけ。**世界は tick の整数しか見ない。
//     rAF は絵を描くためだけに使う（旧版は戦闘だけ rAF で、裏タブで止まった）。
//     世界を進めるのは setInterval のほう。
//     **UI は world を直接呼ばない。**読むのは flow/run.js が返す形だけ。

import { Run, HOUSES_PER_VILLAGE, RATION_YEARS } from '../flow/run.js';
import { MapView } from './map.js';
import { Portrait, portraitLegend } from './portrait.js';

// ---- 立ち上げ --------------------------------------------------------------
const q = new URLSearchParams(location.search);
const DEV = q.get('dev') === '1';
const SEED = (parseInt(q.get('seed') || '', 10) || 20260821) >>> 0;

const $ = id => document.getElementById(id);
const fix = (v, n = 0) => (Number.isFinite(v) ? v : 0).toFixed(n);

const run = new Run({ seed: SEED, dev: DEV });
const map = new MapView($('map'), run, $('actors'), $('labels'));
map.onSelect = hit => {
  if (!hit) { run.select(-1); run.selectHouse(-1); }
  else if (hit.kind === 'person') run.select(hit.id);
  else run.selectHouse(hit.id);
  drawDetail();
  map.dirty = true;
};

if (DEV) {
  document.body.classList.add('dev');
  // 開発用の覗き穴。**?dev=1 のときだけ。**本番の頁には生えない（A-11）
  globalThis.zoushoku = { run, map };
}
$('seedlabel').textContent = `種 ${SEED}`;

// ---- 上帯 ------------------------------------------------------------------
function buildSpeeds() {
  const box = $('speeds');
  box.innerHTML = '';
  for (const s of run.speedChoices()) {
    const b = document.createElement('button');
    b.className = 'sp' + (s > 60 ? ' debug' : '');
    b.dataset.speed = String(s);
    b.textContent = `×${s}`;
    b.title = s > 60 ? 'デバッグ専用。本番には出さない（A-11）' : `1ヶ月 ${fix(30 * 60 / s, 0)}秒`;
    b.onclick = () => { run.setSpeed(s); if (!run.playing) run.play(); };
    box.appendChild(b);
  }
}
function markSpeeds() {
  for (const b of $('speeds').children) b.classList.toggle('on', Number(b.dataset.speed) === run.speed);
  $('playbtn').textContent = run.playing ? '⏸' : '▶';
  $('playbtn').classList.toggle('on', run.playing);
}

let lastBarTick = -1;
function drawBar(force = false) {
  const v = run.view();
  if (!force && v.tick === lastBarTick) return;
  lastBarTick = v.tick;

  $('date').textContent = v.dateText;
  const se = $('season');
  se.textContent = v.seasonName;
  se.className = 'pill s' + v.season;

  $('pop').textContent = String(v.pop);
  $('popsub').textContent = `大人${v.adults}・子${v.children}`;
  $('houses').textContent = `${v.houses} / ${HOUSES_PER_VILLAGE}`;
  $('housesub').textContent = v.houses >= HOUSES_PER_VILLAGE ? '満（溢れている）' : `空き${HOUSES_PER_VILLAGE - v.houses}`;
  $('food').textContent = fix(v.food, 1);
  $('foodsub').textContent = `産${fix(v.produced, 1)} ／ 食${fix(v.eaten, 1)}`;
  $('foodbar').style.width = `${Math.max(0, Math.min(100, v.foodCap ? v.food / v.foodCap * 100 : 0))}%`;
  $('foodbar').classList.toggle('low', v.food < v.eaten);

  $('ration').hidden = !v.ration;
  if (v.ration) $('ration').textContent = `配給　あと${v.rationLeftYears}年　この十匹はまだ飢えない`;
  $('extinct').hidden = !v.extinct;

  $('tickno').textContent = `${v.tick} tick`;
  if (DEV) drawDev();
}

// ---- 個体票・家票（A-7：全部見える） ---------------------------------------
function bar(value, max, cls = '') {
  const w = Math.max(0, Math.min(100, value / max * 100));
  return `<span class="b ${cls}"><i style="width:${w.toFixed(1)}%"></i></span>`;
}
function esc(t) {
  return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * ステ1行。**まとめが大きく、内訳が小さく、内訳の左端が才能**（オーナー確定）。
 *
 *   最大筋力      57   才能10 ＋努力50 ×0.95   ▓▓▓▓░░
 *
 * まとめの数字だけに色が付く（オーナー確定）：
 *   赤＝伸びやすい ／ 青＝伸びにくい ／ 灰＝いまは伸びていない
 * 総合＝「いまの仕事がこのステを使う重み × 住んでいる場所の補正」。flow/run.js が出す。
 *
 * **色はここ（個体票のDOM）から一歩も出さない。**盤面に載る色は血統の色相だけ（A-5）。
 */
function statRow(s) {
  // 表示は整数（めもりは0〜100の整数。小数を読ませない）。
  // 内訳が必ず足し算として成立するように、努力は「素の合計 − 才能」で出す
  const tal = Math.round(s.talent);
  const ev = Math.round(s.talent + s.ev) - tal;
  const raw = tal + ev;
  const sum = Math.round(raw * s.debuff);
  const hasDebuff = Math.abs(s.debuff - 1) > 0.005;

  // 内訳は、割るものがあるときだけ出す。
  // 才能そのものが答えの行（104本の大半）で、同じ数字を2度読ませない
  let brk = '';
  if (ev !== 0 || hasDebuff) {
    brk = `<i>才能</i>${tal}`;
    if (ev !== 0) brk += ` <i>＋努力</i>${ev}`;
    if (hasDebuff) brk += ` <i>×</i>${fix(s.debuff, 2)}`;
  }

  return `<tr title="${esc(s.why)}">
    <td class="nm">${s.name}</td>
    <td class="sum g-${s.growth}">${sum}</td>
    <td class="brk">${brk}</td>
    <td class="bar">${bar(s.eff, 140)}</td>
  </tr>`;
}
const STAT_HEAD = '<tr class="hd"><td>ステ</td><td class="sum">実効</td><td>内訳</td><td></td></tr>';

// 肖像は WebGL の面を1枚使う。**個体票を作り直す前に必ず返す**（portrait.js の約束）
let portrait = null;
function dropPortrait() {
  if (portrait) { portrait.dispose(); portrait = null; }
}

function drawDetail() {
  const box = $('detail');
  dropPortrait();
  if (run.selectedHouse >= 0) {
    const h = run.house(run.selectedHouse);
    if (!h) { box.innerHTML = empty(); return; }
    box.innerHTML = `
      <h2>${h.h}の家<small>${h.gen}代目・${h.size}人</small></h2>
      <div class="kv"><span>建った</span><b>${h.foundedText}</b></div>
      <div class="kv"><span>枠</span><b>住居の ${h.slot + 1} 番</b></div>
      <table class="fam">
        ${h.members.map(m => `<tr data-i="${m.i}"><td>${m.head ? '△ ' : ''}${m.i}番</td><td>${m.age}歳${m.sexName}</td><td>${m.jobName}</td></tr>`).join('')}
      </table>
      <p class="hint">箱1つ＝1家系。行をクリックすると、その一体が見える</p>`;
    for (const tr of box.querySelectorAll('.fam tr')) {
      tr.onclick = () => { run.select(Number(tr.dataset.i)); drawDetail(); map.dirty = true; };
    }
    return;
  }

  const i = run.selected;
  if (i < 0) { box.innerHTML = empty(); return; }
  const p = run.person(i);
  if (!p) { box.innerHTML = empty(); return; }

  // 肖像は h2 の前に差し込む。**80px 未満だと模様の本数が数えられない**（portrait.js）
  const legend = portraitLegend(p);
  const fam = [];
  if (p.spouse >= 0) fam.push(link('伴侶', p.spouse));
  if (p.father >= 0) fam.push(link('父', p.father));
  if (p.mother >= 0) fam.push(link('母', p.mother));
  const kids = p.children.filter(c => c.alive);
  // 持っていないステは行ごと出さない（オーナー確定：S以上はゼロがある＝そもそも持っていない）。
  // いまは全員が104個すべてを持っているので何も消えない。遺伝が変わった日にそのまま効く
  const shownStats = p.stats.filter(s => s.has);

  box.innerHTML = `
    <div class="face">
      <div class="portslot"></div>
      <div class="facetext">
        <h2>${p.i}番<small>${p.age}歳 ${p.sexName}${p.alive ? '' : '　（死んでいる）'}</small></h2>
        <p class="looks">${legend.map(esc).join('<br>')}</p>
      </div>
    </div>
    ${p.alive ? '' : `<p class="died">${p.deathCauseName}で死んだ</p>`}
    <div class="kv"><span>いま居る</span><b>${p.atName}${p.at !== p.job ? `<span class="dim">　仕事は${p.jobName}（身重なので出ない）</span>` : ''}</b></div>
    <div class="kv"><span>家</span><b>${p.house >= 0 ? `${p.house}の家（${p.houseGen}代目・${p.houseSize}人）` : '家なし'}${p.isHead ? '　△家長' : ''}</b></div>
    <div class="kv"><span>身分</span><b>${p.rankName}　${p.whereName}育ち</b></div>
    <div class="kv"><span>血統</span><b>創世の十匹のうち ${p.lines} 家系ぶん${p.pure > 0.99 ? '（混ざっていない）' : ''}</b></div>
    <div class="kv"><span>世代</span><b>${p.generation}代目</b></div>
    <div class="kv"><span>寿命</span><b>${p.lifespan}年${p.baseLifespan !== p.lifespan ? `（素は${p.baseLifespan}年）` : ''}</b></div>
    <div class="kv"><span>からだの倍率</span><b>${fix(p.bodyDebuff, 2)}<span class="dim">　老い・古傷・状態</span></b></div>
    <div class="kv"><span>熟練</span><b>${fix(p.mastery, 1)}<span class="dim">　${p.jobName}で積んだぶん</span></b></div>
    <div class="kv"><span>状態</span><b>${p.states.length ? p.states.join('・') : '<span class="dim">なし</span>'}</b></div>
    <div class="kv"><span>家族</span><b>${fam.length ? fam.join('　') : '<span class="dim">ひとり</span>'}</b></div>
    ${p.births ? `<div class="kv"><span>産んだ数</span><b>${p.births}回</b></div>` : ''}
    ${kids.length ? `<div class="kv"><span>子</span><b>${kids.map(c => `<a href="#" data-i="${c.i}">${c.i}番</a><span class="dim">${c.age}歳</span>`).join('　')}</b></div>` : ''}

    <h3>いちばん高い8つ<small>実効値 ＝（才能＋努力値）×デバフ</small></h3>
    <table class="st">
      ${STAT_HEAD}
      ${p.top.map(statRow).join('')}
    </table>
    <p class="legend">
      <span class="g-fast">赤</span><b>＝いまの仕事と住む場所でよく伸びる</b>
      <span class="g-slow">青</span><b>＝伸びにくい</b>
      <b>／ 印の無い数字は、いまは伸びていない</b>
    </p>

    <details class="all">
      <summary>${shownStats.length}ステ全部を見る（オーナーは全部見える）</summary>
      <table class="st">
        ${STAT_HEAD}
        ${shownStats.map(statRow).join('')}
      </table>
      <p class="hint">行にカーソルを置くと、伸びる／伸びない理由が出る。<br>
        こころ29個には閾値という概念が原理的に無い（野心を鍛える職が無い）。<br>
        ${p.statsHidden
          ? `${p.statsHidden}個は<b>この一体が持っていない</b>ので出していない（レア度S以上で才能ゼロ）。`
          : '<span class="dim">いまは104個すべてを持っている。レア度が初期値に効いていないため（設計班へ申し送り済み）。</span>'}</p>
    </details>`;

  // 肖像を差す。**盤面と同じシェーダなので、同じ個体が同じ姿になる**
  const slot = box.querySelector('.portslot');   // 動的に作る節点なので $ で引かない（検査が id の実在を見ている）
  if (slot) {
    portrait = new Portrait(96);
    slot.appendChild(portrait.el);
    portrait.render(p);
  }

  for (const a of box.querySelectorAll('a[data-i]')) {
    a.onclick = e => { e.preventDefault(); run.select(Number(a.dataset.i)); drawDetail(); map.dirty = true; };
  }
}
function link(label, i) { return `${label}<a href="#" data-i="${i}">${i}番</a>`; }
function empty() {
  return `<h2 class="dim">誰も選んでいない</h2>
    <p class="hint">地図の丸をクリックすると、その一体の全部が見える。<br>
      家の箱をクリックすると、その家の顔ぶれが見える。<br><br>
      <b>大きさ</b>＝年齢。<b>暗さ</b>＝弱っている（それだけ。内訳はここに出る）。<br>
      <b>色</b>＝血。<b>下に沈んだ色</b>＝よその血。<b>沈んだ高さ</b>＝どれだけ混ざったか。<br>
      <b>形</b>と<b>模様</b>＝血統。親の中間が子に出る。<b>星・ハート</b>は稀に潜って出る。<br>
      <b>上の山形</b>＝家長。<br>
      色に意味は載せない。<b>色は血だけ</b>。<br><br>
      <span class="dim">訓練場と辺境はまだ空いている。いまは畑と森にしか人が振られない。</span></p>`;
}

// ---- 年代記（初めて起きたことだけが載る・A-10） -----------------------------
function addNotice(n) {
  const ul = $('chronlist');
  const li = document.createElement('li');
  li.innerHTML = `<b>${n.what}</b><i>${n.date}</i>${n.detail ? `<span>${n.detail}</span>` : ''}`;
  ul.insertBefore(li, ul.firstChild);
  while (ul.children.length > 60) ul.removeChild(ul.lastChild);
  toast(n.what, n.detail);
}
let toastTimer = 0;
function toast(title, detail) {
  const t = $('toast');
  t.innerHTML = `<b>${title}</b>${detail ? `<span>${detail}</span>` : ''}`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

// ---- 開発用（本番に出さない・A-11） ----------------------------------------
function drawDev() {
  const c = run.converge();
  const m = run.memory();
  $('devout').innerHTML = `
    <div class="kv"><span>ステの平均</span><b>${fix(c.meanOfStats, 1)}</b></div>
    <div class="kv"><span>ばらつき</span><b>${fix(c.sdOfStats, 1)}<span class="dim">　49前後で止まれば連鎖群が効いている</span></b></div>
    <div class="kv"><span>最良個体で80超</span><b>${c.bestAbove80} 個<span class="dim">　増え続けたら壊れている</span></b></div>
    <div class="kv"><span>血統の生き残り</span><b>${c.lineages} / 10</b></div>
    <div class="kv"><span>1人あたり</span><b>${m.bytesPerRow} B<span class="dim">　10万人で ${fix(m.mbAt100k, 1)}MB</span></b></div>
    <div class="kv"><span>行</span><b>${m.rows}（死者ぶんも残る）</b></div>`;
}

// ---- 時計 ------------------------------------------------------------------
// 世界を進めるのは setInterval。裏タブでも止まらない。
// 溜まりすぎたぶんは run 側が捨てる（オフライン進行は別の話・A-11）。
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = now - last;
  last = now;
  const n = run.pump(dt);
  if (n > 0) map.dirty = true;
}, 16);

// 絵を描くのは rAF。世界の時計には使わない
let lastDetailMonth = -1;
function frame() {
  if (map.dirty || run.snapshot().tick !== lastBarTick) {
    drawBar();
    map.draw();
    // 選んでいる者の数も動く。毎日引き直すと重いので、月が変わったときだけ
    const v = run.view();
    const m = v.year * 12 + v.month;
    if (m !== lastDetailMonth) {
      lastDetailMonth = m;
      if (run.selected >= 0 || run.selectedHouse >= 0) drawDetail();
    }
  }
  requestAnimationFrame(frame);
}

// ---- 繋ぐ ------------------------------------------------------------------
run.on('notice', addNotice);
run.on('speed', markSpeeds);

$('playbtn').onclick = () => run.toggle();
$('stepday').onclick = () => { run.stepDay(); map.dirty = true; drawDetail(); };
$('stepmonth').onclick = () => { run.stepMonth(); map.dirty = true; drawDetail(); };
$('fitbtn').onclick = () => map.fit(run.snapshot().villages.length);
if (DEV) {
  $('ff10').onclick = () => { run.fastForwardYears(10); map.dirty = true; drawDetail(); };
  $('ff100').onclick = () => { run.fastForwardYears(100); map.dirty = true; drawDetail(); };
}

addEventListener('resize', () => { map.resize(); map.fit(run.snapshot().villages.length); });
addEventListener('keydown', e => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); run.toggle(); }
  else if (e.key === '.') { run.stepDay(); map.dirty = true; }
  else if (e.key === 'f') map.fit(run.snapshot().villages.length);
  else if (e.key >= '1' && e.key <= '6') {
    const list = run.speedChoices();
    const s = list[Number(e.key) - 1];
    if (s) { run.setSpeed(s); if (!run.playing) run.play(); }
  }
});

buildSpeeds();
map.resize();
map.fit(run.snapshot().villages.length);
drawBar(true);
drawDetail();
markSpeeds();
for (const n of run.notices) addNotice(n);
requestAnimationFrame(frame);

// 十匹を置いた直後は止まっている。「置く」から始まる（A-10 の0〜1分）
toast('創世の十匹', `最初の${RATION_YEARS}年は配給がある。▶ を押すと時が動く`);
