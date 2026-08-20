// 小さなDOMヘルパ。フレームワークは使わない。
//
// 【bar() / tile() / stat() の第1引数は「内部名」】
//   表示名は辞書（glossary.js）が引く。呼ぶ側は説明を1文字も書かない。
//   こうしておくと **辞書に載っていない語は原理的に画面に出せない** ので、
//   説明の抜けが検出できる（?dev=1 の赤バッジ ＋ game/test/glossary.js）。
//   1つずつ手で説明を書いて回る方式は必ず漏れるので、やらない。

import { term, label as termLabel, unitHint } from './glossary.js';

/**
 * 開発用UIを出すか。**既定は出さない。**
 * 「デモ：部族フェーズから開始」「デバッグ表示」のような開発専用のボタンが
 * 本番の画面に並んでいると、押していいものか分からず、周りの本物のボタンまで
 * 避けられる。開発時は `?dev=1` を付ける。
 */
export const DEV = new URLSearchParams(location.search).has('dev');

export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node)) { kids.unshift(attrs); attrs = null; }
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'data' && typeof v === 'object') for (const d in v) n.dataset[d] = v[d];
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  add(n, kids);
  return n;
}

function add(n, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(n, k);
    else n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/**
 * 既存ノードに子を足す。素の node.append() を使ってはいけない：
 * null を渡すと文字列 "null" のテキストノードになって画面に出る。
 * 条件付きの子（cond ? el(...) : null）を書く以上、必ずこちらを通す。
 */
export function mount(n, ...kids) { add(n, kids); return n; }

export function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
export function $(sel, root = document) { return root.querySelector(sel); }

export const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const pct = (v, d = 0) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/**
 * 辞書を引いて「表示名 ＋ data-term」の付いたラベル節点を作る。
 * bar / tile / stat の3つが同じものを使うので、ここに1つだけ置く。
 *
 * @param key     内部名（辞書のキー）
 * @param cls     ラベルの class（'nm' / 'k'）
 * @param opts    { label } … 表示名を上書きする稀なとき用
 * @param value   data-term-value に載せる文字列（無ければ載せない）
 * @param tagIt   行の右端に1文字の印（畑・戦・増・心・血）を出すか
 */
function termLabelNode(key, cls, opts = {}, value = null, tagIt = false) {
  const t = term(key);
  const text = opts.label != null ? opts.label : termLabel(key);
  const attrs = { class: cls, 'data-term': key };
  if (value != null) attrs['data-term-value'] = String(value);
  // 辞書に無い語は開発時だけ赤くする。本番ではキーをそのまま出して落とさない。
  if (!t && DEV) attrs.class = cls + ' termbad';
  return el('div', attrs,
    el('span', { class: 'u' }, text),
    tagIt && t && t.tag ? el('i', { class: 'tg' }, t.tag) : null,
  );
}

/**
 * ラベル付きの横バー。**第1引数は内部名**（表示名ではない）。
 * value は 0..1。range を渡すと推定幅表示（まだ分かっていない力）になる。
 */
export function bar(key, value, opts = {}) {
  const { range = null, dim = false, color = null, unit = 100, tag = true } = opts;
  const tr = el('div', { class: 'tr' });
  if (range) {
    tr.appendChild(el('div', {
      class: 'fl rng',
      style: { left: (range[0] * 100) + '%', width: ((range[1] - range[0]) * 100) + '%' },
    }));
  } else {
    const fl = el('div', { class: 'fl', style: { width: clamp(value) * 100 + '%' } });
    if (color) fl.style.background = color;
    tr.appendChild(fl);
  }
  // めもりは 0〜100 の整数（R-975）。まだ分かっていないものだけ数を出さない。
  const shown = range ? null : Math.round(clamp(value) * unit);
  return el('div', { class: 'bar' + (dim ? ' dim' : '') },
    termLabelNode(key, 'nm', opts, shown, tag),
    tr,
    el('div', { class: 'nu' }, range ? '??' : shown),
  );
}

/**
 * 数値タイル。**第1引数は内部名。**
 * @param key  内部名
 * @param v    出す文字列（呼ぶ側が書式を決める。R-975 の3種類のどれか）
 * @param sub  下に添える一言（無ければ省く）
 */
export function tile(key, v, sub, opts = {}) {
  const { cls = '' } = opts;
  return el('div', { class: 'tile' + (cls ? ' ' + cls : '') },
    termLabelNode(key, 'k', opts, v == null ? null : String(v)),
    el('div', { class: 'v' }, v),
    sub ? el('div', { class: 's' }, sub) : null);
}

/**
 * 上帯の1項目。**第1引数は内部名。**
 * @param key  内部名
 * @param v    出す文字列
 * @param opts { cls, sub, label }
 */
export function stat(key, v, opts = {}) {
  const { cls = '', sub = '' } = opts;
  return el('div', { class: 'stat' + (cls ? ' ' + cls : '') },
    termLabelNode(key, 'k', opts, v == null ? null : String(v)),
    el('div', { class: 'v' }, v, sub ? el('small', {}, sub) : null));
}

export { unitHint };

/** オン/オフのトグル */
export function toggle(on, onChange) {
  const n = el('div', { class: 'sw' + (on ? ' on' : ''), onclick: () => { on = !on; n.classList.toggle('on', on); onChange(on); } });
  return n;
}

/** ステッパー（数値入力の代わり。文字入力は一切なし） */
export function stepper(value, { min = 0, max = 100, step = 5, fmt = (v) => v, onChange = () => {} } = {}) {
  const v = el('div', { class: 'val' }, fmt(value));
  const set = (nv) => { value = clamp(nv, min, max); v.textContent = fmt(value); onChange(value); };
  return el('div', { class: 'stepper' },
    el('button', { onclick: () => set(value - step), title: '減らす' }, '−'),
    v,
    el('button', { onclick: () => set(value + step), title: '増やす' }, '＋'),
  );
}

/** セグメント選択（クリックのみ） */
export function seg(items, current, onPick) {
  const wrap = el('div', { class: 'seg' });
  for (const it of items) {
    const b = el('button', { class: it.value === current ? 'on' : '', onclick: () => onPick(it.value) }, it.label);
    wrap.appendChild(b);
  }
  return wrap;
}

/** 折れ線グラフ（SVG）。points は数値配列。 */
export function sparkline(label, values, { color = '#5fe3c4', min = null, max = null } = {}) {
  const W = 300, H = 52, P = 4;
  const vs = values.length ? values : [0];
  const lo = min != null ? min : Math.min(...vs);
  const hi = max != null ? max : Math.max(...vs);
  const span = (hi - lo) || 1;
  const step = vs.length > 1 ? (W - P * 2) / (vs.length - 1) : 0;
  const pts = vs.map((v, i) => `${(P + i * step).toFixed(1)},${(H - P - ((v - lo) / span) * (H - P * 2)).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <polyline points="${pts} ${W - P},${H - P} ${P},${H - P}" fill="${color}" opacity=".10" stroke="none"/>
  </svg>`;
  return el('div', { class: 'graph' },
    el('div', { class: 'gh' }, el('span', {}, label), el('span', { class: 'mono' }, num(vs[vs.length - 1], 2))),
    el('div', { html: svg }),
  );
}

/** 通知トースト */
export function toast(text, kind = '') {
  const root = document.getElementById('toast');
  if (!root) return;
  const n = el('div', { class: 'toast ' + kind }, text);
  root.appendChild(n);
  const t = setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 250); }, 3600);
  n.addEventListener('click', () => { clearTimeout(t); n.remove(); });
  while (root.children.length > 5) root.firstChild.remove();
}

/** モーダル。close() を返す。 */
export function modal({ title, sub, body, footer, cls = '', onClose = null, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const scrim = el('div', { class: 'scrim' });
  const close = () => { scrim.remove(); if (onClose) onClose(); };
  const m = el('div', { class: 'modal ' + cls },
    el('header', {}, el('h2', {}, title), sub ? el('div', { class: 'sub' }, sub) : null),
    el('div', { class: 'body' }, body),
    footer ? el('footer', {}, footer) : null,
  );
  scrim.appendChild(m);
  if (dismissable) scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  root.appendChild(scrim);
  return { close, node: m, body: m.querySelector('.body') };
}
