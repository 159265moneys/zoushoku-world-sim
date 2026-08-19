// 世界。createWorld / stepTick / advanceGeneration と、オーナーの動詞のうち
// 「置く」（配役・居住区・任命）と「読む」（検索）。
//
// sim は ui を知らない。DOMも window も Date.now() も触らない。
// 乱数は必ず引数で渡された RNG を使う。

import {
  makeVillage, makeIndividual, blankSkills, PHASE, PHASE_THRESHOLD,
  ROLE, BUREAU, BUREAU_LABEL, DISTRICT,
} from '../core/model.js';
import { RNG } from '../core/rng.js';
import { NameGiver } from '../core/names.js';
import { GENE_NAMES } from '../core/genes.js';
import * as C from './constants.js';
import {
  foundingGenome, answersToTargets, breedGenome, phenotype,
  enforceNoUniversalSuperiority, homozygosity, recessiveHomo, carriers,
} from './genetics.js';
import {
  eff, sins, sinOutputs, citizenPower, produce, consume, unmetTotal,
  willingness, acceptance, clamp, clamp01, combatStats,
} from './derive.js';
import { initChronicle, record, applyDelta, inheritLedger, pruneChronicle } from './chronicle.js';
import { defaultCards, cardOr } from './cards.js';

const SEG_OF_ROLE = {
  [ROLE.HUNT]: 'war', [ROLE.DRILL]: 'war', [ROLE.WAR]: 'war',
  [ROLE.FARM]: 'prod',
};

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export function createWorld(seed, answers = []) {
  const w = makeVillage();
  w.seed = seed >>> 0;
  w.originKey = 'home';
  w.origins = new Map([['home', { key: 'home', name: '自国', hue: (w.seed % 360) / 360 }]]);
  w.cards = defaultCards();
  w.transparency = 0.5;     // 透過率。法務局がないv2は固定値＋カードで動く
  w.lastWarGen = -99;
  w.border = new Map();     // 国境で待機している捕虜（まだ入国していない）
  w.foreign = new Map();    // 外国人の参照（publicRank 用）
  w.petitions = new Map();
  w.nextPetitionId = 1;
  w.battles = [];
  w.ledger = [];            // 民心・産出率の出所
  w.stats = [];
  // 交配相手はオーナーが指名できない。動かせるのは「地位・実績・住まわせ方」だけで、
  // それが結果として血の濃さを決める（ラマルクではなくダーウィン経路）。
  w.mating = { foreignBias: 0, inbreedGuard: 0.0, preferGene: null, preferWeight: 0 };
  w.fertBias = 1;
  w.answers = answers;
  w.collapsing = false;
  w.rebellions = 0;
  initChronicle(w);

  w.giver = new NameGiver(new RNG((w.seed ^ 0x9e3779b9) >>> 0));
  const rng = new RNG((w.seed ^ 0x85ebca6b) >>> 0);

  const targets = answersToTargets(answers);
  const founders = ['アダム', 'イザナミ'];
  const genesis = record(w, '創世', { text: '世界が始まった' });
  for (let i = 0; i < 2; i++) {
    const hap = foundingGenome(targets, rng, 0.14);
    const ind = spawn(w, founders[i], hap, { sex: i, age: 2, born: 0, lineage: { home: 1 } });
    ind.expressed = { war: true, prod: true }; // 創世の二匹だけは両方開いている
    ind.role = i === 0 ? ROLE.HUNT : ROLE.FARM;
    ind.founder = true;
    ind.myth = true;                            // 神を直接見た
    record(w, '誕生', { actor: ind.id, trueCause: genesis.id, text: `${ind.name}が現れた` });
  }
  recomputeAggregates(w);
  return w;
}

/** 個体を1体作って world に入れる。genes は hap から必ず導出する。 */
export function spawn(w, name, hap, opts = {}) {
  const id = w.nextId++;
  const genes = phenotype(hap);
  const ind = makeIndividual(id, name, {
    ...opts,
    genes,
    skills: blankSkills(),                 // 練度は絶対に継承しない
    expressed: opts.expressed ?? {},
  });
  ind.hap = hap;
  ind.regimeGrudge = opts.regimeGrudge ?? 0;
  ind.ledger = [];
  ind.motive = {};
  ind.mated = false;
  ind.homoz = homozygosity(hap);
  ind.origin = opts.origin ?? w.originKey;
  ind.district = opts.district ?? DISTRICT.CENTER;
  ind.role = opts.role ?? ROLE.CHILD;
  ind.power = citizenPower(ind);
  w.people.set(id, ind);
  return ind;
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export function stepTick(w, rng) {
  const events = [];
  w.tick++;

  let gross = 0, hidden = 0, eat = 0;
  const pop = w.people.size;
  if (pop === 0) { w.collapsing = true; return events; }

  const density = densityStress(w);
  w.density = density;

  for (const p of w.people.values()) {
    const pr = produce(p, w);
    gross += pr.gross;
    hidden += pr.hidden;
    eat += consume(p);
    gainSkills(w, p, rng);
    // 疲労：働けば溜まる。怠惰は疲れない
    const so = sinOutputs(sins(p));
    const load = p.role === ROLE.IDLE || p.role === ROLE.CHILD ? -0.05 : 0.045;
    p.fatigue = clamp01(p.fatigue + load * so.疲労耐性 - 0.02);
    p.power = citizenPower(p);
  }

  const net = gross - hidden;
  w.yieldRate = net;
  w.consumption = eat;
  w.food = clamp(w.food + net - eat, -20, C.FOOD_CAP_BASE + pop * C.FOOD_CAP_PER_HEAD);

  // 隠匿：オーナーからは「なぜか産出が落ちている」としか見えない
  if (hidden > net * 0.18 && hidden > 0.4 && rng.bool(0.10)) {
    const culprit = pickWeighted(w, rng, (p) => produce(p, w).hidden);
    if (culprit) {
      const ev = record(w, '隠匿', {
        actor: culprit.id,
        claimed: { by: null, blame: '不作', text: '不作である' },
        revealed: false,
        text: `${culprit.name}が収穫を隠した`,
        effects: [{ field: '産出率', delta: -hidden }],
      });
      applyDelta(w, w, '産出率', -hidden, ev.id);
      events.push(ev);
    }
  }

  // 飢餓
  if (w.food <= 0) {
    w.food = 0;
    for (const p of [...w.people.values()]) {
      const so = sinOutputs(sins(p));
      const pDie = 0.035 * (1 - clamp01(so.飢餓耐性)) * (1 + density);
      if (rng.bool(pDie)) {
        const ev = kill(w, p, '餓死', null);
        events.push(ev);
      }
    }
  }

  // 狩りの事故（練度の入口にリスクを付ける）
  for (const p of w.people.values()) {
    if (p.role !== ROLE.HUNT) continue;
    const cs = combatStats(p);
    const pDie = 0.0035 * (1.6 - clamp01(cs.nerve)) * (1.4 - p.genes.頑健);
    if (rng.bool(pDie)) {
      const ev = kill(w, p, '事故', null);
      events.push(ev);
      break;
    }
  }

  updateMorale(w);
  return events;
}

/** 練度の伸び。環境係数（生育地・家業・貧富）が伸び率を決める。遺伝は一切関与しない。 */
function gainSkills(w, p, rng) {
  const table = C.SKILL_GAIN[p.role] || {};
  const so = sinOutputs(sins(p));
  const foodPer = w.people.size ? w.food / w.people.size : 0;
  // 貧しいほど早く働きに出て早く伸びる（代わりに体格と寿命に負債）
  const poverty = clamp(1.25 - foodPer * 0.12, 0.85, 1.25);
  const place = p.district === DISTRICT.FRONTIER ? 1.22 : 0.92;
  const youth = p.age < C.ADULT_AGE ? 0.5 : clamp(1.15 - p.age * 0.05, 0.5, 1.15);
  const envCoef = poverty * place * youth * so.練度補正;
  for (const [sk, rate] of Object.entries(table)) {
    const cur = p.skills[sk] ?? 0;
    p.skills[sk] = clamp01(cur + rate * envCoef * (1 - cur) / C.TICKS_PER_GEN * 4);
  }
  // 辺境は恐怖耐性がタダで伸びる（獣と飢え）。中心部は伸びない
  if (p.district === DISTRICT.FRONTIER) {
    const cur = p.skills.恐怖耐性 ?? 0;
    p.skills.恐怖耐性 = clamp01(cur + 0.012 * (1 - cur));
  }
}

function densityStress(w) {
  const cap = 12 + w.tech * 6 + Math.max(0, w.food) * 0.22;
  return clamp(w.people.size / Math.max(1, cap) - 1, 0, 4);
}

function updateMorale(w) {
  const pop = w.people.size;
  if (!pop) return;
  let unmet = 0, grudge = 0;
  for (const p of w.people.values()) {
    p.unmet = unmetTotal(p, w);
    unmet += p.unmet;
    grudge += clamp01(p.regimeGrudge);
  }
  const mUnmet = unmet / pop;
  const mGrudge = grudge / pop;
  const target = clamp(0.85 - mUnmet * 0.6 - mGrudge * 0.8 - w.density * 0.10, C.MORALE_FLOOR, 1);
  w.morale = w.morale + (target - w.morale) * 0.25;
  w.regimeGrudge = mGrudge;
}

// ---------------------------------------------------------------------------
// 世代
// ---------------------------------------------------------------------------

export function advanceGeneration(w, rng) {
  const events = [];
  // その世代の残りticksを消化する（UIが刻んでいれば0回、ヘッドレスなら12回）
  const wanted = (w.gen + 1) * C.TICKS_PER_GEN;
  let guard = C.TICKS_PER_GEN * 2;
  while (w.tick < wanted && guard-- > 0) events.push(...stepTick(w, rng));

  // 1. 発現（幼少期にその局面に置かれたか）。ここを逃すと素質は一生開かない
  for (const p of w.people.values()) {
    if (p.age <= C.EXPRESS_AGE) expressChild(w, p, rng, events);
  }

  // 2. 加齢
  for (const p of w.people.values()) p.age++;

  // 3. 死（老衰・傷病）
  for (const p of [...w.people.values()]) {
    const so = sinOutputs(sins(p));
    const debt = p.district === DISTRICT.FRONTIER ? 0.85 : 1;
    const life = (C.BASE_LIFESPAN + C.LIFESPAN_SPAN * p.genes.寿命) * so.寿命補正 * debt;
    let pDie = 0.012;
    if (p.age > life) pDie = clamp(0.22 + (p.age - life) * 0.32, 0, 0.96);
    if (p.wounded) pDie += 0.06;
    if (rng.bool(pDie)) events.push(kill(w, p, p.age > life ? '老衰' : '傷病', null));
  }

  // 4. 配役（成人した者、役なしの者）
  autoAssign(w, rng, events);

  // 5. 繁殖
  events.push(...breedGeneration(w, rng));

  // 6. 怨恨の整理：個人怨恨は本人の死で消える。体制怨恨は消えない
  for (const p of w.people.values()) {
    for (const k of Object.keys(p.grudges)) {
      const id = Number(k);
      if (!w.people.has(id)) delete p.grudges[k];
    }
    p.regimeGrudge = clamp01(p.regimeGrudge * (1 - C.GRUDGE_DECAY));
    p.mated = false;
  }

  // 7. 謀反・一揆
  const reb = checkRebellion(w, rng);
  if (reb) events.push(reb);

  // 8. フェーズ移行
  if (w.phase === PHASE.VILLAGE && w.people.size >= PHASE_THRESHOLD[1]) {
    w.phase = PHASE.TRIBE;
    events.push(record(w, 'フェーズ移行', { text: '村が部族になった。もう一人ずつ手で置くことはできない' }));
  }

  w.gen++;
  updateMorale(w);
  recomputeAggregates(w);
  if (w.gen % 25 === 0) pruneChronicle(w, 40);

  w.collapsing = w.people.size > 0 && w.yieldRate < w.consumption * 0.85 && w.food < 3;

  const report = makeReport(w, events);
  return { events, report };
}

function expressChild(w, p, rng, events) {
  if (p.expressed.war && p.expressed.prod) return;
  const f = w.people.get(p.fatherId) || w.dead.get(p.fatherId);
  const m = w.people.get(p.motherId) || w.dead.get(p.motherId);
  let seg = SEG_OF_ROLE[p.role] || SEG_OF_ROLE[f?.role] || SEG_OF_ROLE[m?.role] || null;
  // 辺境で育てば戦争側が勝手に開く。中心部は開きにくい
  if (p.district === DISTRICT.FRONTIER && rng.bool(0.45)) seg = 'war';
  const openP = p.district === DISTRICT.CENTER ? 0.62 : 0.85;
  if (seg && !p.expressed[seg] && rng.bool(openP)) {
    p.expressed[seg] = true;
    p.power = citizenPower(p);
    events.push(record(w, '発現', {
      actor: p.id,
      text: `${p.name}の${seg === 'war' ? '戦の' : '生産の'}素質が開いた`,
    }));
  }
  // 内発／外発：幼少期にその欲が「行為」で満たされたか「報酬」で満たされたか
  const surplus = w.people.size ? w.food / w.people.size : 0;
  const byAct = { 憤怒: seg === 'war', 傲慢: seg === 'war', 強欲: seg === 'prod', 怠惰: !seg };
  for (const k of Object.keys(byAct)) {
    if (p.motive[k]) continue;
    if (byAct[k] && surplus < 3.0) p.motive[k] = 'intrinsic';
    else if (surplus > 2.2) p.motive[k] = 'extrinsic';
    else p.motive[k] = rng.bool(0.45) ? 'intrinsic' : 'extrinsic';
  }
}

function autoAssign(w, rng, events) {
  const huntShare = cardOr(w, 'hunt_ratio', 30) / 100;
  const drillShare = cardOr(w, 'drill', 0) / 100;
  const adults = [...w.people.values()].filter((p) => p.age >= C.ADULT_AGE);
  const needFood = w.food < w.people.size * 2.5;
  for (const p of adults) {
    if (p.roleLocked) continue;              // オーナーが名指しで置いた個体は動かさない
    if (p.role === ROLE.WAR) p.role = ROLE.IDLE;
    if (p.role !== ROLE.CHILD && p.role !== ROLE.IDLE && rng.bool(0.72)) continue;
    const r = rng.next();
    let role;
    if (needFood) role = r < 0.62 ? ROLE.FARM : (r < 0.62 + huntShare ? ROLE.HUNT : ROLE.FARM);
    else if (r < drillShare) role = ROLE.DRILL;
    else if (r < drillShare + huntShare) role = ROLE.HUNT;
    else role = ROLE.FARM;
    // 意欲係数：本人が望まない役は性能が出ないので、望む方へ弱く引く
    if (willingness(p, role) < 0.5 && rng.bool(0.5)) {
      role = willingness(p, ROLE.HUNT) > willingness(p, ROLE.FARM) ? ROLE.HUNT : ROLE.FARM;
    }
    p.role = role;
  }
  for (const p of w.people.values()) {
    if (p.age < C.ADULT_AGE) p.role = ROLE.CHILD;
  }
}

function breedGeneration(w, rng) {
  const events = [];
  if (w.people.size >= C.MAX_POP) return events;
  const adults = [...w.people.values()].filter((p) => p.age >= C.ADULT_AGE);
  const males = adults.filter((p) => p.sex === 0);
  const females = adults.filter((p) => p.sex === 1 && p.age <= C.FERTILE_MAX);
  if (!males.length || !females.length) return events;

  const foodPer = w.food / Math.max(1, w.people.size);
  const foodFactor = clamp(foodPer / 2.2, 0, 1.25);
  const density = densityStress(w);
  const scale = (C.PHASE_FERT[w.phase] ?? 1) * (w.fertBias ?? 1) / (1 + density * density);

  for (const mother of females) {
    if (w.people.size >= C.MAX_POP) break;
    const sn = sins(mother);
    const so = sinOutputs(sn);
    let p = scale * (0.35 + 0.85 * mother.genes.繁殖性) * so.繁殖補正
          * foodFactor * (0.45 + 0.55 * w.morale) * (1 - clamp01(mother.fatigue) * 0.3);
    p = clamp(p, 0, 3.2);
    let n = Math.floor(p);
    if (rng.bool(p - n)) n++;
    if (n <= 0) continue;
    const father = chooseMate(w, mother, males, rng);
    if (!father) continue;
    mother.mated = true; father.mated = true;
    for (let i = 0; i < n && w.people.size < C.MAX_POP; i++) {
      events.push(birth(w, father, mother, rng));
    }
  }
  return events;
}

function chooseMate(w, mother, males, rng) {
  let total = 0;
  const scored = [];
  for (const m of males) {
    if (m.id === mother.id) continue;
    const sn = sins(m);
    let s = 0.3 + 0.7 * m.power + 0.5 * sn.色欲 + 0.3 * m.deeds.length * 0.1;
    if (m.district === mother.district) s *= 1.35;
    // 地位と実績は繁殖機会になる。逃走は戦功が付かないので機会が落ちる（社会的コスト）
    if (m.bureau) s *= 1.7;
    s *= 1 + 0.22 * m.titles.length;
    if (m.cowardice) s *= Math.max(0.45, 1 - 0.22 * m.cowardice);
    // オーナーが引き上げた形質は、地位を通して血が濃くなる
    if (w.mating.preferGene && w.mating.preferWeight) {
      s *= 1 + w.mating.preferWeight * (m.genes[w.mating.preferGene] ?? 0.5);
    }
    // 血統の好み。純血路線は外来血を避け、融和路線は寄せる
    const same = (m.origin === mother.origin);
    const bias = w.mating.foreignBias;
    if (bias > 0) s *= same ? 1 : 1 + bias * 1.6;
    if (bias < 0) s *= same ? 1 : Math.max(0.02, 1 + bias * 1.2);
    // 個人怨恨は結ばれない
    if (mother.grudges[m.id] > 0.4 || m.grudges[mother.id] > 0.4) s *= 0.15;
    // 近親を避けるガード（既定0＝避けない。閉じた血統は劣性ホモが溜まって腐る）
    if (w.mating.inbreedGuard > 0 && related(w, m, mother)) s *= Math.max(0.05, 1 - w.mating.inbreedGuard);
    s = Math.max(0.001, s);
    scored.push([m, s]); total += s;
  }
  if (!scored.length) return null;
  let r = rng.next() * total;
  for (const [m, s] of scored) { r -= s; if (r <= 0) return m; }
  return scored[scored.length - 1][0];
}

function related(w, a, b) {
  if (!a.fatherId && !b.fatherId) return false;
  if (a.fatherId && (a.fatherId === b.fatherId || a.fatherId === b.id)) return true;
  if (a.motherId && (a.motherId === b.motherId || a.motherId === b.id)) return true;
  if (b.fatherId === a.id || b.motherId === a.id) return true;
  return false;
}

function birth(w, father, mother, rng) {
  const hap = breedGenome(father.hap, mother.hap, father.genes.可塑, mother.genes.可塑, rng);
  const lineage = mixLineage(father.lineage, mother.lineage);
  const child = spawn(w, w.giver.take(), hap, {
    sex: rng.int(2), age: 0, born: w.gen,
    fatherId: father.id, motherId: mother.id,
    lineage,
    district: rng.bool(0.5) ? father.district : mother.district,
    origin: rng.bool(0.5) ? father.origin : mother.origin,
  });
  enforceNoUniversalSuperiority(child.genes, father.genes, mother.genes);
  child.power = citizenPower(child);

  // 体制怨恨は家系に継承される。個人怨恨は継承しない
  child.regimeGrudge = clamp01(((father.regimeGrudge + mother.regimeGrudge) / 2) * C.GRUDGE_INHERIT);
  child.myth = !!(father.myth || mother.myth);

  const ev = record(w, '誕生', {
    actor: child.id, target: mother.id,
    text: `${child.name}が生まれた（${father.name}と${mother.name}）`,
    effects: [{ field: '血統', delta: 1, subjectId: child.id }],
  });
  // 出所の継承。3世代後の謀反から原因の粛清まで遡れるのはこれのおかげ
  inheritLedger(w, child, [father, mother], C.GRUDGE_INHERIT / 2);
  applyDelta(w, child, '血統', 1, ev.id);

  // 劣性ホモが表に出たら記録する（数世代潜伏していたものが今出た）
  const rh = recessiveHomo(hap);
  if (rh.length) {
    child.surfaced = rh;
    const strong = rh.filter((g) => Math.abs(child.genes[g] - 0.5) > 0.28);
    if (strong.length) {
      record(w, '潜伏形質の発現', {
        actor: child.id, trueCause: ev.id, revealed: false,
        text: `${child.name}に${strong.join('・')}が現れた`,
      });
    }
  }
  return ev;
}

function mixLineage(a, b) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) out[k] = (out[k] || 0) + v * 0.5;
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v * 0.5;
  let s = 0; for (const v of Object.values(out)) s += v;
  if (s > 0) for (const k of Object.keys(out)) out[k] /= s;
  // 1%未満の系統は畳む（色相計算が無限に細かくならないように）
  for (const k of Object.keys(out)) if (out[k] < 0.01) delete out[k];
  let s2 = 0; for (const v of Object.values(out)) s2 += v;
  if (s2 > 0) for (const k of Object.keys(out)) out[k] /= s2;
  return Object.keys(out).length ? out : { home: 1 };
}

// ---------------------------------------------------------------------------
// 死・粛清
// ---------------------------------------------------------------------------

export function kill(w, ind, cause, causeEventId) {
  if (!w.people.has(ind.id)) return null;
  ind.alive = false;
  ind.deathGen = w.gen;
  ind.deathCause = cause;
  w.people.delete(ind.id);
  w.dead.set(ind.id, ind);
  if (w.bureaus) {
    for (const k of Object.keys(w.bureaus)) if (w.bureaus[k] === ind.id) w.bureaus[k] = null;
  }
  return record(w, '死亡', {
    actor: ind.id, trueCause: causeEventId,
    text: `${ind.name}が${cause}した`,
    effects: [{ field: '血統', delta: -1, subjectId: ind.id }],
  });
}

/**
 * 粛清。オーナーの動詞「殺す」。v2ではUIに出さない（P3以降）が、
 * ライバル国の恐怖統治と、可読性テスト（3世代後の謀反）に必要なので実装する。
 * 怨恨は体制に向く。局長個人には向かない。
 */
export function purge(w, id, rng, reason = '粛清') {
  const ind = w.people.get(id);
  if (!ind) return null;
  const ev = record(w, '粛清', {
    actor: null, target: id,
    claimed: { by: w.bureaus.military, blame: ind.name, text: `${ind.name}は謀反人であった` },
    revealed: true,
    text: `${ind.name}が${reason}された`,
  });
  // 遺族と目撃者に体制怨恨。冤罪は最も純度が高い
  const kin = [...w.people.values()].filter(
    (p) => p.fatherId === id || p.motherId === id || p.id === ind.fatherId || p.id === ind.motherId
  );
  for (const k of kin) {
    k.regimeGrudge = clamp01(k.regimeGrudge + 0.45);
    applyDelta(w, k, '怨恨', 0.45, ev.id);
  }
  for (const p of w.people.values()) {
    if (kin.includes(p)) continue;
    const d = 0.05 * (0.4 + p.genes.感受性) * (1 - 0.5 * p.genes.従順);
    p.regimeGrudge = clamp01(p.regimeGrudge + d);
    applyDelta(w, p, '怨恨', d, ev.id);
  }
  kill(w, ind, '処刑', ev.id);
  updateMorale(w);
  return ev;
}

// ---------------------------------------------------------------------------
// 謀反：怨恨 × 感受性 × 扇動者の存在
// ---------------------------------------------------------------------------

function checkRebellion(w, rng) {
  const pop = w.people.size;
  if (pop < 4) return null;
  let sum = 0;
  const agitators = [];
  for (const p of w.people.values()) {
    sum += clamp01(p.regimeGrudge);
    // 高感受性 × 高知性 × 怨恨 ＝ 扇動者。8番と2番から導出されるので新規の遺伝子は要らない
    if (p.genes.感受性 > 0.58 && p.genes.知性 > 0.55 && p.regimeGrudge > 0.45) agitators.push(p);
  }
  const mean = sum / pop;
  const pressure = mean * (1 - w.morale) * (1 + agitators.length * 0.35);
  if (pressure < 0.22) return null;
  if (!rng.bool(clamp(pressure, 0, 0.9))) return null;

  const rebels = [...w.people.values()]
    .filter((p) => p.regimeGrudge > mean * 0.8 && p.age >= C.ADULT_AGE)
    .sort((a, b) => b.regimeGrudge - a.regimeGrudge)
    .slice(0, Math.max(2, Math.floor(pop * 0.25)));
  if (rebels.length < 2) return null;

  // 真の原因＝反乱者の怨恨台帳で最も寄与の大きい事件。ここが年代記の鎖の要
  const cause = dominantCause(rebels);
  const leader = agitators[0] || rebels[0];
  w.rebellions++;
  const ev = record(w, '一揆', {
    actor: leader.id,
    trueCause: cause,
    claimed: { by: w.bureaus.civil, blame: '飢饉', text: '飢饉による暴発である' },
    revealed: agitators.length > 0,
    text: `${leader.name}を中心に${rebels.length}名が蜂起した`,
    effects: [{ field: '民心', delta: -0.25 }],
  });
  applyDelta(w, w, '民心', -0.25, ev.id);
  w.morale = clamp(w.morale - 0.25, C.MORALE_FLOOR, 1);
  // 備蓄を焼く
  const burn = w.food * clamp(0.15 + rebels.length / pop, 0, 0.6);
  w.food = Math.max(0, w.food - burn);
  applyDelta(w, w, '産出率', -burn, ev.id);
  return ev;
}

/** 個体群の怨恨台帳から、最も寄与の大きい上流事件を選ぶ。 */
export function dominantCause(people) {
  const acc = new Map();
  for (const p of people) {
    for (const d of p.ledger || []) {
      if (d.field !== '怨恨' || d.eventId == null) continue;
      acc.set(d.eventId, (acc.get(d.eventId) || 0) + Math.abs(d.delta));
    }
  }
  let best = null, bestV = 0;
  for (const [id, v] of acc) if (v > bestV) { bestV = v; best = id; }
  return best;
}

// ---------------------------------------------------------------------------
// オーナーの動詞：置く
// ---------------------------------------------------------------------------

export function assignRole(w, id, role) {
  if (w.phase !== PHASE.VILLAGE) return null;   // P2で「自分で配役する」ボタンは消える
  const p = w.people.get(id);
  if (!p || !Object.values(ROLE).includes(role)) return null;
  const prev = p.role;
  p.role = role;
  p.roleLocked = true;
  return record(w, '配役', {
    target: id, text: `${p.name}を${roleLabel(role)}に置いた（前は${roleLabel(prev)}）`,
  });
}

export function setDistrict(w, id, district) {
  const p = w.people.get(id);
  if (!p || !Object.values(DISTRICT).includes(district)) return null;
  const prev = p.district;
  if (prev === district) return null;
  p.district = district;
  return record(w, '移住', {
    target: id,
    text: `${p.name}を${district === DISTRICT.FRONTIER ? '辺境' : '中心'}へ移した`,
  });
}

/** 任命＝神の実在を教えること。前任者は個人怨恨のノードになる。 */
export function appointBureau(w, bureauKey, id) {
  if (!Object.values(BUREAU).includes(bureauKey)) return null;
  const prevId = w.bureaus[bureauKey];
  const p = id == null ? null : w.people.get(id);
  if (id != null && !p) return null;
  if (prevId != null && w.people.has(prevId)) {
    const prev = w.people.get(prevId);
    prev.bureau = null;
    if (id != null) {
      // 弾かれた前任者は後任を憎む。これは個人怨恨（本人の死で消える）
      prev.grudges[id] = clamp01((prev.grudges[id] || 0) + 0.35 + 0.4 * prev.genes.誇り);
      prev.regimeGrudge = clamp01(prev.regimeGrudge + 0.12 * prev.genes.誇り);
    }
  }
  w.bureaus[bureauKey] = id;
  if (p) {
    p.bureau = bureauKey;
    p.knowsOwner = true;   // 入信儀式。知ってしまった人間は市井に戻せない
    p.will = willingness(p, 'bureau');
    p.accept = acceptance(p, w);
  }
  const ev = record(w, '任命', {
    target: id,
    text: p ? `${p.name}を${BUREAU_LABEL[bureauKey]}長にした` : `${BUREAU_LABEL[bureauKey]}長を空席にした`,
  });
  // 受容係数が低い（無名の抜擢）と周囲に軋轢が出る
  if (p && p.accept < 0.5) {
    for (const q of w.people.values()) {
      if (q.id === p.id) continue;
      const d = 0.06 * q.genes.序列意識;
      q.grudges[p.id] = clamp01((q.grudges[p.id] || 0) + d);
    }
  }
  return ev;
}

function roleLabel(r) {
  return { idle: '無役', farm: '農作業', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '子ども' }[r] || r;
}

// ---------------------------------------------------------------------------
// 読む：検索
// ---------------------------------------------------------------------------

/**
 * 素質・年齢・役割・居住区・所属で絞る。
 * 未発現の素質は確定値を出さない（レンジ表示）ので、UI用に est を付ける。
 */
export function search(w, filters = {}) {
  const f = filters || {};
  let list = [...w.people.values()];
  if (f.role) { const rs = [].concat(f.role); list = list.filter((p) => rs.includes(p.role)); }
  if (f.district) list = list.filter((p) => p.district === f.district);
  if (f.bureau !== undefined) {
    if (f.bureau === null) list = list.filter((p) => !p.bureau);
    else list = list.filter((p) => p.bureau === f.bureau);
  }
  if (f.minAge != null) list = list.filter((p) => p.age >= f.minAge);
  if (f.maxAge != null) list = list.filter((p) => p.age <= f.maxAge);
  if (f.sex != null) list = list.filter((p) => p.sex === f.sex);
  if (f.origin) list = list.filter((p) => p.origin === f.origin);
  if (f.expressed) list = list.filter((p) => !!p.expressed[f.expressed]);
  if (f.unexpressed) list = list.filter((p) => !p.expressed[f.unexpressed]);
  if (f.gene && GENE_NAMES.includes(f.gene)) {
    const lo = f.min ?? 0, hi = f.max ?? 1;
    list = list.filter((p) => p.genes[f.gene] >= lo && p.genes[f.gene] <= hi);
  }
  if (f.minPower != null) list = list.filter((p) => citizenPower(p) >= f.minPower);
  const key = f.sort || (f.gene ? 'gene' : 'power');
  const cmp = {
    power: (a, b) => citizenPower(b) - citizenPower(a),
    gene: (a, b) => (b.genes[f.gene] ?? 0) - (a.genes[f.gene] ?? 0),
    age: (a, b) => a.age - b.age,
    id: (a, b) => a.id - b.id,
    grudge: (a, b) => b.regimeGrudge - a.regimeGrudge,
  }[key] || ((a, b) => a.id - b.id);
  list.sort(cmp);
  return f.limit ? list.slice(0, f.limit) : list;
}

/** 未発現の素質はレンジで返す（真値±10%）。確定値を出すと検索してソートするだけの作業になる。 */
export function readGene(w, ind, gene, rng) {
  const v = ind.genes[gene] ?? 0;
  const seg = { 攻撃素質: 'war', 胆力: 'war', 統率素質: 'war', 器用: 'prod', 技術習得: 'prod', 共同作業適性: 'prod' }[gene];
  if (!seg || ind.expressed[seg]) return { value: v, exact: true };
  const w10 = 0.10;
  return { value: null, exact: false, lo: clamp01(v - w10), hi: clamp01(v + w10) };
}

// ---------------------------------------------------------------------------

function pickWeighted(w, rng, fn) {
  let total = 0; const arr = [];
  for (const p of w.people.values()) { const v = Math.max(0, fn(p)); if (v > 0) { arr.push([p, v]); total += v; } }
  if (!arr.length) return null;
  let r = rng.next() * total;
  for (const [p, v] of arr) { r -= v; if (r <= 0) return p; }
  return arr[arr.length - 1][0];
}

export function recomputeAggregates(w) {
  const pop = w.people.size;
  const st = { gen: w.gen, pop, food: w.food, morale: w.morale, yield: w.yieldRate, consumption: w.consumption };
  if (!pop) { st.power = 0; st.homoz = 0; st.grudge = 0; st.foreign = 0; w.stats.push(st); w.powerIndex = 0; return st; }
  let power = 0, homoz = 0, grudge = 0, foreign = 0;
  const geneSum = {};
  for (const n of GENE_NAMES) geneSum[n] = 0;
  for (const p of w.people.values()) {
    power += citizenPower(p);
    homoz += p.homoz ?? 0;
    grudge += clamp01(p.regimeGrudge);
    foreign += 1 - (p.lineage.home ?? 0);
    for (const n of GENE_NAMES) geneSum[n] += p.genes[n];
  }
  st.power = power / pop;
  st.homoz = homoz / pop;
  st.grudge = grudge / pop;
  st.foreign = foreign / pop;
  st.genes = {};
  for (const n of GENE_NAMES) st.genes[n] = geneSum[n] / pop;
  w.stats.push(st);
  if (w.stats.length > 1200) w.stats.splice(0, w.stats.length - 1200);
  // 国力：意図的に情報を捨てるスカラー。混ぜた時点で構成が復元不能になるのが機能
  w.powerIndex = Math.round(
    pop * 0.55 + power * pop * 1.4 + Math.max(0, w.yieldRate) * 2.2
    + w.tech * 3 + w.morale * 8 + st.foreign * 12 * pop * 0.05
  );
  return st;
}

function makeReport(w, events) {
  const kinds = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const chief = (k) => {
    const id = w.bureaus[k];
    const p = id != null ? w.people.get(id) : null;
    return p ? p.name : '空席';
  };
  const soldiers = [...w.people.values()].filter((p) => p.role === ROLE.HUNT || p.role === ROLE.DRILL).length;
  const farmers = [...w.people.values()].filter((p) => p.role === ROLE.FARM).length;
  const lines = [
    `軍務局（${chief(BUREAU.MILITARY)}）：狩り・演習に${soldiers}名。` +
      (w.lastWarGen >= 0 ? `直近の戦は第${w.lastWarGen}世代。` : '戦の記録はない。'),
    `農業局（${chief(BUREAU.AGRI)}）：${farmers}名が耕し、産出${w.yieldRate.toFixed(1)}／消費${w.consumption.toFixed(1)}。備蓄${w.food.toFixed(1)}。`,
    `民生局（${chief(BUREAU.CIVIL)}）：人口${w.people.size}、民心${(w.morale * 100).toFixed(0)}％、` +
      `誕生${kinds['誕生'] || 0}・死亡${kinds['死亡'] || 0}。` +
      (kinds['一揆'] ? '蜂起が起きた。' : ''),
  ];
  return {
    gen: w.gen, pop: w.people.size, food: w.food, morale: w.morale,
    yieldRate: w.yieldRate, consumption: w.consumption,
    powerIndex: w.powerIndex, phase: w.phase, collapsing: w.collapsing,
    lines, counts: kinds,
  };
}

export { carriers };
