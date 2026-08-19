// invariants.js — 毎tick／毎世代で必ず成り立っていなければならない条件。
// これが1本でも折れたら sim はまだ動いていない。設計主張の検証はその後。

import { GENE_NAMES } from '../src/core/genes.js';
import { SKILLS } from '../src/core/model.js';
import { Hasher, round } from './lib/util.js';

export const POP_CEILING = 5000;   // これを超えたら人口爆発とみなす
export const TICK_LIMIT = 200000;  // これを超えたら無限ループとみなして強制終了

export class Violations {
  constructor(limit = 40) { this.list = []; this.counts = new Map(); this.limit = limit; }
  add(kind, msg, ctx = {}) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (this.list.length < this.limit) this.list.push({ kind, msg, ...ctx });
  }
  get total() { let s = 0; for (const v of this.counts.values()) s += v; return s; }
  get ok() { return this.total === 0; }
  merge(other) {
    for (const [k, v] of other.counts) this.counts.set(k, (this.counts.get(k) ?? 0) + v);
    for (const v of other.list) if (this.list.length < this.limit) this.list.push(v);
  }
}

function bad(x) { return typeof x !== 'number' || !Number.isFinite(x); }

/**
 * 世界1つを1時点だけ検査する。
 * opts.light = true なら個体は先頭数体だけ見る（毎tick用。世代境界では必ず全件見る）
 */
export function checkWorld(world, v, where, opts = {}) {
  const at = { where, gen: world.gen, tick: world.tick };

  for (const [k, x] of [['food', world.food], ['yieldRate', world.yieldRate],
                        ['consumption', world.consumption], ['morale', world.morale],
                        ['density', world.density], ['regimeGrudge', world.regimeGrudge]]) {
    if (bad(x)) v.add('nan', `world.${k} = ${x}`, at);
  }
  const n = world.people.size;
  if (bad(n) || n < 0) v.add('neg-pop', `人口が不正: ${n}`, at);
  if (n === 0) v.add('extinct', `人口0（即死）`, at);
  if (n > POP_CEILING) v.add('pop-explosion', `人口 ${n} > ${POP_CEILING}`, at);
  if (world.morale < -1e-9 || world.morale > 1 + 1e-9) v.add('range', `morale=${world.morale} が 0..1 外`, at);
  // 食料は負になってよい（飢饉）が、非有限や桁違いの負は異常
  if (world.food < -1e6) v.add('neg-food', `food=${world.food} が異常に負`, at);
  if (world.yieldRate < -1e-9) v.add('neg-yield', `yieldRate=${world.yieldRate} が負`, at);

  let budget = opts.light ? 6 : Infinity;
  for (const p of world.people.values()) {
    if (budget-- <= 0) break;
    if (bad(p.age) || p.age < 0) v.add('nan', `#${p.id} age=${p.age}`, at);
    for (const g of GENE_NAMES) {
      const x = p.genes[g];
      if (bad(x)) { v.add('nan', `#${p.id} genes.${g}=${x}`, at); break; }
      if (x < -1e-9 || x > 1 + 1e-9) { v.add('range', `#${p.id} genes.${g}=${round(x, 4)} が 0..1 外`, at); break; }
    }
    for (const s of SKILLS) {
      const x = p.skills[s];
      if (bad(x)) { v.add('nan', `#${p.id} skills.${s}=${x}`, at); break; }
      if (x < -1e-9 || x > 1 + 1e-9) { v.add('range', `#${p.id} skills.${s}=${round(x, 4)} が 0..1 外`, at); break; }
    }
    if (bad(p.fatigue) || p.fatigue < -1e-9 || p.fatigue > 1 + 1e-9) v.add('range', `#${p.id} fatigue=${p.fatigue}`, at);
    if (bad(p.unmet) || p.unmet < -1e-9 || p.unmet > 1 + 1e-9) v.add('range', `#${p.id} unmet=${p.unmet}`, at);
    if (p.alive !== true) v.add('dead-alive', `#${p.id} が people に居るのに alive=${p.alive}`, at);
    // 血統の混合比は合計1（設計文書：色相＝血統の混合比）
    let ls = 0; for (const x of Object.values(p.lineage ?? {})) ls += x;
    if (Math.abs(ls - 1) > 1e-3) v.add('lineage-sum', `#${p.id} lineage 合計=${round(ls, 4)} ≠ 1`, at);
  }
  return v;
}

/** 歴史ハッシュ。同じ種から同じ歴史が出ることの証拠。 */
export function worldHash(world) {
  const h = new Hasher();
  h.push(world.gen).push(':').push(world.tick).push(':')
   .push(round(world.food, 3)).push(':').push(round(world.morale, 5)).push(':')
   .push(round(world.yieldRate, 4)).push(':').push(world.people.size).push('|');
  const ids = [...world.people.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const p = world.people.get(id);
    h.push(id).push(',').push(p.age).push(',').push(p.role).push(',').push(p.district).push(',');
    for (const g of GENE_NAMES) h.push(round(p.genes[g], 5)).push(',');
    for (const s of SKILLS) h.push(round(p.skills[s], 5)).push(',');
    h.push(';');
  }
  return h.hex;
}

/** 事件ログのハッシュ。順序にも依存させる。 */
export function eventHash(world) {
  const h = new Hasher();
  for (const e of world.events ?? []) h.push(e.gen).push(':').push(e.kind).push(':').push(e.text ?? '').push('|');
  return h.hex;
}
