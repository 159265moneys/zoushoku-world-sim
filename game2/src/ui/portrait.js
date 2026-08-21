// 肖像。**個体票に1体だけ大きく描く。**
//
// 盤面（actors.js）と同じシェーダを使う。**2つ書かない。**
// 別々に書くと、盤面と個体票で同じ個体が違う姿になる。それがいちばん困る。
//
// 渡し方：呼び手は `el`（2Dのcanvas）をDOMに置き、`render(p)` を呼ぶだけ。
// WebGL のことは知らなくていい。**GLの面は全部の肖像で1枚を使い回す**
// （ブラウザが同時に持てる WebGL の面は16枚ほどしかないので、肖像ごとに作らない）。
//
//   const port = new Portrait(96);
//   box.appendChild(port.el);
//   port.render(person);          // person は run.snapshot().folk / detail と同じ形

import { ActorLayer } from './actors.js';
import { SAT_ALIVE } from './map.js';

let shared = null;                  // 使い回す GL の面。最初に要るまで作らない
let sharedSize = 0;

function sharedLayer(px) {
  if (!shared) {
    const cv = document.createElement('canvas');
    shared = new ActorLayer(cv);
    if (!shared.ok) { shared = { ok: false }; return shared; }
  }
  if (shared.ok && px > sharedSize) {
    sharedSize = px;
    shared.resize(px, px, 1);
  }
  return shared;
}

export class Portrait {
  /** @param {number} size CSSピクセルの一辺。**80px 未満だと模様の本数が数えられない** */
  constructor(size = 96) {
    this.size = size;
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cv = document.createElement('canvas');
    cv.className = 'portrait';
    cv.width = Math.round(size * this.dpr);
    cv.height = Math.round(size * this.dpr);
    cv.style.width = size + 'px';
    cv.style.height = size + 'px';
    this.el = cv;
    this.ctx = cv.getContext('2d');
  }

  /**
   * 1体描く。**死んでいる者は彩度を抜く**（A-5：彩度が言うのは生死だけ）。
   * @param {object} p run.snapshot() の folk / detail と同じ形。null で空にする
   */
  render(p) {
    const g = this.ctx, W = this.el.width;
    g.clearRect(0, 0, W, W);
    if (!p) return;

    const px = W;
    const gl = sharedLayer(px);
    const r = px * 0.42;                       // 余白を残す。輪郭が切れると形が読めない

    if (!gl.ok) { this._fallback(p, r); return; }

    gl.begin(1);
    gl.push(
      px * 0.5, px * 0.5, r,
      p.weak ?? 0,
      p.hue1, p.hue2, p.sediment,
      p.alive === false ? 0 : SAT_ALIVE,
      p.corners, p.special, p.stripeV, p.stripeH);
    gl.flush();
    g.drawImage(gl.canvas, 0, 0, px, px, 0, 0, W, W);
  }

  /** WebGL2 が無い環境。丸と色だけ。**記号は諦める**（盤面と同じ落とし方） */
  _fallback(p, r) {
    const g = this.ctx, c = this.el.width * 0.5;
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = `hsl(${p.hue1.toFixed(0)} `
      + `${((p.alive === false ? 0 : SAT_ALIVE) * 100).toFixed(0)}% `
      + `${(66 * (1 - 0.42 * (p.weak ?? 0))).toFixed(0)}%)`;
    g.fill();
  }
}

/**
 * いま肖像に出ているものを、言葉で並べる。**個体票の説明文はここから作る。**
 * 絵と文がずれると、絵のほうが嘘になる。
 */
export function portraitLegend(p) {
  const out = [];
  out.push(p.corners === 0 ? '丸' : `${p.corners}角`);
  if (p.special === 1) out.push('星（潜性が2本揃った）');
  if (p.special === 2) out.push('ハート（潜性が2本揃った）');
  if (p.stripeV > 0 && p.stripeH > 0) out.push(`水玉（縦${p.stripeV}×横${p.stripeH}）`);
  else if (p.stripeV > 0) out.push(`縦縞${p.stripeV}本`);
  else if (p.stripeH > 0) out.push(`横縞${p.stripeH}本`);
  else out.push('無地');
  if (p.sediment > 0) out.push(`よその血が${Math.round(p.sediment * 200)}%ぶん沈んでいる`);
  else out.push('混ざっていない');
  return out;
}
