// ============================================================================
// fake-sim.js — src/sim/ がまだ無い間の代替実装。
//
// 目的は「本物のsimの代わり」ではなく、**ランナーと検査器を先に完成させ、
// 検査器が何をsimに要求しているかをコードで示すこと**。
// src/sim/ が生えたら sim-adapter.js が自動でそちらを使う。
//
// 設計文書のどこを実装したか：
//   遺伝システム ①連鎖群 ②心系=優劣/体系=中間 ③可塑=交叉率 ④発現
//   欲求と動機   大罪 = 既存遺伝子 × 感受性（8番）
//   収束を防ぐ4装置 のうち 連鎖・頻度依存
//   戦死の内訳   ステータス由来90% / 運10%
//   10国ロスター（SPEC「対戦相手：10国のライバル・ロスター」）
//
// 絶対規則：Math.random() を書かない。Date.now() を見ない。
// ============================================================================

import { RNG } from '../src/core/rng.js';
import { GENE_NAMES, GENES, CHROMOSOMES, MIND_GENES, KIND } from '../src/core/genes.js';
import {
  makeIndividual, makeVillage, makeEvent,
  ROLE, DISTRICT, SKILLS, PHASE, BUREAU,
} from '../src/core/model.js';
import { NameGiver, FOUNDERS } from '../src/core/names.js';
import { clamp, clamp01 } from './lib/util.js';

export const IMPL = 'fake-sim';
export const TICKS_PER_GEN = 8;

// 染色体ごとの座位順。A腕を先に、B腕を後に並べる。
// 交叉は「隣接座位間で鎖を乗り換える」ので、腕の境界での組換えが主になる。
const CHROM_ORDER = (() => {
  const m = {};
  for (const ch of Object.keys(CHROMOSOMES)) {
    m[ch] = [...CHROMOSOMES[ch].A, ...CHROMOSOMES[ch].B];
  }
  return m;
})();
// 可塑は独立座位（ch 0）。ここだけ腕予算の正規化から外す。
const NORMALIZED_CHROMS = Object.keys(CHROM_ORDER).filter(ch => ch !== '0');

// 潜伏の観測対象にする心系遺伝子。全部見ると読めないので8本に絞る。
export const TRACKED_MIND = ['従順', '保身', '非情', '懐疑', '私欲', '他責', '団結傾向', '情愛'];

const MUT_RATE = 0.006;      // 座位あたり変異率
const REC_FLIP = 0.15;       // 変異時に優劣が入れ替わる確率
const AGE_ADULT = 3;
const TARGET_POP = 78;
const HARD_CAP = 600;        // これを超えたら人口爆発。不変条件で落とす

// ---------------------------------------------------------------------------
// 10国のライバル・プロファイル（SPEC「10の経営思想」）
// ---------------------------------------------------------------------------
export const RIVAL_PROFILES = {
  martial: {
    name: '武断', label: 'martial',
    roles: { farm: 0.28, hunt: 0.26, drill: 0.22, war: 0.20, idle: 0.04 },
    warRate: 0.85, surrenderAt: 0.02, captive: 'mixed',
    purge: 0.010, transmission: 0.55, fecundity: 1.00,
    select: { 攻撃素質: 1.6, 胆力: 1.2, 頑健: 0.9, 統率素質: 0.7, 好奇心: -0.5, 知性: -0.4 },
  },
  agrarian: {
    name: '農本', label: 'agrarian',
    roles: { farm: 0.66, hunt: 0.14, drill: 0.10, war: 0.06, idle: 0.04 },
    warRate: 0.18, surrenderAt: 0.35, captive: 'accept',
    purge: 0.004, transmission: 0.60, fecundity: 1.05,
    select: { 勤勉: 1.5, 器用: 1.2, 共同作業適性: 1.0, 技術習得: 0.8, 攻撃素質: -0.6 },
  },
  fecund: {
    name: '多産', label: 'fecund',
    roles: { farm: 0.50, hunt: 0.16, drill: 0.12, war: 0.12, idle: 0.10 },
    warRate: 0.40, surrenderAt: 0.30, captive: 'accept',
    purge: 0.004, transmission: 0.50, fecundity: 1.55,
    select: { 繁殖性: 1.9, 情愛: 0.8, 代謝: 0.5, 器用: -0.4, 知性: -0.3 },
  },
  purist: {
    name: '純血', label: 'purist',
    roles: { farm: 0.46, hunt: 0.18, drill: 0.16, war: 0.14, idle: 0.06 },
    warRate: 0.50, surrenderAt: 0.10, captive: 'kill',
    purge: 0.012, transmission: 0.25, fecundity: 0.95,
    select: { 従順: 1.1, 序列意識: 0.9, 頑迷: 0.8, 柔軟: -0.7, 好奇心: -0.5 },
  },
  melting: {
    name: '融和', label: 'melting',
    roles: { farm: 0.48, hunt: 0.16, drill: 0.14, war: 0.14, idle: 0.08 },
    warRate: 0.50, surrenderAt: 0.30, captive: 'accept',
    purge: 0.003, transmission: 0.75, fecundity: 1.05,
    select: { 柔軟: 1.3, 共同作業適性: 1.0, 好奇心: 0.7, 頑迷: -0.9, 序列意識: -0.5 },
  },
  terror: {
    name: '恐怖', label: 'terror',
    roles: { farm: 0.44, hunt: 0.16, drill: 0.18, war: 0.16, idle: 0.06 },
    warRate: 0.55, surrenderAt: 0.08, captive: 'kill',
    purge: 0.075, transmission: 0.45, fecundity: 1.00,
    select: { 従順: 2.0, 保身: 1.1, 野心: -1.6, 誇り: -1.0, 自律: -0.8 },
  },
  laissez: {
    name: '放任', label: 'laissez',
    roles: { farm: 0.34, hunt: 0.12, drill: 0.08, war: 0.10, idle: 0.36 },
    warRate: 0.30, surrenderAt: 0.45, captive: 'mixed',
    purge: 0.001, transmission: 0.50, fecundity: 1.05,
    select: {},
  },
  pious: {
    name: '信仰', label: 'pious',
    roles: { farm: 0.50, hunt: 0.14, drill: 0.16, war: 0.12, idle: 0.08 },
    warRate: 0.45, surrenderAt: 0.20, captive: 'reject',
    purge: 0.014, transmission: 0.40, fecundity: 1.15,
    select: { 信仰性: 1.9, 団結傾向: 1.4, 懐疑: -1.5, 自律: -0.9, 好奇心: -0.6 },
  },
  merit: {
    name: '実力主義', label: 'merit',
    roles: { farm: 0.46, hunt: 0.16, drill: 0.16, war: 0.14, idle: 0.08 },
    warRate: 0.45, surrenderAt: 0.25, captive: 'accept',
    purge: 0.006, transmission: 1.00, fecundity: 1.00,
    select: { 知性: 1.3, 技術習得: 1.1, 統率素質: 1.0, 器用: 0.8, 従順: -0.4 },
  },
  dynastic: {
    name: '世襲', label: 'dynastic',
    roles: { farm: 0.48, hunt: 0.16, drill: 0.14, war: 0.14, idle: 0.08 },
    warRate: 0.45, surrenderAt: 0.25, captive: 'mixed',
    purge: 0.008, transmission: 0.00, fecundity: 1.00,
    select: { 序列意識: 1.2, 世代間伝承意欲: 1.0, 従順: 0.6, 柔軟: -0.5 },
  },
};
export const RIVAL_IDS = Object.keys(RIVAL_PROFILES);

const DEFAULT_PROFILE = {
  name: '既定', label: 'balanced',
  roles: { farm: 0.48, hunt: 0.16, drill: 0.14, war: 0.14, idle: 0.08 },
  warRate: 0.45, surrenderAt: 0.25, captive: 'mixed',
  purge: 0.006, transmission: 0.55, fecundity: 1.0,
  select: {},
};

// ---------------------------------------------------------------------------
// サボタージュ：検査器がちゃんと落ちることを確かめるための故意のバグ。
// run.js --selftest がこれを使って「検査が空振りでない」ことを証明する。
// ---------------------------------------------------------------------------
export const SABOTAGE = {
  none: {},
  linkage: { noArmBudget: true },            // 腕予算を外す → 連鎖の保証が消える
  'heritable-skill': { skillHeritability: 0.6 }, // 練度を遺伝させる
  'no-nfd': { noFrequencyDependence: true }, // 頻度依存を外す
  luck50: { luckShare: 0.5 },                // 運死を50%に
  'no-recessive': { blendMind: true },       // 心系を中間遺伝にする（潜伏が消える）
  'uniform-policy': { uniformPolicy: true }, // 全プロファイルを同一挙動に
};

function cfgOf(opts) {
  const s = SABOTAGE[opts.sabotage ?? 'none'] ?? {};
  return {
    noArmBudget: false,
    skillHeritability: 0,
    noFrequencyDependence: false,
    luckShare: 0.10,          // 設計文書：戦死のうち運は10%
    blendMind: false,
    uniformPolicy: false,
    ...s,
  };
}

// ===========================================================================
// ゲノム
// ===========================================================================

function newAllele(rng, bias, kind, cfg) {
  const v = clamp01(rng.clampNormal(bias, 0.17, 0, 1));
  if (kind !== KIND.MIND || cfg.blendMind) return { v, rec: false, load: 0 };
  const rec = rng.bool(0.45);
  // 劣性アレルにだけ遺伝的荷重を載せる。ホモになったときだけ効く＝近親交配ペナルティ。
  const load = rec ? (rng.bool(0.28) ? rng.range(0.15, 0.9) : 0) : 0;
  return { v, rec, load };
}

function makeGenome(rng, bias, cfg) {
  const geno = {};
  for (const g of GENE_NAMES) {
    const b = clamp01(bias?.[g] ?? 0.5);
    geno[g] = [newAllele(rng, b, GENES[g].kind, cfg), newAllele(rng, b, GENES[g].kind, cfg)];
  }
  return geno;
}

/** 表現型。心系は優劣（優性が劣性を隠す）、体系は中間遺伝。 */
function rawExpress(geno, cfg) {
  const out = {};
  for (const g of GENE_NAMES) {
    const [x, y] = geno[g];
    if (GENES[g].kind === KIND.BODY || cfg.blendMind) {
      out[g] = (x.v + y.v) / 2;                 // 中間遺伝
    } else if (x.rec === y.rec) {
      out[g] = (x.v + y.v) / 2;                 // 同型（優性ホモ / 劣性ホモ）
    } else {
      out[g] = x.rec ? y.v : x.v;               // 優性が劣性を隠す＝潜伏
    }
  }
  return out;
}

/** 劣性ホモで初めて出る遺伝的荷重。近親交配で溜まり、雑種強勢で薄まる。 */
function geneticLoad(geno) {
  let s = 0, n = 0;
  for (const g of MIND_GENES) {
    const [x, y] = geno[g];
    n++;
    if (x.rec && y.rec) s += (x.load + y.load) / 2;
  }
  return n ? s / n : 0;
}

/** 追跡対象心系の接合状態。'h'=劣性ホモ(発現) 'c'=保因 '-'=非保有 */
function zygosityCode(geno) {
  let s = '';
  for (const g of TRACKED_MIND) {
    const [x, y] = geno[g];
    s += (x.rec && y.rec) ? 'h' : (x.rec || y.rec) ? 'c' : '-';
  }
  return s;
}
function homozygosity(geno) {
  let h = 0;
  for (const g of TRACKED_MIND) { const [x, y] = geno[g]; if (x.rec && y.rec) h++; }
  return h / TRACKED_MIND.length;
}

/**
 * 腕予算。染色体ごとに表現型の総和を定数に固定する。
 * これで「同じ染色体の全座位で親を上回る」が構造的に不可能になる＝連鎖の保証。
 * 設計文書：「確率ではなく構造で保証される」
 */
function applyArmBudget(raw, cfg) {
  if (cfg.noArmBudget) {
    const out = {};
    for (const g of GENE_NAMES) out[g] = clamp01(raw[g]);
    return out;
  }
  const out = {};
  out['可塑'] = clamp01(raw['可塑']);
  for (const ch of NORMALIZED_CHROMS) {
    const gs = CHROM_ORDER[ch];
    const target = gs.length * 0.5;
    let v = gs.map(g => Math.max(0, raw[g]));
    // 総和 target・各要素 0..1 の単体に water-fill で射影する
    for (let pass = 0; pass < 6; pass++) {
      const free = [];
      let fixed = 0, freeSum = 0;
      for (let i = 0; i < v.length; i++) {
        if (v[i] >= 1 - 1e-12) fixed += 1; else { free.push(i); freeSum += v[i]; }
      }
      const need = target - fixed;
      if (need <= 1e-12 || !free.length) break;
      const k = freeSum > 1e-12 ? need / freeSum : 0;
      let done = true;
      for (const i of free) {
        const nv = freeSum > 1e-12 ? v[i] * k : need / free.length;
        if (nv > 1) { v[i] = 1; done = false; } else v[i] = nv;
      }
      if (done) break;
    }
    for (let i = 0; i < gs.length; i++) out[gs[i]] = clamp01(v[i]);
  }
  return out;
}

function expressAll(ind, cfg) {
  ind.genes = applyArmBudget(rawExpress(ind.geno, cfg), cfg);
  ind.load = geneticLoad(ind.geno);
  return ind;
}

/** 減数分裂。可塑の表現型がそのまま隣接座位間の組換え率になる（設計文書③）。 */
function meiosis(parent, rng, cfg) {
  const cr = clamp(0.02 + 0.45 * parent.genes['可塑'], 0.01, 0.5);
  const gam = {};
  for (const ch of Object.keys(CHROM_ORDER)) {
    let strand = rng.int(2);
    const order = CHROM_ORDER[ch];
    for (let i = 0; i < order.length; i++) {
      if (i > 0 && rng.next() < cr) strand ^= 1;
      const g = order[i];
      let a = parent.geno[g][strand];
      if (rng.next() < MUT_RATE) {
        a = {
          v: clamp01(a.v + rng.normal(0, 0.09)),
          rec: (GENES[g].kind === KIND.MIND && !cfg.blendMind)
            ? (rng.next() < REC_FLIP ? !a.rec : a.rec) : false,
          load: a.load,
        };
        if (a.rec && a.load === 0 && rng.next() < 0.12) a.load = rng.range(0.1, 0.8);
      }
      gam[g] = a;
    }
  }
  return gam;
}

// ===========================================================================
// 導出層（欲求と動機：大罪 = 既存遺伝子 × 感受性）
// ===========================================================================

export function derive(ind) {
  const g = ind.genes, s = ind.skills;
  const sens = g['感受性'];
  const amp = 0.4 + 0.6 * sens;             // 8番＝振れ幅。ほぼ全部の乗数
  return {
    傲慢: g['誇り'] * g['野心'] * amp,
    強欲: g['私欲'] * amp,
    嫉妬: g['序列意識'] * amp,
    憤怒: g['他責'] * amp,
    色欲: g['繁殖性'] * amp,
    暴食: g['代謝'] * amp,
    怠惰: (1 - g['勤勉']) * amp,
    // 逃走は遺伝子ではなく導出（設計文書「導出に降格した旧遺伝子」）
    逃走: clamp01((1 - g['胆力']) * amp * (1 - 0.7 * s['恐怖耐性'])),
    裏切り: clamp01(sens * g['知性'] * g['野心'] * (1 - g['従順'])),
    被扇動: clamp01(sens * (1 - g['知性'])),
  };
}

// 発現ゲート（設計文書④）。幼少期にその局面に置かれていないと素質は開かない。
function expr(ind, gene) {
  return ind.expressed[gene] ? 1 : 0.45;
}
function eff(ind, gene, skill) {
  const sk = skill ? ind.skills[skill] : 0;
  return ind.genes[gene] * expr(ind, gene) * (0.3 + 0.7 * sk);
}

function farmPower(ind) {
  return 0.35 * eff(ind, '器用', '農技') + 0.35 * eff(ind, '勤勉', '農技')
       + 0.30 * eff(ind, '共同作業適性', '農技');
}
function warPower(ind) {
  return 0.45 * eff(ind, '攻撃素質', '戦技') + 0.30 * eff(ind, '胆力', '恐怖耐性')
       + 0.25 * eff(ind, '頑健', null);
}

// ===========================================================================
// 世界
// ===========================================================================

export function createWorld(seed, answers = {}) {
  const cfg = cfgOf(answers);
  const prof = answers.profile
    ? (cfg.uniformPolicy ? { ...DEFAULT_PROFILE, label: answers.profile } : RIVAL_PROFILES[answers.profile] ?? DEFAULT_PROFILE)
    : DEFAULT_PROFILE;
  const rng = new RNG((seed >>> 0) || 1);
  const w = makeVillage();
  w.seed = (seed >>> 0) || 1;
  w.cfg = cfg;
  w.profileId = answers.profile ?? 'balanced';
  w.profile = prof;
  w.closed = !!answers.closed;                    // 閉じた血統（近親交配テスト）
  w.outsideBlood = answers.outsideBlood ?? null;  // 外来血の注入率。null=プロファイル任せ
  w.names = new NameGiver(rng);
  w.events = [];
  w.nextEventId = 1;
  w.wars = 0; w.battles = [];
  w.purgeLog = [];        // gen -> 粛清人数
  w.rebelLog = [];        // gen -> 謀反件数
  w.bureauLog = [];       // 局長の出自（名家か無名か）
  w.prestige = new Map(); // 家系id -> 名家度
  w.deathTally = { war_stat: 0, war_luck: 0, famine: 0, age: 0, purge: 0, rebellion: 0, wound: 0 };
  w.foreignPool = 0;      // 受け入れた外来個体の累計
  w.killedCaptives = 0;

  // 創世の二匹。MBTI回答は心系遺伝子だけを設定する（設計文書「第1フェーズ」）。
  const bias = answers.mind ?? {};
  for (let i = 0; i < 2; i++) {
    const ind = spawn(w, rng, {
      name: FOUNDERS[i], sex: i, age: AGE_ADULT + 1,
      geno: makeGenome(rng, bias, cfg),
      lineage: { [`f${i}`]: 1 },
    });
    ind.founder = true;
    ind.house = `H${ind.id}`;
  }
  recompute(w);
  return w;
}

function spawn(w, rng, o) {
  const id = w.nextId++;
  const ind = makeIndividual(id, o.name ?? w.names.take(), {
    born: w.gen, age: o.age ?? 0, sex: o.sex ?? rng.int(2),
    fatherId: o.fatherId ?? null, motherId: o.motherId ?? null,
    lineage: o.lineage ?? { self: 1 },
  });
  ind.geno = o.geno;
  ind.house = o.house ?? `H${id}`;
  ind.foreign = !!o.foreign;
  ind.warsFought = 0; ind.fled = 0; ind.merit = 0;
  expressAll(ind, w.cfg);
  if (o.skills) for (const k of SKILLS) ind.skills[k] = clamp01(o.skills[k] ?? 0);
  ind.role = (ind.age < AGE_ADULT) ? ROLE.CHILD : ROLE.IDLE;
  w.people.set(id, ind);
  return ind;
}

function emit(w, kind, o = {}) {
  const e = makeEvent(w.nextEventId++, w.gen, kind, o);
  w.events.push(e);
  if (w.events.length > 4000) w.events.splice(0, 1000); // 年代記の間引き
  return e;
}

function recompute(w) {
  let cons = 0, yield_ = 0;
  // 産出と消費の釣り合い。素質が未発現・練度0の初期状態でも、
  // 働き手が半分いれば黒字になるところから始める（そうしないと村が必ず餓死する）。
  for (const p of w.people.values()) {
    cons += (p.age < AGE_ADULT ? 0.30 : 0.55) + 0.25 * p.genes['代謝'];
    if (p.role === ROLE.FARM) yield_ += 3.6 * (0.35 + 0.65 * farmPower(p));
    else if (p.role === ROLE.HUNT) yield_ += 2.4 * (0.35 + 0.65 * (0.5 * farmPower(p) + 0.5 * warPower(p)));
  }
  const n = w.people.size;
  w.density = n / TARGET_POP;
  w.consumption = cons * (1 + 0.16 * Math.max(0, w.density - 1));
  // 私欲の横領。増えるほど産出が落ちる＝頻度依存の経路（設計文書「私欲・横領」）
  const greed = avgGene(w, '私欲');
  w.leak = w.cfg.noFrequencyDependence ? 0 : clamp01(greed * greed * 0.55);
  w.yieldRate = yield_ * (1 - w.leak);
  w.phase = n >= 10 ? PHASE.TRIBE : PHASE.VILLAGE;
}

function avgGene(w, g) {
  let s = 0, n = 0;
  for (const p of w.people.values()) { s += p.genes[g]; n++; }
  return n ? s / n : 0.5;
}

// ---------------------------------------------------------------------------
// tick：生産と消費だけ。歴史の粒度は世代。
// ---------------------------------------------------------------------------
export function stepTick(world, rng) {
  const ev = [];
  world.tick++;
  recompute(world);
  const dt = 1 / TICKS_PER_GEN;
  world.food += (world.yieldRate - world.consumption) * dt;
  if (world.food > 4000) world.food = 4000;    // 備蓄上限。無限増殖を止める
  if (world.food < -200) world.food = -200;
  for (const p of world.people.values()) {
    const d = derive(p);
    p.fatigue = clamp01(p.fatigue + dt * (p.role === ROLE.IDLE ? -0.10 : 0.06 * (1 - 0.5 * d.怠惰)) );
    p.unmet = clamp01(0.55 * d.強欲 * (1 - clamp01(world.food / 120))
                    + 0.25 * d.傲慢 * (p.titles.length ? 0 : 1)
                    + 0.20 * d.嫉妬);
  }
  // 不満が民心の基底になる（設計文書「不満が民心の基底になる」）
  let unmet = 0;
  for (const p of world.people.values()) unmet += p.unmet;
  const n = world.people.size || 1;
  const base = 1 - clamp01(unmet / n) - clamp01(world.regimeGrudge / 60);
  world.morale = clamp01(world.morale + dt * 0.5 * (clamp01(base) - world.morale));
  world.collapsing = world.yieldRate < world.consumption && world.food <= 0;
  return ev;
}

// ---------------------------------------------------------------------------
// 世代送り
// ---------------------------------------------------------------------------
export function advanceGeneration(world, rng) {
  const ev = [];
  world.gen++;
  const prof = world.profile;
  const cfg = world.cfg;

  ageAndDie(world, rng, ev);
  appointBureaus(world, rng, ev);
  doPurge(world, rng, ev);
  doRebellion(world, rng, ev);
  assignRoles(world, rng);
  growSkills(world, rng);
  recompute(world);
  if (rng.next() < prof.warRate && adultsOf(world).length >= 4) doWar(world, rng, ev);
  famine(world, rng, ev);
  breed(world, rng, ev);
  recompute(world);

  world.regimeGrudge = Math.max(0, world.regimeGrudge * 0.94);
  world.purgeLog[world.gen] = world.purgeLog[world.gen] ?? 0;
  world.rebelLog[world.gen] = world.rebelLog[world.gen] ?? 0;
  return ev;
}

function adultsOf(w) {
  const a = [];
  for (const p of w.people.values()) if (p.age >= AGE_ADULT) a.push(p);
  return a;
}

function kill(w, p, cause, ev, extra = {}) {
  if (!p.alive) return;
  p.alive = false;
  p.deathGen = w.gen;
  p.deathCause = cause;                       // 'war:stat' / 'war:luck' / 'famine' / ...
  w.people.delete(p.id);
  w.dead.set(p.id, p);
  if (w.dead.size > 3000) {                   // 記録方針に従って間引く
    const it = w.dead.keys();
    for (let i = 0; i < 800; i++) { const k = it.next().value; if (k === undefined) break; w.dead.delete(k); }
  }
  const tallyKey = cause.replace(':', '_');
  w.deathTally[tallyKey] = (w.deathTally[tallyKey] ?? 0) + 1;
  if (ev) emit(w, 'death', { target: p.id, text: cause, ...extra });
}

function ageAndDie(w, rng, ev) {
  for (const p of [...w.people.values()]) {
    p.age++;
    // 荷重（劣性ホモ）が寿命を削る。近親交配ペナルティの本体。
    const span = 7 + 9 * p.genes['寿命'] + 2.5 * p.genes['頑健'] - 5 * p.load;
    if (p.age > span || (p.age > span * 0.75 && rng.next() < 0.18)) kill(w, p, 'age', ev);
    else if (p.wounded && rng.next() < 0.06) kill(w, p, 'wound', ev);
  }
}

// ---- 局長の任命：透過率が merit / dynastic の差を作る -----------------------
function appointBureaus(w, rng, ev) {
  const adults = adultsOf(w).filter(p => p.age >= AGE_ADULT + 1);
  if (adults.length < 6) return;
  const t = w.cfg.uniformPolicy ? 0.55 : w.profile.transmission;
  const chosen = new Set();
  for (const b of [BUREAU.MILITARY, BUREAU.AGRI, BUREAU.CIVIL]) {
    let best = null, bestScore = -Infinity;
    for (const p of adults) {
      if (chosen.has(p.id)) continue;
      const meritScore = b === BUREAU.MILITARY ? warPower(p)
        : b === BUREAU.AGRI ? farmPower(p)
        : 0.5 * eff(p, '知性', '統率') + 0.5 * eff(p, '統率素質', '統率');
      const house = w.prestige.get(p.house) ?? 0;
      // 透過率1.0＝家柄無視の純実力、0.0＝家柄だけ
      const score = t * meritScore + (1 - t) * clamp01(house / 4) + rng.next() * 0.03;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) continue;
    chosen.add(best.id);
    best.bureau = b;
    w.bureaus[b] = best.id;
    const houseRank = w.prestige.get(best.house) ?? 0;
    w.bureauLog.push({ gen: w.gen, bureau: b, id: best.id, house: best.house, houseRank, noble: houseRank >= 1 });
    if (w.bureauLog.length > 6000) w.bureauLog.splice(0, 2000);
    w.prestige.set(best.house, houseRank + 1);
    emit(w, 'appoint', { actor: best.id, text: b });
  }
}

// ---- 粛清（terror）：3世代後に謀反として返る -------------------------------
function doPurge(w, rng, ev) {
  const rate = w.cfg.uniformPolicy ? 0.006 : w.profile.purge;
  const adults = adultsOf(w);
  const n = adults.length;
  let count = 0;
  const want = Math.floor(n * rate) + (rng.next() < (n * rate) % 1 ? 1 : 0);
  if (want > 0) {
    // 野心が高く従順が低い個体から狙う（設計文書「粛清」）
    const ranked = adults.map(p => ({ p, s: p.genes['野心'] * (1 - p.genes['従順']) + rng.next() * 0.15 }))
      .sort((a, b) => b.s - a.s);
    for (let i = 0; i < Math.min(want, ranked.length); i++) {
      const victim = ranked[i].p;
      const e = emit(w, 'purge', { actor: w.bureaus.military, target: victim.id, text: '粛清' });
      kill(w, victim, 'purge', null);
      count++;
      // 体制怨恨は消えず、家系に継承される
      w.regimeGrudge += 1.2;
      for (const p of w.people.values()) {
        if (p.house === victim.house) { p.grudges[0] = (p.grudges[0] ?? 0) + 1.6; }
        else if (p.genes['情愛'] > 0.6) p.grudges[0] = (p.grudges[0] ?? 0) + 0.25;
      }
      w.lastPurgeEvent = e.id;
    }
  }
  w.purgeLog[w.gen] = count;
}

function doRebellion(w, rng, ev) {
  // 3世代前の粛清が主因になるように重みを置く（設計文書「3世代後の謀反」）
  const g = w.gen;
  const p3 = w.purgeLog[g - 3] ?? 0, p2 = w.purgeLog[g - 2] ?? 0, p1 = w.purgeLog[g - 1] ?? 0;
  const n = Math.max(1, w.people.size);
  const pressure = (0.55 * p3 + 0.25 * p2 + 0.10 * p1) / n;
  let personal = 0;
  for (const p of w.people.values()) {
    const d = derive(p);
    personal += (p.grudges[0] ?? 0) * d.裏切り;
  }
  const prob = clamp01(pressure * 3.2 + (personal / n) * 0.5 + w.regimeGrudge / 400);
  let count = 0;
  if (rng.next() < prob) {
    count = 1;
    const rebels = adultsOf(w).filter(p => (p.grudges[0] ?? 0) > 0.5 || derive(p).裏切り > 0.35);
    emit(w, 'rebellion', {
      actor: rebels[0]?.id ?? null,
      trueCause: w.lastPurgeEvent ?? null,          // 真の原因＝上流の粛清event id
      claimed: '外敵の扇動',                          // 局長が報告した帰属（歪む側）
      text: `謀反 rebels=${rebels.length}`,
    });
    w.morale = clamp01(w.morale - 0.18);
    for (let i = 0; i < Math.min(3, rebels.length); i++) {
      if (rng.next() < 0.5) kill(w, rebels[i], 'rebellion', null);
    }
  }
  w.rebelLog[w.gen] = count;
}

// ---- 配役 ------------------------------------------------------------------
function assignRoles(w, rng) {
  const roles = w.cfg.uniformPolicy ? DEFAULT_PROFILE.roles : w.profile.roles;
  const keys = [ROLE.FARM, ROLE.HUNT, ROLE.DRILL, ROLE.WAR, ROLE.IDLE];
  const wts = [roles.farm, roles.hunt, roles.drill, roles.war, roles.idle];
  const total = wts.reduce((a, b) => a + b, 0);
  for (const p of w.people.values()) {
    if (p.age < AGE_ADULT) { p.role = ROLE.CHILD; continue; }
    let r = rng.next() * total, i = 0;
    while (i < wts.length - 1 && r > wts[i]) { r -= wts[i]; i++; }
    // 怠惰は仕事から降りる（産出低下という害、疲労なしという出力）
    const d = derive(p);
    if (!w.cfg.noFrequencyDependence && d.怠惰 > 0.62 && rng.next() < d.怠惰 * 0.55) p.role = ROLE.IDLE;
    else p.role = keys[i];
    // 発現ウィンドウ：幼少期に置かれた局面の素質だけが開く
    if (p.age === AGE_ADULT) {
      const open = p.role === ROLE.FARM ? ['器用', '勤勉', '共同作業適性', '技術習得']
        : p.role === ROLE.WAR || p.role === ROLE.DRILL ? ['攻撃素質', '胆力', '頑健', '統率素質']
        : p.role === ROLE.HUNT ? ['攻撃素質', '器用', '感応', '頑健']
        : ['好奇心', '知性'];
      for (const g of open) p.expressed[g] = true;
    }
  }
}

function growSkills(w, rng) {
  for (const p of w.people.values()) {
    const learn = 0.05 + 0.28 * p.genes['技術習得'] * (0.4 + 0.6 * p.genes['勤勉']);
    const env = p.district === DISTRICT.FRONTIER ? 1.25 : 1.0;  // 才能の産地は辺境
    const add = (k, amt) => { p.skills[k] = clamp01(p.skills[k] + amt * learn * env); };
    switch (p.role) {
      case ROLE.FARM: add('農技', 1.0); break;
      case ROLE.HUNT: add('狩技', 1.0); add('戦技', 0.35); add('恐怖耐性', 0.20); break;
      case ROLE.DRILL: add('戦技', 0.8); add('恐怖耐性', 0.30); add('統率', 0.25); break;
      case ROLE.WAR: add('戦技', 0.5); break; // 実戦分は doWar 側で厚く付く
      default: break;
    }
    if (p.bureau) add('統率', 0.5);
  }
}

// ---- 戦争 ------------------------------------------------------------------
export function makeGhost(seed, gen, power = 1) {
  const rng = new RNG(((seed >>> 0) ^ Math.imul(gen + 1, 2246822519)) >>> 0);
  return {
    id: `ghost-${seed}-${gen}`,
    size: 4 + rng.int(14),
    power: clamp(power * rng.range(0.7, 1.35), 0.15, 3),
    cohesion: rng.range(0.4, 0.95),
  };
}

export function startWar(world, rng, ghost) {
  const army = [];
  for (const p of world.people.values()) if (p.role === ROLE.WAR) army.push(p);
  return { world, ghost: ghost ?? makeGhost(world.seed, world.gen), army, round: 0, cohesion: 1, routed: false, over: false };
}

/** 戦闘は個体単位。勝敗は殲滅ではなく団結が折れる崩壊で決める。 */
export function stepBattle(battle, rng) {
  const { world, army } = battle;
  battle.round++;
  const cfg = world.cfg;
  // 統率の底上げ（統率98・武力30の男が最重要人物になる経路）
  let lead = 0;
  for (const p of army) lead = Math.max(lead, eff(p, '統率素質', '統率'));
  let unity = 0;
  for (const p of army) unity += p.genes['団結傾向'];
  unity = (army.length ? unity / army.length : 0.5) + 0.45 * lead;

  let fleeing = 0;
  for (const p of army) {
    if (p._fled) { fleeing++; continue; }
    const d = derive(p);
    const fear = d.逃走 * (1 - 0.5 * unity) * (0.6 + 0.5 * battle.round / 3);
    if (rng.next() < fear * 0.55) { p._fled = true; fleeing++; }
  }
  const fleeFrac = army.length ? fleeing / army.length : 0;
  battle.fleeFrac = fleeFrac;
  // 逃走が増えるほど陣形が崩れる。頻度依存の本体。
  battle.cohesion -= 0.18 + (cfg.noFrequencyDependence ? 0.15 * fleeFrac : 1.35 * fleeFrac * fleeFrac) - 0.10 * unity;
  if (battle.cohesion <= 0) { battle.routed = true; battle.over = true; }
  if (battle.round >= 6) battle.over = true;
  return battle;
}

export function surrender(battle) { battle.over = true; battle.surrendered = true; return battle; }

function doWar(world, rng, ev) {
  const battle = startWar(world, rng);
  if (battle.army.length < 2) return;
  world.wars++;
  const prof = world.cfg.uniformPolicy ? DEFAULT_PROFILE : world.profile;
  while (!battle.over) {
    stepBattle(battle, rng);
    // サレンダーはオーナー裁定。プロファイルが閾値を持つ。
    if (!battle.over && battle.cohesion < prof.surrenderAt) { surrender(battle); break; }
  }
  const army = battle.army;
  const routed = battle.routed;
  const surrendered = !!battle.surrendered;

  // 死者数：敗走が最も多い。人口比では1戦あたり数%（設計文書）
  const baseRate = routed ? 0.20 : surrendered ? 0.05 : 0.09;
  const rate = clamp(baseRate * (1 + 0.9 * (battle.fleeFrac ?? 0)), 0, 0.55);
  let nDeaths = Math.floor(army.length * rate);
  if (rng.next() < (army.length * rate) % 1) nDeaths++;
  nDeaths = Math.min(nDeaths, Math.max(0, army.length - 1));

  // 内訳：ステータス由来 90% / 運 10%
  const luckShare = world.cfg.luckShare;
  let nLuck = Math.floor(nDeaths * luckShare);
  if (rng.next() < (nDeaths * luckShare) % 1) nLuck++;
  nLuck = Math.min(nLuck, nDeaths);
  const nStat = nDeaths - nLuck;

  const pool = [...army];
  const taken = new Set();
  // ステータス由来：恐怖耐性が低い・練度が浅い・頑健が低いほど死にやすい。
  // 逃走した者は死ににくいが、敗走時はその補正がほぼ消える（背中を斬られる）。
  const vuln = p => {
    const d = derive(p);
    let v = 0.15 + 0.45 * (1 - p.skills['恐怖耐性']) + 0.35 * (1 - p.genes['頑健'])
          + 0.30 * (1 - p.skills['戦技']) + 0.20 * d.逃走;
    if (p._fled) v *= routed ? 0.95 : 0.35;
    return Math.max(0.01, v);
  };
  for (let i = 0; i < nStat; i++) {
    let tot = 0;
    for (const p of pool) if (!taken.has(p.id)) tot += vuln(p);
    if (tot <= 0) break;
    let r = rng.next() * tot, pick = null;
    for (const p of pool) { if (taken.has(p.id)) continue; r -= vuln(p); if (r <= 0) { pick = p; break; } }
    if (!pick) break;
    taken.add(pick.id);
    kill(world, pick, 'war:stat', null);
  }
  for (let i = 0; i < nLuck; i++) {
    const rest = pool.filter(p => !taken.has(p.id));
    if (!rest.length) break;
    const pick = rest[rng.int(rest.length)];   // 流れ矢。完全に一様
    taken.add(pick.id);
    kill(world, pick, 'war:luck', null);
  }
  // 生還・傷病・戦功
  for (const p of army) {
    if (taken.has(p.id)) continue;
    if (rng.next() < 0.12) p.wounded = true;
    p.warsFought++;
    const learn = 0.10 + 0.25 * p.genes['技術習得'];
    p.skills['恐怖耐性'] = clamp01(p.skills['恐怖耐性'] + learn * 0.9);
    p.skills['戦技'] = clamp01(p.skills['戦技'] + learn * 0.6);
    p.skills['統率'] = clamp01(p.skills['統率'] + learn * 0.3 * p.genes['統率素質']);
    // 社会的コスト：逃げた者に戦功は付かない（設計文書 逃走の反作用②）
    if (p._fled) { p.fled++; p.merit -= 0.5; }
    else { p.merit += routed ? 0.3 : 1.0; p.deeds.push(world.gen); }
    p._fled = false;
  }
  emit(world, 'war', {
    text: `${routed ? '敗走' : surrendered ? '降伏' : '勝利'} 参加=${army.length} 戦死=${nDeaths} 逃走率=${(battle.fleeFrac ?? 0).toFixed(2)}`,
  });
  world.battles.push({ gen: world.gen, n: army.length, deaths: nDeaths, stat: nStat, luck: nLuck, routed, fleeFrac: battle.fleeFrac ?? 0 });
  if (world.battles.length > 4000) world.battles.splice(0, 1500);

  if (!routed && !surrendered) handleCaptives(world, rng, ev, battle);
  for (const p of world.people.values()) p.grudges[0] = (p.grudges[0] ?? 0) * 0.9;
  world.morale = clamp01(world.morale - nDeaths * 0.012);
  world.regimeGrudge += nDeaths * 0.35;   // 戦死者の家族に怨恨
}

// ---- 捕虜と国境処理 --------------------------------------------------------
export function captiveOptions(world) { return ['kill', 'accept', 'return']; }

export function takeCaptives(world, rng, n = 1) {
  const made = [];
  for (let i = 0; i < n; i++) {
    // 外来血は自国と別の中心を持つゲノム＝雑種強勢の原資
    const bias = {};
    for (const g of GENE_NAMES) bias[g] = clamp01(0.5 + rng.normal(0, 0.22));
    const ind = spawn(world, rng, {
      age: AGE_ADULT + rng.int(3),
      geno: makeGenome(rng, bias, world.cfg),
      lineage: { foreign: 1 },
      foreign: true,
    });
    ind.grudges[0] = 1.5;                    // 力ずくで連れてこられた
    world.foreignPool++;
    made.push(ind);
  }
  return made;
}

export function borderDecision(world, rng, decision, n) {
  if (decision === 'kill') {
    world.killedCaptives += n;
    world.regimeGrudge += n * 0.25;          // 大量誅殺は軍務関係者に露呈する
    return [];
  }
  if (decision === 'return') return [];
  return takeCaptives(world, rng, n);
}

function handleCaptives(world, rng, ev, battle) {
  const policy = world.cfg.uniformPolicy ? 'mixed' : world.profile.captive;
  const n = 1 + rng.int(world.phase === PHASE.TRIBE ? 5 : 1);
  let decision;
  if (world.closed) decision = 'kill';
  else if (policy === 'kill') decision = rng.next() < 0.9 ? 'kill' : 'accept';
  else if (policy === 'reject') decision = rng.next() < 0.75 ? 'return' : 'kill';
  else if (policy === 'accept') decision = 'accept';
  else decision = rng.next() < 0.5 ? 'accept' : 'kill';
  if (world.outsideBlood !== null) decision = rng.next() < world.outsideBlood ? 'accept' : 'kill';
  borderDecision(world, rng, decision, n);
  emit(world, 'border', { text: `${decision} x${n}` });
}

// ---- 飢饉 ------------------------------------------------------------------
function famine(w, rng, ev) {
  if (w.food >= 0) return;
  const deficit = Math.min(1, -w.food / Math.max(8, w.people.size));
  for (const p of [...w.people.values()]) {
    const d = derive(p);
    // 飢饉は代謝の高い者から殺す。怠惰は貯えがないので更に弱い（頻度依存の罰）
    let risk = deficit * (0.18 + 0.30 * p.genes['代謝']);
    if (!w.cfg.noFrequencyDependence) risk *= (1 + 0.9 * d.怠惰);
    risk *= (1 + 1.1 * p.load);              // 遺伝的荷重
    if (rng.next() < clamp01(risk)) kill(w, p, 'famine', null);
  }
  w.food = Math.max(w.food, -60);
  w.regimeGrudge += 0.4;
}

// ---- 繁殖 ------------------------------------------------------------------
function breed(w, rng, ev) {
  const prof = w.cfg.uniformPolicy ? DEFAULT_PROFILE : w.profile;
  const adults = adultsOf(w).filter(p => p.age >= AGE_ADULT && p.age < 14 && !p.wounded);
  const males = adults.filter(p => p.sex === 0);
  const females = adults.filter(p => p.sex === 1);
  if (!males.length || !females.length) return;

  const foodPer = w.food / Math.max(1, w.people.size);
  const meanGreed = avgGene(w, '私欲');
  const meanSloth = 1 - avgGene(w, '勤勉');

  // オーナー（プロファイル）が淘汰装置として働く：抜擢＝繁殖機会
  const score = p => {
    let s = 0.5;
    for (const [g, wt] of Object.entries(prof.select)) s += wt * (p.genes[g] - 0.5);
    s += 0.35 * p.merit;                            // 戦功。逃げた者は下がる
    s += 0.25 * (p.genes['繁殖性'] - 0.5);
    s -= 0.9 * p.load;                              // 劣性ホモの荷重
    const d = derive(p);
    if (w.cfg.noFrequencyDependence) {
      // サボタージュ：頻度に依らず常に得をする＝上限なしの上位互換。
      // 利得だけ残して罰を外す。こうすると私欲と怠惰は集団に固定するはずで、
      // 頻度依存の検査がそれを捕まえられなければ検査は空振りということになる。
      s += d.強欲 * 0.55 + d.怠惰 * 0.45;
    } else {
      // 私欲：食料が潤沢なら得、蔓延すると奪う先が消えて損（設計文書）
      s += d.強欲 * clamp(foodPer, 0, 2) * 0.30 - d.強欲 * meanGreed * 0.75;
      // 怠惰：本人は消耗しないが、蔓延すると全員飢える
      s += d.怠惰 * 0.18 - d.怠惰 * meanSloth * 0.85;
    }
    return s + rng.next() * 0.25;
  };
  males.sort((a, b) => score(b) - score(a));
  females.sort((a, b) => score(b) - score(a));

  const capacity = clamp01((TARGET_POP * 1.35 - w.people.size) / TARGET_POP);
  const foodOk = clamp01(0.35 + w.food / 70);
  // フェーズ1（2体から10体まで）は繁殖力を持ち上げる。
  // 創世の二匹だけで置換率を超えられないと、村は毎回ボトルネックで消える。
  const smallBoost = w.people.size < 12 ? 2.6 : 1;
  const pairs = Math.min(males.length, females.length);
  let born = 0;
  for (let i = 0; i < pairs; i++) {
    const dad = males[i], mom = females[i];
    if (w.closed && (dad.foreign || mom.foreign)) continue;
    const fert = 0.55 * (dad.genes['繁殖性'] + mom.genes['繁殖性']) * prof.fecundity;
    const rank = 1 - i / Math.max(1, pairs);      // 上位ほど繁殖機会が多い
    const n = fert * capacity * foodOk * (0.45 + 0.9 * rank) * 1.9 * smallBoost;
    let k = Math.floor(n);
    if (rng.next() < n - k) k++;
    for (let c = 0; c < k && w.people.size < HARD_CAP; c++) {
      makeChild(w, rng, dad, mom);
      born++;
    }
  }
  if (born) emit(w, 'birth', { text: String(born) });
  // 全滅寸前の救済はしない。即死するならそれは不変条件違反として報告させる。
}

function makeChild(w, rng, dad, mom) {
  const geno = {};
  const gd = meiosis(dad, rng, w.cfg), gm = meiosis(mom, rng, w.cfg);
  for (const g of GENE_NAMES) geno[g] = [gd[g], gm[g]];
  const lineage = {};
  for (const [k, v] of Object.entries(dad.lineage)) lineage[k] = (lineage[k] ?? 0) + v / 2;
  for (const [k, v] of Object.entries(mom.lineage)) lineage[k] = (lineage[k] ?? 0) + v / 2;

  const skills = {};
  const h = w.cfg.skillHeritability;               // 正常時は 0。練度は遺伝しない。
  for (const k of SKILLS) skills[k] = h > 0 ? h * (dad.skills[k] + mom.skills[k]) / 2 : 0;

  const ind = spawn(w, rng, {
    sex: rng.int(2), fatherId: dad.id, motherId: mom.id,
    geno, lineage, skills, house: dad.house,
  });
  ind.foreign = dad.foreign && mom.foreign;
  // 怨恨の家系継承（体制怨恨は消えない）
  const inherited = ((dad.grudges[0] ?? 0) + (mom.grudges[0] ?? 0)) / 2;
  if (inherited > 0) ind.grudges[0] = inherited * 0.7;
  return ind;
}

// ===========================================================================
// オーナーの動詞（v2で解禁される 読む・置く・敷く・裁く の骨格）
// ===========================================================================
export function assignRole(world, id, role) {
  const p = world.people.get(id); if (p) p.role = role; return p;
}
export function setDistrict(world, id, district) {
  const p = world.people.get(id); if (p) p.district = district; return p;
}
export function appointBureau(world, bureau, id) {
  const p = world.people.get(id); if (!p) return null;
  world.bureaus[bureau] = id; p.bureau = bureau; return p;
}
export function setCard(world, cardId, on, value = 0) {
  world.cards[cardId] = { on, value }; return world.cards[cardId];
}
export function search(world, pred) {
  const out = [];
  for (const p of world.people.values()) if (pred(p)) out.push(p);
  return out;
}
export function chronicle(world, filter = {}) {
  return world.events.filter(e =>
    (filter.kind ? e.kind === filter.kind : true) &&
    (filter.from != null ? e.gen >= filter.from : true) &&
    (filter.to != null ? e.gen <= filter.to : true));
}
/** 年代記の遡行：謀反 → trueCause を辿って原因の粛清まで戻る。 */
export function trace(world, eventId, depth = 12) {
  const byId = new Map(world.events.map(e => [e.id, e]));
  const chain = [];
  let cur = byId.get(eventId);
  while (cur && chain.length < depth) { chain.push(cur); cur = cur.trueCause != null ? byId.get(cur.trueCause) : null; }
  return chain;
}
export function petitions(world) {
  const out = [];
  for (const p of world.people.values()) {
    if (p.unmet > 0.6) out.push({ id: p.id, kind: 'unmet', weight: p.unmet });
  }
  return out.slice(0, 8);
}
export function resolvePetition(world, pet, accept) {
  const p = world.people.get(pet.id); if (!p) return;
  if (accept) { p.unmet = clamp01(p.unmet - 0.4); world.food -= 1; }
  else { p.grudges[0] = (p.grudges[0] ?? 0) + 0.3; world.regimeGrudge += 0.15; }
}
/** 国民力：実効値ベース。忠誠は絶対に含めない（設計文書）。 */
export function publicRank(world) {
  let s = 0;
  for (const p of world.people.values()) s += 0.5 * warPower(p) + 0.5 * farmPower(p);
  return { power: s, size: world.people.size, tier: Math.floor(Math.sqrt(Math.max(0, s))) };
}

// ===========================================================================
// ロスター：10国を並行して進める
// ===========================================================================
export function createRoster(seed, opts = {}) {
  const worlds = [];
  for (let i = 0; i < RIVAL_IDS.length; i++) {
    const id = RIVAL_IDS[i];
    const s = (Math.imul(seed >>> 0 || 1, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0;
    worlds.push(createWorld(s, { profile: id, sabotage: opts.sabotage }));
  }
  return { seed: seed >>> 0, worlds, gen: 0 };
}
export function advanceRoster(roster, rng, gens = 1) {
  for (let g = 0; g < gens; g++) {
    for (const w of roster.worlds) {
      for (let t = 0; t < TICKS_PER_GEN; t++) stepTick(w, rng);
      advanceGeneration(w, rng);
    }
    roster.gen++;
  }
  return roster;
}
export function listOpponents(roster) {
  return roster.worlds.map(w => ({
    id: w.profileId, name: w.profile.name, profile: w.profileId,
    power: publicRank(w).power, tier: publicRank(w).tier,
  }));
}
export function peek(roster, id) { return roster.worlds.find(w => w.profileId === id) ?? null; }
