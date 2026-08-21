// 地図。**家を家庭の数だけ描いて、エリアを描き分ける。**
//
// 確定事項より：
//   A-19  家（＝1家族・1つの箱）→ 村（家＋畑＋森＋訓練場＋その他）→ 街 → 国
//         **誰がどこで何の仕事をしているかが、見て分かること**が要件
//         絵は線画や塗り分け程度でよい
//   A-19b 1村＝30世帯＝約100人。村の上限は「30軒が埋まったら」
//         → **住居エリアに枠を30個描く。**埋まっていく様子がそのまま上限になる
//   A-4/A-5  個体は円。**大きさ＋年輪＝年齢／細胞の数＝熟練／色相＝血統**
//   A-10  常に動いているもの3つ：細胞が増える／蔵が満ちる／季節が変わる
//   A-11  冬は作物ができない → 畑の絵がそう言う
//
// 掟：**色に意味を載せない。色相は血統だけ。**
//     状態（飢え・身重・家長）は形で言う。線の切り方・中の点・上の印。
//     画像アセットは使わない。線画と塗り分けだけ。
//     **UI は world を直接呼ばない。**ここが読むのは flow/run.js が返した素の値だけ。

import {
  AREA_NAMES, AREA_HOME, AREA_FIELD, AREA_FOREST, AREA_TRAIN, AREA_FRONTIER,
  HOUSES_PER_VILLAGE,
} from '../flow/run.js';

// ---- 村1つぶんの大きさ（世界座標） ----------------------------------------
export const VW = 1040, VH = 760;
export const VILLAGE_GAP = 90;      // 村を並べる隙間（街になったときの間）
export const BAND = 46;             // 辺境の帯の幅

// エリアの矩形（村の中の座標）。添字は AREA_*
export const AREA_RECT = [
  { x: 60,  y: 306, w: 920, h: 214 },   // 0 住居
  { x: 60,  y: 548, w: 920, h: 168 },   // 1 畑
  { x: 60,  y: 46,  w: 496, h: 240 },   // 2 森
  { x: 584, y: 46,  w: 396, h: 240 },   // 3 訓練場
  { x: 0,   y: 0,   w: VW,  h: VH  },   // 4 辺境（外周の帯。中は空ける）
];

// 住居の30枠。10列×3行 ＝ A-19b の30世帯
export const SLOT_COLS = 10, SLOT_ROWS = 3;
export const HOME_PAD_TOP = 22;      // 名札のぶんだけ枠を下げる
export const BOX_H = 26;             // 家の箱の高さ。上に屋根、下に庭

// ---- 色（塗り分け） --------------------------------------------------------
const COL = {
  ground:       '#0d0f0a',
  frontier:     '#171a11',
  frontierEdge: '#3b402a',
  scrub:        'rgba(120,128,90,0.35)',
  home:         '#1b1a15',
  homeEdge:     '#4c4635',
  field:        '#2b2411',
  fieldWinter:  '#1c1b16',
  fieldEdge:    '#5a4a20',
  furrow:       '#3d3316',
  furrowWinter: 'rgba(150,168,190,0.22)',
  forest:       '#13251a',
  forestEdge:   '#2e5138',
  tree:         '#2f5b35',
  train:        '#231d16',
  trainEdge:    '#5b4a33',
  box:          '#232019',
  boxEdge:      '#7d7159',
  boxEmpty:     '#332f25',
  label:        '#8d8a7c',
  labelHi:      '#cdc6ae',
  sel:          '#f2ead2',
  dead:         '#a2483a',
  snow:         'rgba(190,210,235,0.10)',
};

// ---- 決まった散らし（乱数ではない。同じ i からは必ず同じ位置が出る） --------
function hash01(n) {
  let x = (n | 0) + 0x9E3779B9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad); x >>>= 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97); x >>>= 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 4294967296;
}
const hx = i => hash01(i * 2 + 1);
const hy = i => hash01(i * 2 + 77771);

/** 村 k が世界のどこに置かれるか。村が増えたら格子に並ぶ（＝街になる・A-19） */
export function villageOrigin(k, n) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return {
    x: (k % cols) * (VW + VILLAGE_GAP),
    y: Math.floor(k / cols) * (VH + VILLAGE_GAP),
  };
}
export function worldBounds(n) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return {
    w: cols * (VW + VILLAGE_GAP) - VILLAGE_GAP,
    h: rows * (VH + VILLAGE_GAP) - VILLAGE_GAP,
  };
}

/** 住居エリアの s 番目の枠（村の中の座標）。屋根・箱・庭がこの中に収まる */
export function slotRect(s) {
  const r = AREA_RECT[AREA_HOME];
  const cw = r.w / SLOT_COLS, ch = (r.h - HOME_PAD_TOP) / SLOT_ROWS;
  const cx = s % SLOT_COLS, cy = Math.floor(s / SLOT_COLS);
  return { x: r.x + cx * cw + 10, y: r.y + HOME_PAD_TOP + cy * ch, w: cw - 20, h: ch - 6 };
}
/** 家の箱そのもの。上の余白は屋根 */
export function boxRect(s) {
  const b = slotRect(s);
  return { x: b.x, y: b.y + 10, w: b.w, h: BOX_H };
}
/** 家の前の庭。**住人はここに立つ**（箱に重ねると誰の家か読めなくなる） */
export function yardRect(s) {
  const b = slotRect(s);
  const top = b.y + 10 + BOX_H + 2;
  return { x: b.x - 2, y: top, w: b.w + 4, h: Math.max(10, b.y + b.h - top) };
}

/** 個体をどこに置くか（村の中の座標）。at はエリア、slot は家の枠 */
export function spotOf(i, at, slot) {
  if (at === AREA_HOME) {
    if (slot >= 0) {
      const y = yardRect(slot);
      return { x: y.x + 4 + hx(i) * (y.w - 8), y: y.y + hy(i) * y.h };
    }
    const r = AREA_RECT[AREA_HOME];
    return { x: r.x + 14 + hx(i) * (r.w - 28), y: r.y + 14 + hy(i) * (r.h - 28) };
  }
  if (at === AREA_FRONTIER) {
    const side = Math.floor(hx(i) * 4), p = hy(i), m = BAND * 0.5;
    if (side === 0) return { x: m + p * (VW - 2 * m), y: m * 0.62 };
    if (side === 1) return { x: VW - m * 0.62, y: m + p * (VH - 2 * m) };
    if (side === 2) return { x: m + p * (VW - 2 * m), y: VH - m * 0.62 };
    return { x: m * 0.62, y: m + p * (VH - 2 * m) };
  }
  const r = AREA_RECT[at] || AREA_RECT[AREA_HOME];
  return { x: r.x + 16 + hx(i) * (r.w - 32), y: r.y + 26 + hy(i) * (r.h - 42) };
}

/** 個体の円の半径（世界座標）。**大きさ＝年齢**。26歳で頭打ち（A-4/A-6） */
export function radiusOf(p) { return 3.2 + 5.2 * p.grow; }

// ===========================================================================
// 地図
// ===========================================================================

export class MapView {
  constructor(canvas, run) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.run = run;
    this.dpr = 1;
    this.w = 1; this.h = 1;
    this.cam = { x: VW / 2, y: VH / 2, z: 1 };
    this.hits = [];         // 個体の当たり判定（画面座標）
    this.boxes = [];        // 家の当たり判定（画面座標）
    this.hover = null;
    this.onSelect = null;
    this.dirty = true;
    this._ox = 0; this._oy = 0;   // いま描いている村の原点
    this._drag = null;
    this._hoverKey = null;
    this._bind();
  }

  // ---- 画面と世界の行き来 ------------------------------------------------
  toScreen(wx, wy) {
    return {
      x: (wx - this.cam.x) * this.cam.z + this.w / 2,
      y: (wy - this.cam.y) * this.cam.z + this.h / 2,
    };
  }
  toWorld(sx, sy) {
    return {
      x: (sx - this.w / 2) / this.cam.z + this.cam.x,
      y: (sy - this.h / 2) / this.cam.z + this.cam.y,
    };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dirty = true;
  }

  /** 村ぜんぶが画面に収まるところへ戻す */
  fit(n = 1) {
    this.clearHover();
    const b = worldBounds(Math.max(1, n));
    const z = Math.min(this.w / (b.w + 48), this.h / (b.h + 48));
    this.cam.z = z > 0 ? z : 1;
    this.cam.x = b.w / 2; this.cam.y = b.h / 2;
    this.dirty = true;
    return this;
  }
  /** 札を消す。カメラが動いたら、指している先が変わっているので出しっぱなしにしない */
  clearHover() {
    if (this.hover) { this.hover = null; this._hoverKey = null; this.dirty = true; }
  }
  zoomBy(f, atX, atY) {
    this.clearHover();
    const before = this.toWorld(atX, atY);
    let z = this.cam.z * f;
    if (z < 0.1) z = 0.1;
    if (z > 6) z = 6;
    this.cam.z = z;
    const after = this.toWorld(atX, atY);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.dirty = true;
  }

  // ---- 入力 --------------------------------------------------------------
  _at(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _bind() {
    const cv = this.canvas;
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this._at(e);
      this.zoomBy(Math.pow(0.999, e.deltaY), p.x, p.y);
    }, { passive: false });

    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const p = this._at(e);
      this._drag = { x: p.x, y: p.y, moved: 0 };
    });
    cv.addEventListener('pointermove', e => {
      const p = this._at(e);
      if (this._drag) {
        const dx = p.x - this._drag.x, dy = p.y - this._drag.y;
        this._drag.moved += Math.abs(dx) + Math.abs(dy);
        this.cam.x -= dx / this.cam.z;
        this.cam.y -= dy / this.cam.z;
        this._drag.x = p.x; this._drag.y = p.y;
        this.clearHover();
        this.dirty = true;
        return;
      }
      const hit = this.pick(p.x, p.y);
      const key = hit ? `${hit.kind}${hit.id}` : null;
      if (key !== this._hoverKey) { this._hoverKey = key; this.hover = hit; this.dirty = true; }
      cv.style.cursor = hit ? 'pointer' : 'grab';
    });
    cv.addEventListener('pointerup', e => {
      const d = this._drag;
      this._drag = null;
      if (!d || d.moved > 6) return;        // 引っぱっただけ。選ばない
      const p = this._at(e);
      const hit = this.pick(p.x, p.y);
      if (this.onSelect) this.onSelect(hit);
      this.dirty = true;
    });
    cv.addEventListener('pointercancel', () => { this._drag = null; });
    cv.addEventListener('dblclick', () => {
      this.fit(this.run.snapshot().villages.length);
    });
    cv.addEventListener('pointerleave', () => {
      if (this.hover) { this.hover = null; this._hoverKey = null; this.dirty = true; }
    });
  }

  /** 画面の点 → 誰か／どの家か */
  pick(sx, sy) {
    let best = null, bestD = 1e9;
    for (let k = this.hits.length - 1; k >= 0; k--) {
      const p = this.hits[k];
      const d = Math.hypot(p.x - sx, p.y - sy);
      const rr = Math.max(7, p.r + 3);
      if (d <= rr && d < bestD) { bestD = d; best = { kind: 'person', id: p.i }; }
    }
    if (best) return best;
    for (let k = this.boxes.length - 1; k >= 0; k--) {
      const b = this.boxes[k];
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) {
        return { kind: 'house', id: b.id };
      }
    }
    return null;
  }

  // ---- 描く --------------------------------------------------------------
  draw() {
    const snap = this.run.snapshot();
    const g = this.ctx;
    const z = this.cam.z;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COL.ground;
    g.fillRect(0, 0, this.w, this.h);

    this.hits.length = 0;
    this.boxes.length = 0;

    const n = Math.max(1, snap.villages.length);
    for (let k = 0; k < snap.villages.length; k++) {
      const vv = snap.villages[k];
      const o = villageOrigin(k, n);
      this._ox = o.x; this._oy = o.y;
      const s = this.toScreen(o.x, o.y);
      g.save();
      g.translate(s.x, s.y);
      g.scale(z, z);
      this._village(g, vv, snap, z);
      g.restore();
    }

    this._tip(g, snap);
    this.dirty = false;
  }

  _village(g, vv, snap, z) {
    const winter = snap.bar.winter;

    // ---- 辺境（外周の帯） ----
    g.fillStyle = COL.frontier;
    g.fillRect(0, 0, VW, VH);
    g.strokeStyle = COL.frontierEdge;
    g.lineWidth = 2 / z;
    g.setLineDash([10 / z, 8 / z]);
    g.strokeRect(1, 1, VW - 2, VH - 2);
    g.setLineDash([]);
    g.strokeStyle = COL.scrub;
    g.lineWidth = 1.2 / z;
    for (let i = 0; i < 46; i++) {                 // 石と藪。辺境らしさだけ
      const p = spotOf(i * 13 + 5, AREA_FRONTIER, -1);
      g.beginPath();
      g.moveTo(p.x - 5, p.y + 3); g.lineTo(p.x, p.y - 4); g.lineTo(p.x + 5, p.y + 3);
      g.stroke();
    }

    // ---- 森 ----
    const F = AREA_RECT[AREA_FOREST];
    g.fillStyle = COL.forest;
    g.fillRect(F.x, F.y, F.w, F.h);
    g.strokeStyle = COL.forestEdge; g.lineWidth = 1.6 / z;
    g.strokeRect(F.x, F.y, F.w, F.h);
    g.strokeStyle = COL.tree; g.lineWidth = 1.4 / z;
    for (let i = 0; i < 58; i++) {
      const x = F.x + 18 + hx(i * 7 + 3) * (F.w - 36);
      const y = F.y + 34 + hy(i * 7 + 3) * (F.h - 58);
      const s = 12 + hx(i * 31) * 12;
      g.beginPath();
      g.moveTo(x, y + s / 2);
      g.lineTo(x - s * 0.42, y + s / 2);
      g.lineTo(x, y - s / 2);
      g.lineTo(x + s * 0.42, y + s / 2);
      g.closePath();
      g.stroke();
    }

    // ---- 訓練場 ----
    const T = AREA_RECT[AREA_TRAIN];
    g.fillStyle = COL.train;
    g.fillRect(T.x, T.y, T.w, T.h);
    g.strokeStyle = COL.trainEdge; g.lineWidth = 1.6 / z;
    g.strokeRect(T.x, T.y, T.w, T.h);
    g.beginPath();
    g.ellipse(T.x + T.w / 2, T.y + T.h / 2 + 10, T.w * 0.34, T.h * 0.30, 0, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1.4 / z;
    for (let i = 0; i < 4; i++) {                  // 藁人形
      const x = T.x + T.w * (0.22 + i * 0.19), y = T.y + T.h * 0.86;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x, y - 26);
      g.moveTo(x - 10, y - 18); g.lineTo(x + 10, y - 18);
      g.stroke();
    }

    // ---- 畑 ----
    const P = AREA_RECT[AREA_FIELD];
    g.fillStyle = winter ? COL.fieldWinter : COL.field;
    g.fillRect(P.x, P.y, P.w, P.h);
    g.strokeStyle = COL.fieldEdge; g.lineWidth = 1.6 / z;
    g.strokeRect(P.x, P.y, P.w, P.h);
    g.strokeStyle = winter ? COL.furrowWinter : COL.furrow;
    g.lineWidth = 1.3 / z;
    for (let r = 1; r < 9; r++) {
      const y = P.y + (P.h / 9) * r;
      g.beginPath(); g.moveTo(P.x + 8, y); g.lineTo(P.x + P.w - 8, y); g.stroke();
    }
    if (winter) {                                  // 冬は作物ができない（A-11）
      g.fillStyle = COL.snow;
      g.fillRect(P.x, P.y, P.w, P.h);
      g.fillRect(F.x, F.y, F.w, F.h);
    }

    // ---- 住居。30枠（空き枠も描く。埋まっていく様子が村の上限そのもの） ----
    const H = AREA_RECT[AREA_HOME];
    g.fillStyle = COL.home;
    g.fillRect(H.x, H.y, H.w, H.h);
    g.strokeStyle = COL.homeEdge; g.lineWidth = 1.6 / z;
    g.strokeRect(H.x, H.y, H.w, H.h);

    const taken = new Map();
    for (const hm of snap.homes) if (hm.v === vv.v) taken.set(hm.slot, hm);
    for (let s = 0; s < HOUSES_PER_VILLAGE; s++) {
      const b = boxRect(s);
      const hm = taken.get(s);
      if (!hm) {
        g.strokeStyle = COL.boxEmpty; g.lineWidth = 1.1 / z;
        g.setLineDash([5 / z, 5 / z]);
        g.strokeRect(b.x, b.y, b.w, b.h);
        g.setLineDash([]);
        continue;
      }
      this._houseBox(g, b, hm, z);
    }

    // ---- エリアの名札 ----
    this._areaLabel(g, F, `森（狩り）　${vv.byArea[AREA_FOREST]}人`, z);
    this._areaLabel(g, T, `訓練場　${vv.byArea[AREA_TRAIN]}人`, z);
    this._areaLabel(g, H,
      `住居　${vv.houses} / ${HOUSES_PER_VILLAGE}軒${vv.full ? '　満（溢れている）' : ''}　`
      + `いま${vv.byArea[AREA_HOME]}人（子・身重・家事）`, z);
    this._areaLabel(g, P, `畑　${vv.byArea[AREA_FIELD]}人${winter ? '　冬・作物はできない' : ''}`, z);
    g.fillStyle = COL.label;
    g.font = `${13 / z}px system-ui, sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(
      `${vv.whereName}の村　${vv.pop}人　働き手${vv.workers}　産${vv.produced.toFixed(1)} ／ 食${vv.eaten.toFixed(1)}`
      + (vv.hungry ? `　飢${vv.hungry}` : ''),
      12, VH - 10);

    // ---- 弔い。**死は永久に戻らない**（A-10）ので少しのあいだ跡を残す ----
    for (const d of snap.gone) {
      if (d.v !== vv.v) continue;
      const p = spotOf(d.i, d.at, -1);
      g.globalAlpha = Math.max(0, d.fade) * 0.9;
      g.strokeStyle = COL.dead; g.lineWidth = 2 / z;
      g.beginPath();
      g.moveTo(p.x - 5, p.y - 5); g.lineTo(p.x + 5, p.y + 5);
      g.moveTo(p.x + 5, p.y - 5); g.lineTo(p.x - 5, p.y + 5);
      g.stroke();
      g.globalAlpha = 1;
    }

    // ---- 個体 ----
    if (snap.tooMany) {
      g.fillStyle = COL.labelHi;
      g.font = `${18 / z}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('人が多い。ここからは箱だけを描く（降りたら中が見える）', VW / 2, VH / 2);
      return;
    }
    const sel = this.run.selected, selH = this.run.selectedHouse;
    for (const p of snap.folk) {
      if (p.v !== vv.v) continue;
      const at = spotOf(p.i, p.at, p.at === AREA_HOME ? p.slot : -1);
      this._person(g, at, p, z, sel === p.i, selH >= 0 && p.h === selH);
    }
  }

  _houseBox(g, b, hm, z) {
    const selected = this.run.selectedHouse === hm.h;
    g.fillStyle = COL.box;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeStyle = selected ? COL.sel : COL.boxEdge;
    g.lineWidth = (selected ? 2.2 : 1.3) / z;
    g.strokeRect(b.x, b.y, b.w, b.h);
    g.beginPath();                                  // 屋根（線画）
    g.moveTo(b.x - 4, b.y);
    g.lineTo(b.x + b.w / 2, b.y - b.h * 0.42);
    g.lineTo(b.x + b.w + 4, b.y);
    g.stroke();
    if (z > 0.5) {
      g.fillStyle = COL.label;
      g.font = `${10 / z}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`${hm.size}人`, b.x + b.w / 2, b.y + b.h / 2);
    }
    const p0 = this.toScreen(this._ox + b.x, this._oy + b.y);
    this.boxes.push({ id: hm.h, x: p0.x, y: p0.y, w: b.w * z, h: b.h * z });
  }

  // 名札。中身と重なっても読めるよう、下に暗い板を敷く
  _areaLabel(g, r, text, z) {
    const fs = 13 / z;
    g.font = `${fs}px system-ui, sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'top';
    const w = g.measureText(text).width;
    g.fillStyle = 'rgba(10,12,8,0.72)';
    g.fillRect(r.x + 5, r.y + 4, w + 10, fs * 1.5);
    g.fillStyle = COL.labelHi;
    g.fillText(text, r.x + 10, r.y + 4 + fs * 0.22);
  }

  /**
   * 個体。**円。大きさ＋年輪＝年齢／細胞の数＝熟練／色相＝血統**（A-4/A-5）。
   * 状態は色ではなく形で言う。**色に意味を載せない。**
   */
  _person(g, at, p, z, isSel, inSelHouse) {
    const r = radiusOf(p);
    // 血が混ざるほど色が抜ける。ただし色相そのものは読めるだけの濃さを残す
    // （**閉じこもる村は血が痩せる**（A-19b）が、そのまま画面の色あせになる）
    const sat = 34 + 40 * p.pure;
    const lig = p.working ? 55 : 68;
    const hue = p.hue.toFixed(0), sa = sat.toFixed(0);

    g.beginPath();
    g.arc(at.x, at.y, r, 0, Math.PI * 2);
    g.fillStyle = `hsl(${hue} ${sa}% ${lig}%)`;
    g.fill();

    const px = r * z;                          // 画面上の大きさ。小さいときは中身を描かない
    if (px > 2.6) {
      g.lineWidth = (p.hungry ? 1.7 : 1.1) / z;
      g.strokeStyle = `hsl(${hue} ${sa}% 24%)`;
      if (p.hungry) g.setLineDash([2.2 / z, 2.2 / z]);   // 飢え＝輪郭が切れる
      g.stroke();
      g.setLineDash([]);
    }

    if (px > 4.5 && p.rings > 0) {             // 年輪＝年齢
      g.strokeStyle = 'rgba(0,0,0,0.34)';
      g.lineWidth = 0.7 / z;
      for (let k = 1; k <= p.rings; k++) {
        g.beginPath(); g.arc(at.x, at.y, r * (k / (p.rings + 1)), 0, Math.PI * 2); g.stroke();
      }
    }

    if (px > 7.5 && p.cells > 0) {             // 細胞の数＝熟練
      g.fillStyle = 'rgba(255,252,238,0.74)';
      const rr = r * 0.52, dot = Math.max(0.5, r * 0.135);
      for (let k = 0; k < p.cells; k++) {
        const a = (k / p.cells) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.arc(at.x + Math.cos(a) * rr, at.y + Math.sin(a) * rr, dot, 0, Math.PI * 2);
        g.fill();
      }
    }

    if (p.pregnant && px > 4) {                // 身重＝中に子の点
      g.fillStyle = 'rgba(255,248,225,0.92)';
      g.beginPath(); g.arc(at.x, at.y, Math.max(1, r * 0.26), 0, Math.PI * 2); g.fill();
    }
    if (p.head && px > 5) {                    // 家長＝上に小さな印
      g.strokeStyle = 'rgba(240,232,205,0.85)';
      g.lineWidth = 1.1 / z;
      g.beginPath();
      g.moveTo(at.x - r * 0.55, at.y - r - 2.5);
      g.lineTo(at.x, at.y - r - 6.5);
      g.lineTo(at.x + r * 0.55, at.y - r - 2.5);
      g.stroke();
    }
    if (p.newborn && px > 3) {                 // 生まれたて＝広がる輪
      g.strokeStyle = 'rgba(255,250,230,0.5)';
      g.lineWidth = 1 / z;
      g.beginPath(); g.arc(at.x, at.y, r + 5, 0, Math.PI * 2); g.stroke();
    }
    if (isSel || inSelHouse) {
      g.strokeStyle = isSel ? COL.sel : 'rgba(242,234,210,0.45)';
      g.lineWidth = (isSel ? 2 : 1.2) / z;
      if (!isSel) g.setLineDash([3 / z, 3 / z]);
      g.beginPath(); g.arc(at.x, at.y, r + 4.5, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }

    const s = this.toScreen(this._ox + at.x, this._oy + at.y);
    this.hits.push({ i: p.i, x: s.x, y: s.y, r: r * z });
  }

  _tip(g, snap) {
    const h = this.hover;
    if (!h) return;
    let text = null, at = null;
    if (h.kind === 'person') {
      const p = snap.folk.find(f => f.i === h.id);
      const hit = this.hits.find(t => t.i === h.id);
      if (!p || !hit) return;
      at = hit;
      text = `${p.i}番　${p.age}歳${p.sex === 1 ? '女' : '男'}　${AREA_NAMES[p.job]}`
        + (p.pregnant ? '　身重' : '') + (p.hungry ? '　飢え' : '') + (p.head ? '　家長' : '');
    } else {
      const b = this.boxes.find(t => t.id === h.id);
      const hm = snap.homes.find(t => t.h === h.id);
      if (!b || !hm) return;
      at = { x: b.x + b.w / 2, y: b.y, r: 0 };
      text = `${hm.h}の家　${hm.size}人　${hm.gen}代目`;
    }
    g.font = '12px system-ui, sans-serif';
    const w = g.measureText(text).width + 14;
    const x = Math.max(2, Math.min(this.w - w - 4, at.x + 12));
    const y = Math.max(2, at.y - 26);
    g.fillStyle = 'rgba(12,14,9,0.94)';
    g.fillRect(x, y, w, 20);
    g.strokeStyle = 'rgba(140,134,110,0.6)'; g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, 19);
    g.fillStyle = '#e8e4d8';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(text, x + 7, y + 10.5);
  }
}
