// シャーレ（メイン画面）の描画。Canvas。黒背景。画像アセットはゼロ。
//   住人 = 円 ＋ 縦長の目2つ
//   村   = 中心の多角形（辺の数 = 発展段階）
//   資源 = 小さい三角
// 位置は UI 側だけが持つ。sim は座標を知らない。

import { RNG } from '../core/rng.js';
import { ROLE, DISTRICT } from '../core/model.js';
import { drawIndividual, bodyColor, radiusOf, fearOf } from './color.js';
import { clamp } from './dom.js';

const ROLE_ANGLE = {
  [ROLE.FARM]:  Math.PI * 0.5,     // 下
  [ROLE.HUNT]:  Math.PI * 1.0,     // 左
  [ROLE.DRILL]: Math.PI * 0.0,     // 右
  [ROLE.IDLE]:  Math.PI * 1.5,     // 上
  [ROLE.WAR]:   Math.PI * 1.25,
  [ROLE.CHILD]: null,              // 中心付近をうろつく
};

export class Dish {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.pos = new Map();       // id -> {x,y,vx,vy,ha,hr,ph,seed}
    this.rng = new RNG(0x1a2b3c4d);
    this.w = 1; this.h = 1; this.dpr = 1;
    this.hover = null;
    this.selected = null;
    this.time = 0;
    this.onPick = () => {};
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement || canvas);
    canvas.addEventListener('mousemove', (e) => this._mouse(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; });
    canvas.addEventListener('click', (e) => { this._mouse(e); this.onPick(this.hover); });
  }

  _resize() {
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.c.width = Math.round(this.w * this.dpr);
    this.c.height = Math.round(this.h * this.dpr);
  }

  _mouse(e) {
    const r = this.c.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 22 * 22;
    for (const [id, p] of this.pos) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    this.hover = best;
    this.c.style.cursor = best ? 'pointer' : 'crosshair';
  }

  /** 村の発展段階（多角形の辺の数） */
  static stage(world) {
    const n = world.people.size;
    if (n >= 100) return 9;
    if (n >= 70) return 8;
    if (n >= 40) return 7;
    if (n >= 20) return 6;
    if (n >= 10) return 5;
    if (n >= 5) return 4;
    return 3;
  }

  sync(world) {
    const live = new Set();
    for (const p of world.people.values()) {
      live.add(p.id);
      if (!this.pos.has(p.id)) {
        const a = this.rng.next() * Math.PI * 2;
        const rr = 40 + this.rng.next() * 30;
        this.pos.set(p.id, {
          x: this.w / 2 + Math.cos(a) * rr, y: this.h / 2 + Math.sin(a) * rr,
          vx: 0, vy: 0, ha: a, hr: rr, ph: this.rng.next() * 100, born: this.time,
        });
      }
    }
    for (const id of [...this.pos.keys()]) if (!live.has(id)) this.pos.delete(id);
  }

  update(world, dt) {
    this.time += dt;
    const cx = this.w / 2, cy = this.h / 2;
    const n = world.people.size || 1;
    const vr = clamp(50 + n * 1.5, 50, Math.min(this.w, this.h) * 0.20);
    this.vr = vr;

    for (const p of world.people.values()) {
      const s = this.pos.get(p.id);
      if (!s) continue;
      // 角度と半径には別々のハッシュを使う。同じ値を使い回すと角度と半径が相関して
      // 群れが渦巻き状の一本線になり、居住区の帯として読めなくなる。
      const sa = hash01(p.id, 0x9e3779b9);
      const sr = hash01(p.id, 0x85ebca6b);
      const sector = ROLE_ANGLE[p.role];
      const spread = p.role === ROLE.CHILD ? Math.PI * 2 : Math.PI * 0.46;
      const ang = sector == null ? sa * Math.PI * 2 : sector + (sa - 0.5) * spread;
      const ringIn = p.district === DISTRICT.FRONTIER ? vr * 2.45 : vr * 1.28;
      const ringOut = p.district === DISTRICT.FRONTIER ? vr * 3.5 : vr * 2.10;
      const rr = p.role === ROLE.CHILD ? vr * (0.72 + sr * 0.34) : ringIn + sr * (ringOut - ringIn);

      const wob = Math.sin(this.time * 0.7 + s.ph) * 0.09 + Math.cos(this.time * 0.43 + s.ph * 1.7) * 0.06;
      const tx = cx + Math.cos(ang + wob * 0.5) * rr * (1 + wob * 0.06);
      const ty = cy + Math.sin(ang + wob * 0.5) * rr * (1 + wob * 0.06);

      s.vx += (tx - s.x) * 0.0026 * dt * 60;
      s.vy += (ty - s.y) * 0.0026 * dt * 60;
      s.vx *= 0.90; s.vy *= 0.90;
      s.x += s.vx; s.y += s.vy;
    }
  }

  draw(world) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const cx = this.w / 2, cy = this.h / 2;
    const vr = this.vr || 60;

    // ---- 村：多角形（辺の数 = 発展段階）
    const sides = Dish.stage(world);
    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * vr, y = cy + Math.sin(a) * vr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,30,42,0.55)';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = world.collapsing ? 'rgba(226,96,74,0.85)' : 'rgba(95,227,196,0.42)';
    ctx.stroke();

    // 辺境の境界
    ctx.beginPath();
    ctx.arc(cx, cy, vr * 2.25, 0, Math.PI * 2);
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = 'rgba(120,140,180,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- 資源：小さい三角
    const tri = clamp(Math.round(world.food / 4), 0, 30);
    ctx.fillStyle = 'rgba(232,178,74,0.72)';
    for (let i = 0; i < tri; i++) {
      const a = -Math.PI / 2 + (i / Math.max(1, tri)) * Math.PI * 2;
      const rr = vr * 0.42;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      const s = 3.4;
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.87, y + s * 0.5); ctx.lineTo(x - s * 0.87, y + s * 0.5);
      ctx.closePath(); ctx.fill();
    }

    // ---- 住人
    const base = clamp(13 - world.people.size * 0.055, 5.5, 13);
    const ppl = [...world.people.values()];
    for (const p of ppl) {
      const s = this.pos.get(p.id);
      if (!s) continue;
      const r = radiusOf(p, base);
      const isSel = this.selected === p.id;
      const isHov = this.hover === p.id;
      drawIndividual(ctx, world, p, s.x, s.y, r, {
        fear: fearOf(world, p),
        halo: isSel ? 6 : (isHov ? 4 : 0),
        haloColor: isSel ? 'rgba(95,227,196,0.30)' : 'rgba(200,215,255,0.16)',
        ring: p.bureau ? 'rgba(232,178,74,0.9)' : (p.foreign ? 'rgba(255,255,255,0.35)' : null),
      });
    }

    // ---- ホバー名札
    if (this.hover != null) {
      const p = world.people.get(this.hover);
      const s = this.pos.get(this.hover);
      if (p && s) {
        const label = `${p.name}  ${p.age}歳`;
        ctx.font = '11px -apple-system, "Hiragino Sans", sans-serif';
        const w = ctx.measureText(label).width + 12;
        const bx = clamp(s.x - w / 2, 4, this.w - w - 4), by = s.y - base * 1.6 - 20;
        ctx.fillStyle = 'rgba(12,15,25,0.92)';
        ctx.strokeStyle = 'rgba(42,49,69,1)';
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, w, 18, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#c9d2e4';
        ctx.fillText(label, bx + 6, by + 12.5);
      }
    }
  }
}

/** id から 0..1 の安定した値を作る。種を変えると独立した系列になる。 */
function hash01(id, salt) {
  let h = (id ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
