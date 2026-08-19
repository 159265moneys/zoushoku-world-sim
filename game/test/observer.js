// observer.js — 世界を毎世代なめて、検査器が食える最小のレコードだけを残す。
//
// ここが sim の内部表現を知る唯一の場所。検査器は observer の出力しか見ない。
// sim が形を変えたら直すのはこのファイル1本で済む。
//
// 遺伝子型の表現は2通りを吸収する：
//   src/sim   : ind.hap[染色体][0|1][遺伝子] = { v, d }   （d = 優性か）
//   fake-sim  : ind.geno[遺伝子] = [{ v, rec, load }, ...] （rec = 劣性か）

import { GENE_NAMES, GENES, CHROMOSOMES, MIND_GENES, KIND } from '../src/core/genes.js';
import { SKILLS } from '../src/core/model.js';
import { mean } from './lib/util.js';

const CHROM_GENES = (() => {
  const m = {};
  for (const ch of Object.keys(CHROMOSOMES)) m[ch] = [...CHROMOSOMES[ch].A, ...CHROMOSOMES[ch].B];
  return m;
})();

/** 個体から「遺伝子名 -> [{v,rec},{v,rec}]」を引く関数を返す。無ければ null。 */
export function genoView(ind) {
  if (ind?.hap) {
    return (name) => {
      const ch = GENES[name].ch;
      const row = ind.hap[ch];
      if (!row) return null;
      const a = row[0]?.[name], b = row[1]?.[name];
      if (!a || !b) return null;
      return [{ v: a.v, rec: !a.d }, { v: b.v, rec: !b.d }];
    };
  }
  if (ind?.geno) {
    return (name) => {
      const p = ind.geno[name];
      if (!p || p.length < 2) return null;
      return [{ v: p[0].v, rec: !!p[0].rec }, { v: p[1].v, rec: !!p[1].rec }];
    };
  }
  return null;
}

/** 追跡対象の心系遺伝子について 'h'=劣性ホモ(発現) 'c'=保因 '-'=非保有 '?'=不明 */
function zygCode(ind, tracked) {
  const g = genoView(ind);
  let s = '';
  for (const name of tracked) {
    const p = g?.(name);
    if (!p) { s += '?'; continue; }
    s += (p[0].rec && p[1].rec) ? 'h' : (p[0].rec || p[1].rec) ? 'c' : '-';
  }
  return s;
}

/** 心系の劣性ホモ率（＝潜伏していた形質が表に出ている割合）。近親交配の指標。 */
function recessiveHomoRate(ind) {
  const g = genoView(ind);
  if (!g) return null;
  let h = 0, n = 0;
  for (const name of MIND_GENES) {
    const p = g(name);
    if (!p) continue;
    n++;
    if (p[0].rec && p[1].rec) h++;
  }
  return n ? h / n : null;
}

/** 全座位のホモ接合率（値がほぼ同じ）。血の濃さ。 */
function valueHomozygosity(ind) {
  const g = genoView(ind);
  if (!g) return null;
  let same = 0, n = 0;
  for (const name of GENE_NAMES) {
    const p = g(name);
    if (!p) continue;
    n++;
    if (Math.abs(p[0].v - p[1].v) < 0.08 && p[0].rec === p[1].rec) same++;
  }
  return n ? same / n : null;
}

export class Observer {
  constructor(opts = {}) {
    this.trackedMind = opts.trackedMind ?? MIND_GENES.slice(0, 8);
    this.keepBirths = opts.keepBirths !== false;
    this.series = [];
    this.births = [];
    this.zygo = new Map();
    this.seen = new Set();
    this.caps = {
      geno: false, deathCause: false, battles: false,
      purgeLog: false, rebelLog: false, house: false, events: false, origin: false,
    };
    this.maxPop = 0;
    this.minPop = Infinity;
    this.finalCentroid = null;
    this.finalPop = 0;
  }

  /** 死因の内訳。戦死のうち運死が何割かも出す（設計は「ステ由来90% / 運10%」） */
  deathBreakdown(world) {
    const by = {};
    let total = 0, war = 0, luck = 0;
    for (const d of world.dead.values()) {
      const c = d.deathCause ?? '不明';
      by[c] = (by[c] ?? 0) + 1;
      total++;
      if (c === '戦死') { war++; if (d.deathByLuck) luck++; }
    }
    return { total, by, war, luck, luckRatio: war ? luck / war : null };
  }

  observe(world) {
    const people = [...world.people.values()];
    const n = people.length;
    this.maxPop = Math.max(this.maxPop, n);
    this.minPop = Math.min(this.minPop, n);

    const sample = people[0];
    if (sample && genoView(sample)) this.caps.geno = true;
    if (sample && (sample.house !== undefined)) this.caps.house = true;
    if (sample && (sample.origin !== undefined)) this.caps.origin = true;
    if (Array.isArray(world.battles) && world.battles.length) this.caps.battles = true;
    if (Array.isArray(world.purgeLog)) this.caps.purgeLog = true;
    if (Array.isArray(world.rebelLog)) this.caps.rebelLog = true;
    if (Array.isArray(world.events)) this.caps.events = true;

    // --- 初見の個体 ---
    for (const p of people) {
      if (this.seen.has(p.id)) continue;
      this.seen.add(p.id);
      if (this.caps.geno) {
        this.zygo.set(p.id, {
          gen: p.born ?? world.gen, f: p.fatherId, m: p.motherId,
          code: zygCode(p, this.trackedMind),
        });
      }
      if (!this.keepBirths) continue;
      const dad = lookup(world, p.fatherId), mom = lookup(world, p.motherId);
      if (!dad || !mom) continue;                 // 創世個体は親がいない
      this.births.push(birthRecord(p, dad, mom));
    }

    // --- 集計 ---
    const g = {};
    for (const name of GENE_NAMES) {
      let s = 0; for (const p of people) s += p.genes?.[name] ?? 0;
      g[name] = n ? s / n : 0;
    }
    let homo = 0, hz = 0, hn = 0, foreign = 0;
    for (const p of people) {
      const r = recessiveHomoRate(p);
      if (r != null) { homo += r; hn++; }
      const v = valueHomozygosity(p);
      if (v != null) hz += v;
      if (p.foreign || (p.origin && p.origin !== (world.originKey ?? 'home'))) foreign++;
    }
    homo = hn ? homo / hn : 0;
    hz = hn ? hz / hn : 0;

    const skills = {};
    for (const k of SKILLS) { let s = 0; for (const p of people) s += p.skills?.[k] ?? 0; skills[k] = n ? s / n : 0; }

    this.series.push({
      gen: world.gen, tick: world.tick, pop: n,
      food: world.food ?? 0, yieldRate: world.yieldRate ?? 0, consumption: world.consumption ?? 0,
      morale: world.morale ?? 0, regimeGrudge: world.regimeGrudge ?? 0,
      genes: g, homo, hz, foreignFrac: n ? foreign / n : 0, skills,
      purges: countEvents(world, ['粛清', 'purge']),
      rebels: countEvents(world, ['一揆', '謀反', 'rebellion']),
      collapsing: !!world.collapsing,
    });
    if (n) this.finalCentroid = GENE_NAMES.map(k => g[k]);
    this.finalPop = n;
  }
}

/** その世代に起きた事件の件数（sim が専用ログを持っていなくても年代記から数える） */
function countEvents(world, kinds) {
  if (Array.isArray(world.purgeLog) && kinds.includes('purge')) return world.purgeLog[world.gen] ?? 0;
  if (!Array.isArray(world.events)) return 0;
  let c = 0;
  for (let i = world.events.length - 1; i >= 0; i--) {
    const e = world.events[i];
    if (e.gen < world.gen) break;
    if (e.gen === world.gen && kinds.includes(e.kind)) c++;
  }
  return c;
}

function lookup(world, id) {
  if (id == null) return null;
  return world.people.get(id) ?? world.dead?.get?.(id) ?? null;
}

/**
 * 連鎖検査の中身：
 *   minMargin = min_g ( child[g] - max(dad[g], mom[g]) )。>0 なら全ステで親2人を上回った＝失敗。
 *   chromDom  = 染色体単位で全座位が親2人を上回った本数
 *   above     = 親2人を上回った座位の数（0だと逆に変異が死んでいる）
 */
function birthRecord(child, dad, mom) {
  let minMargin = Infinity, above = 0, best = -Infinity;
  for (const g of GENE_NAMES) {
    const c = child.genes?.[g] ?? 0;
    const p = Math.max(dad.genes?.[g] ?? 0, mom.genes?.[g] ?? 0);
    const d = c - p;
    if (d < minMargin) minMargin = d;
    if (d > 0) above++;
    if (d > best) best = d;
  }
  let chromDom = 0;
  for (const ch of Object.keys(CHROM_GENES)) {
    if (CHROM_GENES[ch].length < 2) continue;     // 可塑は独立座位なので対象外
    let all = true;
    for (const g of CHROM_GENES[ch]) {
      const c = child.genes?.[g] ?? 0;
      const p = Math.max(dad.genes?.[g] ?? 0, mom.genes?.[g] ?? 0);
      if (c <= p) { all = false; break; }
    }
    if (all) chromDom++;
  }
  const ps = [], cs = [];
  for (const k of SKILLS) {
    ps.push(((dad.skills?.[k] ?? 0) + (mom.skills?.[k] ?? 0)) / 2);
    cs.push(child.skills?.[k] ?? 0);
  }
  return {
    gen: child.born, id: child.id,
    minMargin, above, best, chromDom,
    parentSkill: mean(ps), childSkill: mean(cs),
    parentSkillMax: Math.max(...ps), childSkillMax: Math.max(...cs),
  };
}

export { CHROM_GENES, zygCode, recessiveHomoRate };
