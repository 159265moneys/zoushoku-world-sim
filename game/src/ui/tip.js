// ホバー説明。**要素ごとの配線はしない。** document に委譲リスナを1本だけ張る。
//
// 【なぜ title 属性ではいけないか】
//   1. 出るまで約1秒。33本のバーを見比べる作業に 1秒×33 は乗らない
//   2. 見た目を変えられない。3行（一言・高いと・低いと）を段組みできない
//   3. 長文が途中で切られるブラウザがある
//   4. いまの値（`この子 77`）を差し込めない
//
// 【ふるまい】
//   開く   … mouseover して 120ms（title の約1/8）
//   閉じる … 離れて 80ms（バーとバーの間を横切っても消えない）
//   固定   … クリックでピン留め。3行を読む途中でマウスが外れて消えるのは事故なので入れる
//   解除   … もう一度クリック / 外側をクリック / Esc
//   ボタンの内側ではピンしない（ボタン本来の動作を奪わない）

import { term, unitHint, isDead } from './glossary.js';

const OPEN_MS = 120;
const CLOSE_MS = 80;
const W = 300;

let card = null;        // ツールチップの箱（1つだけ作って使い回す）
let openTimer = 0;
let closeTimer = 0;
let current = null;     // いま開いている対象の要素
let pinned = null;      // ピン留めしている対象の要素
let installed = false;
let dev = false;

/** el() に流せる属性。`el('div', T('勤勉'), ...)` の形で使う。 */
export function T(key) {
  return key ? { 'data-term': key } : {};
}

/** 起動時に1回だけ呼ぶ */
export function installTips({ dev: isDev = false } = {}) {
  if (installed) return;
  installed = true;
  dev = !!isDev;

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', onOver, true);
  document.addEventListener('focusout', onOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pinned = null; hide(true); } });
  // 何かがスクロールしたら、ずれた吹き出しは畳む。ピン中は追従できないので同じ。
  window.addEventListener('scroll', () => { if (!pinned) hide(true); }, true);
  window.addEventListener('resize', () => { pinned = null; hide(true); });
}

function host(e) {
  const t = e.target;
  return t && t.closest ? t.closest('[data-term]') : null;
}

function onOver(e) {
  const h = host(e);
  if (!h) return;
  if (pinned) return;                 // 読んでいる途中で中身が変わらないようにする
  clearTimeout(closeTimer);
  if (current === h) return;
  clearTimeout(openTimer);
  openTimer = setTimeout(() => show(h), OPEN_MS);
}

function onOut(e) {
  const h = host(e);
  if (!h) return;
  if (pinned) return;
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => hide(), CLOSE_MS);
}

function onClick(e) {
  const h = host(e);
  if (!h) {
    if (pinned) { pinned = null; hide(true); }
    return;
  }
  // ボタンの内側ではピンしない。押した結果が出るのを邪魔しない。
  if (e.target.closest('button, input, a, .sw, .seg')) return;
  if (pinned === h) { pinned = null; hide(true); return; }
  pinned = h;
  show(h);
}

function ensureCard() {
  if (card) return card;
  card = document.createElement('div');
  card.className = 'tipcard';
  card.hidden = true;
  // 吹き出しの上でマウスを動かしても消えないようにする（ピン中に読めるため）
  card.addEventListener('mouseover', () => clearTimeout(closeTimer));
  card.addEventListener('mouseout', () => { if (!pinned) closeTimer = setTimeout(() => hide(), CLOSE_MS); });
  document.body.appendChild(card);
  return card;
}

function row(k, v) {
  if (!v) return '';
  return `<div class="tr"><b>${k}</b><span>${esc(v)}</span></div>`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function show(h) {
  const key = h.getAttribute('data-term');
  const t = term(key);
  const c = ensureCard();
  if (!t) {
    // 辞書に無い語。本番では黙って何も出さない（画面を落とさない）。
    if (!dev) { hide(true); return; }
    c.innerHTML = `<div class="hd"><b>${esc(key)}</b><i>辞書に無い</i></div>`
      + `<p class="one">この語は glossary.js に載っていない。載せるまで説明が出ない。</p>`;
  } else {
    const val = h.getAttribute('data-term-value');
    const hint = unitHint(key);
    c.innerHTML =
      `<div class="hd"><b>${esc(t.label)}</b>${hint ? `<i>${esc(hint)}</i>` : ''}</div>`
      + (t.one ? `<p class="one">${esc(t.one)}</p>` : '')
      + (isDead(key) ? `<p class="dead">いまの版では、この数字は何にもつながっていない。</p>` : '')
      + ((t.high || t.low) ? '<div class="sep"></div>' : '')
      + row('高い', t.high)
      + row('低い', t.low)
      + (t.range ? row('はば', t.range) : '')
      + (t.note ? `<p class="note">${esc(t.note)}</p>` : '')
      + (val != null ? `<div class="sep"></div><div class="tr now"><b>この子</b><span>${esc(val)}</span></div>` : '')
      + (dev ? `<div class="devkey">内部名: ${esc(key)}</div>` : '');
  }
  c.classList.toggle('pinned', pinned === h);
  c.hidden = false;
  current = h;
  place(h, c);
}

function place(h, c) {
  const r = h.getBoundingClientRect();
  c.style.width = W + 'px';
  c.style.left = '0px';
  c.style.top = '0px';
  const hh = c.offsetHeight;
  const gap = 10;

  // 右に出す。右端に入らなければ左へ反転する。
  let x = r.right + gap;
  if (x + W > window.innerWidth - 8) x = r.left - gap - W;
  if (x < 8) x = 8;

  // 上下は対象の上端に合わせる。下にはみ出したら上へ寄せる。
  let y = r.top - 4;
  if (y + hh > window.innerHeight - 8) y = window.innerHeight - 8 - hh;
  if (y < 8) y = 8;

  c.style.left = Math.round(x) + 'px';
  c.style.top = Math.round(y) + 'px';
}

function hide(now = false) {
  if (pinned && !now) return;
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  current = null;
  if (card) { card.hidden = true; card.classList.remove('pinned'); }
}

/** 画面を組み直す前に呼ぶ。消えたノードを指したまま吹き出しが残らないようにする。 */
export function resetTips() {
  pinned = null;
  hide(true);
}
