// 見た目の規則。ここがこのゲームの看板。
//   色相 = 血統の混合比（出自。ステータス傾向ではない）
//   彩度 = 練度（熟練するほど鮮やか）
//   明度 = 年齢 / 体力（幼いと明るく、老いると暗い）
//
// 混血の子は親の色相の「間」に落ちる。だから斑（まだら）が世代を追って混色に溶ける。

import { SKILLS } from '../core/model.js';
import { clamp } from './dom.js';

/** 文字列から安定した色相を作る（sim が strains を持っていない場合の保険） */
export function hashHue(key) {
  let h = 2166136261;
  for (let i = 0; i < String(key).length; i++) { h ^= String(key).charCodeAt(i); h = Math.imul(h, 16777619); }
  // 赤（自国 = 0）から最低60度離すため 60..300 に散らす
  return 60 + ((h >>> 0) % 240);
}

/** 血統キー -> 色相。プレイヤーの自国は赤(0)。他国の世界を覗くときはその国の色。 */
export function strainHue(world, key) {
  const s = world && world.strains && world.strains[key];
  if (s && Number.isFinite(s.hue)) return s.hue;
  if (key === 'self') return 0;
  return hashHue(key);
}

export function strainName(world, key) {
  if (key === 'self') return '我らの血';
  const s = world && world.strains && world.strains[key];
  return (s && s.name) || String(key);
}

/** 血統の混合比 -> 色相。円環上の加重平均なので、混ざるほど中間色になる。 */
export function lineageHue(world, lineage) {
  const L = lineage && Object.keys(lineage).length ? lineage : { self: 1 };
  let x = 0, y = 0, tot = 0;
  for (const k in L) {
    const w = L[k];
    if (!(w > 0)) continue;
    const a = (strainHue(world, k) * Math.PI) / 180;
    x += Math.cos(a) * w; y += Math.sin(a) * w; tot += w;
  }
  if (!tot) return 0;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** 混血度 0..1（1に近いほど単一血統＝純血）。彩度の下限に効かせず、輪郭の描き分けに使う。 */
export function purity(lineage) {
  const L = lineage && Object.keys(lineage).length ? lineage : { self: 1 };
  let m = 0; for (const k in L) m = Math.max(m, L[k]);
  return clamp(m);
}

/** 練度（0..1）。5軸の平均。 */
export function training(ind) {
  if (!ind.skills) return 0;
  let s = 0, n = 0;
  for (const k of SKILLS) { s += ind.skills[k] || 0; n++; }
  return n ? clamp(s / n) : 0;
}

/** 明度。幼いと明るく、老いると暗い。傷病と疲労で更に落ちる。 */
export function lightness(ind) {
  const life = 14 + 16 * (ind.genes?.寿命 ?? 0.5) + 6 * (ind.genes?.頑健 ?? 0.5);
  const t = clamp((ind.age ?? 0) / life);
  let li = 70 - 42 * t;
  if (ind.wounded) li -= 9;
  li -= 7 * clamp(ind.fatigue ?? 0);
  if (!ind.alive) li = 16;
  return clamp(li, 14, 76);
}

// 彩度の下限を上げてある。0 まで落とすと色相（＝血統）が読めなくなり、
// このゲームの看板である「斑 → 混色」が見えなくなるため。
export function saturation(ind) {
  return clamp(52 + 46 * training(ind), 0, 100);
}

/** 個体の本体色 */
export function bodyColor(world, ind) {
  return `hsl(${lineageHue(world, ind.lineage).toFixed(1)} ${saturation(ind).toFixed(0)}% ${lightness(ind).toFixed(0)}%)`;
}

/** 半径。幼体は小さい。 */
export function radiusOf(ind, base = 9) {
  const young = clamp((ind.age ?? 0) / 5);
  return base * (0.52 + 0.48 * young) * (ind.alive === false ? 0.8 : 1);
}

/** 恐怖 0..1。戦闘中は fighter.fear、平時は世界の状態から。 */
export function fearOf(world, ind) {
  if (Number.isFinite(ind.fear)) return clamp(ind.fear);
  if (!world) return 0;
  let f = (1 - (world.morale ?? 0.6)) * 0.55;
  if ((world.food ?? 10) < 4) f += 0.35;
  if (ind.wounded) f += 0.25;
  f -= 0.3 * (ind.genes?.胆力 ?? 0.5);
  return clamp(f);
}

/**
 * 住人を描く。円 ＋ 縦長の目2つ。それだけ。
 * ctx / x / y / r / ind は必須。world は色相解決に使う。
 */
export function drawIndividual(ctx, world, ind, x, y, r, opts = {}) {
  const fear = opts.fear != null ? opts.fear : fearOf(world, ind);
  const li = lightness(ind);
  const col = opts.color || bodyColor(world, ind);

  if (opts.halo) {
    ctx.beginPath();
    ctx.arc(x, y, r + opts.halo, 0, Math.PI * 2);
    ctx.fillStyle = opts.haloColor || 'rgba(95,227,196,0.22)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();

  if (opts.ring) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = opts.ring;
    ctx.stroke();
  }

  // 死ぬと目は消える
  if (ind.alive === false || opts.dead) return;

  const sens = ind.genes?.感応 ?? 0.5;
  const ew = Math.max(0.9, r * 0.17);
  let eh = r * (0.24 + 0.38 * sens);
  eh *= (1 - 0.82 * clamp(fear));           // 恐怖で細くなる
  eh = Math.max(0.7, eh);
  const dx = r * 0.34;
  const dy = -r * 0.06;
  ctx.fillStyle = li > 47 ? 'rgba(10,11,17,0.92)' : 'rgba(233,236,247,0.94)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + s * dx, y + dy, ew, eh, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** チップ用の 22x22 くらいの小さな肖像 */
export function portrait(world, ind, size = 22) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = size * dpr; c.height = size * dpr;
  c.style.width = size + 'px'; c.style.height = size + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  drawIndividual(ctx, world, ind, size / 2, size / 2, size * 0.40);
  return c;
}

/** 血統スウォッチ（丸） */
export function swatchColor(world, key) {
  return `hsl(${strainHue(world, key)} 72% 52%)`;
}
