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

import { Run, HOUSES_PER_VILLAGE, RATION_YEARS, MAX_FOLK} from '../flow/run.js';
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

// **既定の速さ。**×1 は1日＝1分なので、▶を押しても1分間なにも起きない。
// 初見が「壊れている」と読む原因がこれだった。世界の側は何も変えず、選ぶだけ。
run.setSpeed(10);   // 起動は最速（1ヶ月＝1分）

// ---- 上帯 ------------------------------------------------------------------
function buildSpeeds() {
  const box = $('speeds');
  box.innerHTML = '';
  for (const s of run.speedChoices()) {
    const b = document.createElement('button');
    b.className = 'sp' + (s > 60 ? ' debug' : '');
    b.dataset.speed = String(s);
    b.textContent = `×${s}`;
    // ★ 2026-08-31：**破棄済み A-11 の式 `30*60/s` で計算し直していたので表示が実際の3倍**
    //   だった（×10 でエンジンは60秒/月なのに「1ヶ月3分」と出る）。run が実値を持っている
    b.title = s > 60 ? 'デバッグ専用。本番には出さない（A-11）' : `1ヶ月 ${fix(run.secondsPerMonthAt(s), 0)}秒`;
    b.onclick = () => { run.setSpeed(s); if (!run.playing) run.play(); };
    box.appendChild(b);
  }
}
function markSpeeds() {
  for (const b of $('speeds').children) b.classList.toggle('on', Number(b.dataset.speed) === run.speed);
  // **いまの速さが何を意味するかを、常に出す。**「×15」だけでは誰にも分からない
  const secPerMonth = run.status().secondsPerMonth;   // ★ 実値を読む（旧：破棄済み A-11 の式）
  $('speedhint').textContent = secPerMonth >= 60
    ? `1ヶ月 ${(secPerMonth / 60).toFixed(0)}分`
    : `1ヶ月 ${secPerMonth.toFixed(0)}秒`;
  $('playbtn').textContent = run.playing ? '⏸' : '▶';
  $('playbtn').classList.toggle('on', run.playing);
}

// ---- 方針カード（#18 §1）------------------------------------------------
// ★ 2026-08-31：**オーナーがつまみを動かす手段が無かった。**
//   `cards.set()` を呼ぶのは検査の1行だけで、11枚が全部 既定のまま眠っていた。
//   ここは「意味はプリセット、量は数値」（正典6-2）どおり、段と実数の両方を出す。
const ROT_NAMES = ['連作', '二圃', '三圃', '四圃'];
function drawCards() {
  const box = $('cardlist');
  if (!box) return;
  const cards = run.nationCards();
  box.innerHTML = cards.map((c) => {
    const label = c.key === '輪作' ? ROT_NAMES[Math.round(c.value)] ?? String(c.value)
      : (c.onOff ? (c.step >= 1 ? 'オン' : 'オフ') : fixCard(c.value));
    return `<div class="card" data-key="${c.key}">
      <div class="ck">${c.key}<small>${c.bureau}</small></div>
      <div class="cv"><button class="ghost cm">−</button>
        <b>${c.step > 0 ? '+' : ''}${c.step}</b>
        <button class="ghost cp">＋</button>
        <u>${label}</u></div>
      <div class="cn">${c.note}</div>
    </div>`;
  }).join('');
  for (const el of box.querySelectorAll('.card')) {
    const key = el.dataset.key;
    el.querySelector('.cm').onclick = () => { run.stepCard(key, -1); drawCards(); drawBar(true); };
    el.querySelector('.cp').onclick = () => { run.stepCard(key, +1); drawCards(); drawBar(true); };
  }
}
const fixCard = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

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
  // ★ 2026-08-31：**分母に定数30 を使っていた**ので「家 1122 / 30」「満（溢れている）」と
  //   出ていた。run が世界の枠（30 × 村数）を `slots` で持っている
  $('houses').textContent = `${v.houses} / ${v.slots}`;
  $('housesub').textContent = v.houses >= v.slots ? '満（溢れている）' : `空き${v.slots - v.houses}`;
  $('food').textContent = fix(v.food, 1);
  $('foodsub').textContent = `産${fix(v.produced, 1)} ／ 食${fix(v.eaten, 1)}`;
  $('foodbar').style.width = `${Math.max(0, Math.min(100, v.foodCap ? v.food / v.foodCap * 100 : 0))}%`;
  $('foodbar').classList.toggle('low', v.food < v.eaten);

  $('ration').hidden = !v.ration;
  if (v.ration) $('ration').textContent = `配給　あと${v.rationLeftYears}年　この十匹はまだ飢えない`;
  $('extinct').hidden = !v.extinct;

  // **「動いている」の唯一の合図。**日付は ×60 でも1秒に1回しか変わらず、
  // ×1 だと1分に1回。押しても何も起きないように見えるのを、この線が塞ぐ
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
/**
 * 授かりもの（S以上）。**104ステとは別枠。**持っているか、いないかだけ。
 * だから棒グラフにしない。**札（バッジ）で出す。**
 *
 * 2段ある。意味がまるで違うので、見た目もはっきり分ける。
 *   発現 … いま効いている。本人にも周りにも結果が出ている
 *   保因 … 出ていないが子に渡りうる。**オーナーだけに見える**（A-7）
 *
 * 保因こそがオーナーの持ち札。A-21b「その無駄を拾い上げることだけが、オーナーにできること」。
 */
function giftBlock(p) {
  const has = p.gifts && p.gifts.length;
  const carried = p.giftsCarried && p.giftsCarried.length;
  if (!has && !carried) return '';

  const shown = has ? p.gifts.map(g => `
    <div class="gift">
      <span class="tier t${g.tier}">${g.tier}</span>
      <b>${esc(g.name)}</b>
      <span class="ge">${esc(g.text)}</span>
      ${g.active ? '' : '<span class="pending">この効果はまだ世界に入っていない</span>'}
    </div>`).join('') : '';

  const hidden = carried ? `
    <div class="carried">
      <span class="only">あなただけに見える</span>
      ${p.giftsCarried.map(g => `<span class="chip"><i>${g.tier}</i>${esc(g.name)}</span>`).join('')}
      <span class="ge">出ていない。だが子に渡ることがある</span>
    </div>` : '';

  return `<div class="gifts">${shown}${hidden}</div>`;
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
    if (!h) { showEmpty(box); return; }
    box.innerHTML = `
      <h2>${h.h}の家<small>${h.gen}代目・${h.size}人</small></h2>
      <div class="kv"><span>建った</span><b>${h.foundedText}</b></div>
      <div class="kv"><span>枠</span><b>住居の ${h.slot + 1} 番</b></div>
      <table class="fam">
        ${h.members.map(m => `<tr data-i="${m.i}"><td>${m.head ? '△ ' : ''}${m.i}番</td><td>${m.age}歳${m.sexName}</td><td>${m.jobName}</td></tr>`).join('')}
      </table>
      <p class="hint">箱1つ＝1家系。行をクリックすると、その一体が見える</p>`;
    for (const tr of box.querySelectorAll('.fam tr')) {
      tr.onclick = () => { run.select(Number(tr.dataset.i)); drawDetail(); drawChronicle(); drawVerbs(); map.dirty = true; };
    }
    return;
  }

  const i = run.selected;
  if (i < 0) { showEmpty(box); return; }
  const p = run.person(i);
  if (!p) { showEmpty(box); return; }

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
    ${giftBlock(p)}
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
    a.onclick = e => { e.preventDefault(); run.select(Number(a.dataset.i)); drawDetail(); drawChronicle(); drawVerbs(); map.dirty = true; };
  }
}
function link(label, i) { return `${label}<a href="#" data-i="${i}">${i}番</a>`; }
/**
 * 何も選んでいないときの右パネル。
 *
 * **ここに記号の説明を並べない。**初見は読まないし、読ませるための画面でもない。
 * 誰も選んでいないときに知りたいのは「いま村に誰がいるか」なので、名簿を出す。
 * 記号の読み方は畳んでおく。**要るときに開く。**
 */
/** 名簿を出して、行を個体票につなぐ。地図の丸と同じ入口 */
function showEmpty(box) {
  box.innerHTML = empty();
  for (const tr of box.querySelectorAll('.roster tr[data-i]')) {
    tr.onclick = () => { run.select(Number(tr.dataset.i)); drawDetail(); drawChronicle(); drawVerbs(); map.dirty = true; };
  }
}

function empty() {
  const snap = run.snapshot();
  const folk = snap.folk.slice().sort((a, b) => b.age - a.age);
  const b = snap.bar;
  // ★ 2026-08-31（別セッションの精査で発見）：人口が MAX_FOLK を超えると
  //   `folk` が空になる（正典 A-19「人が多すぎたら箱だけにする」の設計どおり）が、
  //   **名簿が「3,811人」と「誰もいない」を並べていた**。理由を出す
  if (snap.tooMany) {
    return `<div class="note">人が多すぎるので、ひとりずつは出していません（${b.pop}人）。`
      + `<br>正典 A-19：**${MAX_FOLK}人を超えたら箱だけにする**。村を絞るか、地図の箱を押してください。</div>`;
  }

  const rows = folk.map(f => {
    const mark = [];
    if (f.pregnant) mark.push('身重');
    if (f.hungry) mark.push('飢え');
    if (f.sick) mark.push('病');
    if (f.newborn) mark.push('生まれたて');
    return `<tr data-i="${f.i}">
      <td class="ag">${f.age}</td>
      <td class="sx">${f.sex === 1 ? '女' : '男'}</td>
      <td class="jb">${f.jobName}</td>
      <td class="mk">${mark.join('・')}</td>
    </tr>`;
  }).join('');

  return `<h2>村の者<small>${b.pop}人${b.pregnant ? `　身重 ${b.pregnant}` : ''}${b.hungry ? `　飢え ${b.hungry}` : ''}</small></h2>
    <table class="roster">
      <tr class="hd"><td>歳</td><td></td><td>いる場所</td><td></td></tr>
      ${rows || '<tr><td colspan="4" class="dim">誰もいない</td></tr>'}
    </table>
    <p class="hint">行をクリックすると、その一体の全部が見える。地図の丸でも同じ。</p>

    <details class="all">
      <summary>絵の読み方</summary>
      <p class="hint">
        <b>大きさ</b>＝年齢。<b>暗さ</b>＝弱っている。<b>中の粒</b>＝熟練。<br>
        <b>色</b>＝血。<b>下に沈んだ色</b>＝よその血。<b>沈んだ高さ</b>＝どれだけ混ざったか。<br>
        <b>形</b>と<b>模様</b>＝血統。親の中間が子に出る。<b>星・ハート</b>は稀に潜って出る。<br>
        <b>上の山形</b>＝家長。<br>
        <b>色に意味は無い。色は血だけ。</b>
      </p>
    </details>`;
}

// ---- 年代記（初めて起きたことだけが載る・A-10） -----------------------------
// ---- 年代記（正典3-9）。★ 5段。選んでいるものに応じて中身が変わる -------
// > **世界に1本の年代記を作らない。ひとつずつが自分の分を持つ。**
// > **クリックしてパネルで開く。**個体を押せばその人の一生、村を押せばその村の歴史。
// ★ **真の原因と、公表された帰属を、別の欄として持つ。これが要点。**
//   帰属が「未公表」の行は、押すと**真の原因の鎖**が出る（システムだけが知っている列）
// ---- 動詞「決める」（正典3-1・#14）----------------------------------------
// > **既定＝実行。**役職者が予定を立て、猶予を過ぎたら勝手に実行される。
// > オーナーは**猶予のあいだだけ止められる。**
function drawDecide() {
  const box = $('decide');
  if (!box) return;
  const ds = run.decisions(8);
  box.innerHTML = ds.length ? ds.map((d) =>
    `<div class="drow" data-id="${d.id}">`
    + `<b>${d.levelName}</b>${d.whoName}<i>${d.village === 0xFFFF || d.village < 0 ? '国' : '村' + d.village}</i><u>あと${d.daysLeft}日</u>`
    + `<button class="ghost db" data-h="block">止める</button>`
    + `<button class="ghost db" data-h="pass">通す</button></div>`).join('')
    : '<div class="dim">いま猶予のあいだの予定は無い（既定＝実行）</div>';
  for (const el of box.querySelectorAll('.db')) {
    el.onclick = () => {
      const id = Number(el.closest('.drow').dataset.id);
      run.decide(id, el.dataset.h);
      toast('決めた', el.dataset.h === 'block' ? '止めた' : '通した');
      drawDecide(); redrawPanels();
    };
  }
}

// ---- 国の段と国力（正典1-5・4-3・1-1c）------------------------------------
// ★ 正典1-5「**転換は「解禁」ではなく「喪失」として起こす。獲得ではなく剥奪として体験させる**」
//   ので、**得たものの一覧は作らない。失ったものだけを出す。**
function drawNation() {
  const box = $('nation');
  if (!box) return;
  const n = run.nation();
  const lost = n.lost.length
    ? `<div class="nlost"><b>失ったもの</b>${n.nlostSep ?? ''}<ul>${n.lost.map((x) => `<li>${x}</li>`).join('')}</ul></div>`
    : '<div class="dim">まだ何も失っていない</div>';
  const me = n.ranking.find((r) => r.id === 'me');
  const rank = n.ranking.map((r) =>
    `<div class="nr${r.id === 'me' ? ' me' : ''}"><b>${r.rank}</b>${r.name}<u>${r.power.toFixed(1)}</u></div>`).join('');
  box.innerHTML =
    `<div class="nhead">段 <b>${n.phaseName}</b>　国力 <b>${n.power.toFixed(1)}</b>　順位 <b>${me.rank}/${n.ranking.length}</b></div>`
    + lost
    + `<div class="nsub">配役 ${n.canPlace ? '撃てる' : '<span class="bad">もう手では置けない</span>'}`
    + `　／　向ける ${n.canAim ? `撃てる（候補${n.foes.length}件）` : '候補が無い'}</div>`
    + `<div class="nrank"><b>国力ランキング</b>（全プレイヤー間の順位）${rank}</div>`;
}

// ---- 動詞「置く」（正典4090-4105）。★ オーナーの専権 ----------------------
function drawVerbs() {
  const box = $('verbs');
  if (!box) return;
  const opts = run.placeOptions();
  if (!opts.length) { box.innerHTML = '<div class="dim">個体を選ぶと「置く」が撃てる</div>'; return; }
  box.innerHTML = opts.map((o) =>
    `<button class="vb${o.why ? ' off' : ''}" data-k="${o.key}" title="${o.why || ''}">${o.label}</button>`).join('');
  for (const el of box.querySelectorAll('.vb')) {
    el.onclick = () => {
      const r = run.place(el.dataset.k);
      toast(r.ok ? '置いた' : '撃てない', r.ok ? '年代記に載った' : (r.why || ''));
      drawVerbs(); drawDetail(); drawChronicle(); map.dirty = true;
    };
  }
}

// ★ 右の面をまとめて描き直す。**どれか1つが落ちても他が死なない**ようにする
//   （起動時に1つ throw すると、その後ろの面が丸ごと出なくなる）
function redrawPanels() {
  for (const f of [drawChronicle, drawVerbs, drawNation, drawDecide]) {
    try { f(); } catch (e) { console.error('面の描画で落ちた:', f.name, e); }
  }
}

let openCause = -1;
function drawChronicle() {
  const box = $('chronreal');
  if (!box) return;
  const { scope, rows } = run.chronicle(40);
  const head = `<div class="cscope">${scope}<small>${rows.length}件</small></div>`;
  box.innerHTML = head + (rows.length ? rows.map((r) => {
    const where = r.village >= 0 ? `村${r.village}` : '国';
    const told = r.told === 0 ? '' : `<u class="${r.exposed ? 'bad' : ''}">「${r.toldName}」${r.exposed ? '・暴かれた' : ''}</u>`;
    const chain = (openCause === r.id && r.cause >= 0)
      ? `<div class="cchain">${run.traceCause(r.id).slice(1).map((p) =>
          `↑ ${p.year}年${p.month}月　${p.kindName}（${p.village >= 0 ? '村' + p.village : '国'}）`).join('<br>')}</div>`
      : '';
    return `<div class="crow${r.cause >= 0 ? ' has' : ''}" data-id="${r.id}">`
      + `<b>${r.year}年${r.month}月</b> ${r.kindName}<i>${where}</i>${told}`
      + (r.cause >= 0 ? '<span class="ctrace">因</span>' : '') + chain + '</div>';
  }).join('') : '<div class="dim">まだ何も起きていない</div>');
  for (const el of box.querySelectorAll('.crow.has')) {
    el.onclick = () => { const id = Number(el.dataset.id); openCause = openCause === id ? -1 : id; drawChronicle(); };
  }
}

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
// ★ 2026-08-31：`＋1日`／`＋1ヶ月`／`10年`／`100年` が drawBar() を呼んでおらず、
//   押しても上帯（日付・人口・蔵）が変わらなかった。強制描画を足した
// 溜まりすぎたぶんは run 側が捨てる（オフライン進行は別の話・A-11）。
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = now - last;
  last = now;
  // ★ 裏タブでは setInterval が約1秒に間引かれるので、上限を上げて実時間を捨てない
  //   （見えているときは 250ms のままでフレームの飛びを吸収する）
  const n = run.pump(dt, document.hidden ? 5000 : undefined);
  if (n > 0) map.dirty = true;
}, 16);

// 絵を描くのは rAF。世界の時計には使わない
let lastDetailMonth = -1;
// 月の進み具合。**「動いている」の唯一の合図。**
// 日付は ×60 でも1秒に1回、×1 だと1分に1回しか変わらない。
// ▶を押しても何も起きないように見えるのを、この線が塞ぐ。だから毎フレーム動かす。
function drawDayBar() {
  const v = run.view();
  const within = run.playing ? Math.min(1, run.acc / run.msPerTick()) : 0;
  const w = (v.day - 1 + within) / 30 * 100;
  $('daybar').firstElementChild.style.width = `${Math.max(0, Math.min(100, w)).toFixed(2)}%`;
}

function frame() {
  drawDayBar();
  if (map.dirty || run.snapshot().tick !== lastBarTick) {
    drawBar();
    map.draw();
    // 選んでいる者の数も動く。毎日引き直すと重いので、月が変わったときだけ
    const v = run.view();
    const m = v.year * 12 + v.month;
    if (m !== lastDetailMonth) {
      lastDetailMonth = m;
      if (run.selected >= 0 || run.selectedHouse >= 0) drawDetail();
      redrawPanels();    // ★ 年代記（3-9）・動詞「置く」（4090）・国の段と国力（1-5/4-3）。月が変わったときだけ引き直す
    }
  }
  requestAnimationFrame(frame);
}

// ---- 繋ぐ ------------------------------------------------------------------
run.on('notice', addNotice);
run.on('speed', markSpeeds);

$('playbtn').onclick = () => run.toggle();
$('stepday').onclick = () => { run.stepDay(); map.dirty = true; drawBar(true); drawDetail(); redrawPanels(); };
$('stepmonth').onclick = () => { run.stepMonth(); map.dirty = true; drawBar(true); drawDetail(); redrawPanels(); };
$('fitbtn').onclick = () => map.fit(run.snapshot().villages.length);
if (DEV) {
  $('ff10').onclick = () => { run.fastForwardYears(10); map.dirty = true; drawBar(true); drawDetail(); redrawPanels(); };
  $('ff100').onclick = () => { run.fastForwardYears(100); map.dirty = true; drawBar(true); drawDetail(); redrawPanels(); };
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
drawCards();   // ★ 方針カード（#18 §1）を最初に描く
redrawPanels();   // ★ 年代記（3-9）・動詞「置く」（4090）・国の段と国力（1-5/4-3）
drawChronicle();   // ★ 年代記（正典3-9）
drawDetail();
markSpeeds();
for (const n of run.notices) addNotice(n);
requestAnimationFrame(frame);

// 十匹を置いた直後は止まっている。「置く」から始まる（A-10 の0〜1分）
toast('創世の十匹', `最初の${RATION_YEARS}年は配給がある。▶ を押すと時が動く`);
