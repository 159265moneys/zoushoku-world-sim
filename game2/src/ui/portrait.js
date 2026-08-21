// 肖像。**個体票に1体だけ大きく描く。**
//
// 盤面（actors.js）と同じシェーダを使う。**2つ書かない。**
// 別々に書くと、盤面と個体票で同じ個体が違う姿になる。それがいちばん困る。
//
// 渡し方：呼び手は `el` を DOM に置いて `render(p)` を呼ぶだけ。
// WebGL のことは知らなくていい。
//
//   const port = new Portrait(96);
//   box.appendChild(port.el);
//   port.render(person);          // person は run.snapshot() の folk / detail と同じ形
//   port.dispose();               // 個体票を作り直すときは必ず呼ぶ（面を返す）
//
// **なぜ焼いて drawImage しないか**：検査「地図が画像アセットを使っていない」が
// `drawImage(` を一律で禁じている。canvas→canvas の転送は画像素材ではない（旧15 §13-0）が、
// 検査は共有物なので勝手に緩めない。**el そのものを GL の面にすれば転送が要らない。**
//
// **同時に持てる面は16枚ほど**（ブラウザの上限）。だから使い終わったら dispose() で返す。
// 一覧に何十人ぶんも並べたくなったら、この作りでは足りない。そのときは相談すること。

import { ActorLayer, SAT_ALIVE } from './actors.js';

const LIMIT = 8;                 // 同時に生かす肖像の上限。16の半分で止める
let live = 0;

export class Portrait {
  /** @param {number} size CSSピクセルの一辺。**80px 未満だと模様の本数が数えられない** */
  constructor(size = 96) {
    this.size = size;
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cv = document.createElement('canvas');
    cv.className = 'portrait';
    this.el = cv;
    this.layer = null;
    this.ctx = null;

    if (live < LIMIT) {
      const layer = new ActorLayer(cv);
      if (layer.ok) { this.layer = layer; live++; }
    }
    if (this.layer) this.layer.resize(size, size, this.dpr);
    else {
      // WebGL2 が無いか、面を使い切った。**丸と色だけになる。記号は諦める**
      cv.width = Math.round(size * this.dpr);
      cv.height = Math.round(size * this.dpr);
      cv.style.width = size + 'px';
      cv.style.height = size + 'px';
      this.ctx = cv.getContext('2d');
    }
  }

  /**
   * 1体描く。**死んでいる者は彩度を抜く**（A-5：彩度が言うのは生死だけ）。
   * @param {object} p run.snapshot() の folk / detail と同じ形。null で空にする
   */
  render(p) {
    const px = this.el.width;
    const r = px * 0.42;                       // 余白を残す。輪郭が切れると形が読めない
    const sat = p && p.alive === false ? 0 : SAT_ALIVE;

    if (this.layer) {
      this.layer.begin(1);
      if (p) {
        this.layer.push(
          px * 0.5, px * 0.5, r,
          p.weak ?? 0,
          p.hue1, p.hue2, p.sediment, sat,
          p.corners, p.special, p.stripeV, p.stripeH);
      }
      this.layer.flush();
      return;
    }

    const g = this.ctx;
    g.clearRect(0, 0, px, px);
    if (!p) return;
    g.beginPath();
    g.arc(px * 0.5, px * 0.5, r, 0, Math.PI * 2);
    g.fillStyle = `hsl(${p.hue1.toFixed(0)} ${(sat * 100).toFixed(0)}% `
      + `${(66 * (1 - 0.42 * (p.weak ?? 0))).toFixed(0)}%)`;
    g.fill();
  }

  /** 面を返す。**個体票を作り直すときは必ず呼ぶ。**呼ばないと16枚を使い切って出なくなる */
  dispose() {
    if (!this.layer) return;
    const ext = this.layer.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.layer = null;
    live--;
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
  out.push(p.sediment > 0
    ? `よその血が${Math.round(p.sediment * 200)}%ぶん沈んでいる`
    : '混ざっていない');
  return out;
}
