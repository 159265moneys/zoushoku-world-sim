// ============================================================================
// mock.js — sim のスタブ。src/sim/ が出来るまで画面を成立させるための実装。
//
// * 本物の sim ができたら api.js が自動でそちらを優先する。ここは捨て札。
// * SPEC の絶対規則は守る：Math.random() を使わない / Date.now() に依存しない。
//   乱数はすべて core/rng.js の RNG。同じ種から同じ歴史が出る。
// * ここが「UIが期待している API の形」の実行可能な仕様書でもある。
// ============================================================================

import { RNG } from '../core/rng.js';
import { GENES, GENE_NAMES, MIND_GENES, BODY_GENES, CHROMOSOMES } from '../core/genes.js';
import { NameGiver, FOUNDERS } from '../core/names.js';
import {
  PHASE, ROLE, BUREAU, BUREAU_LABEL, SKILLS, DISTRICT,
  makeIndividual, makeVillage, makeEvent,
} from '../core/model.js';

export const SIM_KIND = 'mock';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const G = (ind, k) => (ind.genes && ind.genes[k] != null ? ind.genes[k] : 0.5);
const S = (ind, k) => (ind.skills && ind.skills[k] != null ? ind.skills[k] : 0);

// ---------------------------------------------------------------- 事件レコード

function ev(w, kind, opts = {}) {
  const e = makeEvent(w.nextEventId++, w.gen, kind, opts);
  e.tick = w.tick;
  w.events.push(e);
  if (w.events.length > 4000) w.events.splice(0, 800);
  return e;
}

// ---------------------------------------------------------------- 世界の生成

export function createWorld(seed, answers = [], opts = {}) {
  const w = makeVillage();
  w.seed = seed >>> 0;
  w.name = opts.name || '我らのシャーレ';
  w.profile = opts.profile || null;      // ライバル国のみ
  w.events = [];
  w.nextEventId = 1;
  w.history = [];
  w.strains = { self: { key: 'self', name: opts.strainName || '我らの血', hue: opts.hue ?? 0 } };
  w.borderQueue = [];
  w._petitions = [];
  w.intel = 0;                            // 諜報水準。v2 は 0 固定（諜報局は v2 に入れない）
  w.warReady = false;
  w.warsFought = 0;
  w.cards = {};
  w.pendingRoster = null;
  w.lastWar = null;

  const rng = new RNG((w.seed ^ 0x9e3779b9) >>> 0);
  w.names = new NameGiver(rng);

  const base = answersToGenes(answers);
  for (let i = 0; i < 2; i++) {
    const genes = {}; const alleles = {};
    for (const n of GENE_NAMES) {
      const b = base[n] ?? 0.5;
      const v = clamp(b + rng.normal(0, 0.07), 0.04, 0.96);
      genes[n] = v;
      if (GENES[n].kind === 'mind') alleles[n] = [v, clamp(v + rng.normal(0, 0.16), 0.04, 0.96)];
    }
    normalizeArms(genes);
    // 創世の二匹は最初から畑に立たせる。無役で始めると初手を打つ前に餓死しうる。
    const ind = makeIndividual(w.nextId++, FOUNDERS[i], {
      genes, age: 4, sex: i, born: 0, role: ROLE.FARM,
    });
    ind.alleles = alleles;
    ind.lineage = { self: 1 };
    for (const n of GENE_NAMES) ind.expressed[n] = true;   // 創世の二匹は全部開いている
    ind.skills['農技'] = 0.14; ind.skills['狩技'] = 0.10;
    w.people.set(ind.id, ind);
  }
  ev(w, '創世', { text: '二匹が置かれた。', revealed: true });
  w.history.push(snapshot(w));
  return w;
}

function answersToGenes(answers) {
  const g = {};
  for (const a of answers || []) {
    if (!a || !a.effects) continue;
    for (const k in a.effects) g[k] = (g[k] ?? 0.5) + a.effects[k];
  }
  for (const k in g) g[k] = clamp(g[k], 0.05, 0.95);
  return g;
}

/** 対抗アームの合計に上限。片側が強いと反対側が弱くなる＝全ステ最強を構造で禁じる。 */
function normalizeArms(genes) {
  for (const ch in CHROMOSOMES) {
    if (ch === '0') continue;
    const { A, B } = CHROMOSOMES[ch];
    if (!A.length || !B.length) continue;
    const mA = A.reduce((s, k) => s + genes[k], 0) / A.length;
    const mB = B.reduce((s, k) => s + genes[k], 0) / B.length;
    const over = (mA + mB) - 1.06;
    if (over > 0) {
      const f = 1.06 / (mA + mB);
      for (const k of A) genes[k] = clamp(genes[k] * f, 0.03, 0.97);
      for (const k of B) genes[k] = clamp(genes[k] * f, 0.03, 0.97);
    }
  }
}

function snapshot(w) {
  return { gen: w.gen, pop: w.people.size, yieldRate: w.yieldRate, consumption: w.consumption,
    morale: w.morale, food: w.food, grudge: w.regimeGrudge };
}

// ---------------------------------------------------------------- 実効値

/** 国民力 = f(素質 × 発現 × 練度, 年齢, 疲労・傷病)。忠誠は絶対に含めない。 */
export function powerOf(ind) {
  const exp = (k) => (ind.expressed && ind.expressed[k] ? 1 : 0.55);
  const atk = G(ind, '攻撃素質') * exp('攻撃素質') * (0.45 + 0.55 * S(ind, '戦技'));
  const dex = G(ind, '器用') * exp('器用') * (0.45 + 0.55 * S(ind, '農技'));
  const hunt = G(ind, '感応') * exp('感応') * (0.45 + 0.55 * S(ind, '狩技'));
  const lead = G(ind, '統率素質') * exp('統率素質') * (0.45 + 0.55 * S(ind, '統率'));
  const body = 0.5 * (G(ind, '頑健') + G(ind, '代謝'));
  const mind = 0.5 * (G(ind, '知性') + G(ind, '技術習得'));
  let p = 22 * atk + 20 * dex + 16 * hunt + 14 * lead + 16 * body + 12 * mind;
  const life = lifespanOf(ind);
  const t = clamp(ind.age / life);
  p *= (0.55 + 0.75 * Math.sin(Math.PI * clamp(t * 1.15))); // 若すぎ・老いすぎで落ちる
  p *= (1 - 0.30 * clamp(ind.fatigue)) * (ind.wounded ? 0.78 : 1);
  return Math.max(0, p);
}

export function lifespanOf(ind) { return 14 + 16 * G(ind, '寿命') + 6 * G(ind, '頑健'); }

/** 国力：意図的に情報を捨てるスカラー */
export function nationPower(w) {
  let s = 0;
  for (const p of w.people.values()) s += powerOf(p);
  return Math.round(s * (0.75 + 0.5 * (w.morale ?? 0.5)) + w.food * 0.4);
}

/** 自国民は実値、外国人は階級（上位1% / 以降10%刻み） */
export function publicRank(w, ind) {
  // 外国人（国境で処理待ちの捕虜）は相手国内での階級しか見えない。
  // 一度国に入れたら自国民なので実値が見える。
  if (ind.rankPct != null && !w.people.has(ind.id)) {
    return { pct: ind.rankPct, label: `上位 ${ind.rankPct}%` };
  }
  const mine = [...w.people.values()].map(powerOf).sort((a, b) => b - a);
  const p = powerOf(ind);
  const idx = mine.findIndex(v => v <= p);
  const r = mine.length ? clamp((idx < 0 ? mine.length : idx) / mine.length, 0, 1) : 0.5;
  const pct = r <= 0.01 ? 1 : Math.max(10, Math.ceil(r * 10) * 10);
  return { pct, label: `上位 ${pct}%`, value: Math.round(p) };
}

// ---------------------------------------------------------------- 練度と発現

const ROLE_EXPRESS = {
  [ROLE.HUNT]: ['攻撃素質', '感応', '胆力', '頑健', '好奇心'],
  [ROLE.FARM]: ['器用', '勤勉', '共同作業適性', '代謝'],
  [ROLE.DRILL]: ['攻撃素質', '技術習得', '統率素質', '団結傾向'],
  [ROLE.WAR]: ['攻撃素質', '胆力', '保身', '従順', '誇り'],
  [ROLE.IDLE]: ['私欲', '怠惰'],
};

function train(w, p, skill, amt) {
  const rate = 0.55 + 0.9 * G(p, '技術習得');
  const envF = p.district === DISTRICT.FRONTIER ? 1.28 : 1.0;   // 才能の産地は辺境
  p.skills[skill] = clamp((p.skills[skill] || 0) + amt * rate * envF * (1 - 0.55 * (p.skills[skill] || 0)));
}

function express(w, p) {
  const list = ROLE_EXPRESS[p.role] || [];
  for (const k of list) {
    if (!p.expressed[k] && GENE_NAMES.includes(k)) {
      p.expressed[k] = true;
      if (G(p, k) > 0.82) ev(w, '発現', { actor: p.id, revealed: true, text: `${p.name} の ${k} が開いた。` });
    }
  }
}

// ---------------------------------------------------------------- tick

export function stepTick(w, rng) {
  const out = [];
  w.tick++;
  const ppl = [...w.people.values()];
  let yieldSum = 0;

  for (const p of ppl) {
    if (p.role === ROLE.CHILD) { p.fatigue = clamp(p.fatigue - 0.02); continue; }
    express(w, p);
    switch (p.role) {
      case ROLE.FARM: {
        yieldSum += 0.160 * (0.4 + 0.6 * G(p, '器用')) * (0.5 + 0.9 * S(p, '農技')) * (0.6 + 0.7 * G(p, '勤勉'));
        train(w, p, '農技', 0.012);
        p.fatigue = clamp(p.fatigue + 0.0030);
        break;
      }
      case ROLE.HUNT: {
        yieldSum += 0.190 * (0.4 + 0.6 * G(p, '攻撃素質')) * (0.5 + 0.9 * S(p, '狩技'));
        train(w, p, '狩技', 0.014); train(w, p, '戦技', 0.006); train(w, p, '恐怖耐性', 0.004);
        p.fatigue = clamp(p.fatigue + 0.0045);
        if (rng.next() < 0.0035 * (1.4 - G(p, '頑健'))) {
          p.wounded = true;
          out.push(ev(w, '負傷', { actor: p.id, revealed: true, text: `${p.name} が狩りで傷を負った。` }));
        }
        break;
      }
      case ROLE.DRILL: {
        train(w, p, '戦技', 0.016); train(w, p, '恐怖耐性', 0.010);
        train(w, p, '統率', 0.006 * (0.3 + G(p, '統率素質')));
        p.fatigue = clamp(p.fatigue + 0.0035);
        break;
      }
      default:
        p.fatigue = clamp(p.fatigue - 0.012);
        p.unmet = clamp(p.unmet + 0.004 * G(p, '感受性'));
        break;
    }
    if (p.wounded && rng.next() < 0.02 * G(p, '頑健')) p.wounded = false;
  }

  w.yieldRate = yieldSum;
  w.consumption = ppl.length * 0.045 * (w.cards.mercy?.on ? 1.06 : 1.0);
  w.food = Math.max(0, w.food + (w.yieldRate - w.consumption));
  w.density = clamp(ppl.length / (34 + w.tech * 12));
  w.tech = w.tech + 0.00035 * ppl.reduce((s, p) => s + G(p, '知性'), 0);

  const hungry = w.food < 3;
  w.morale = clamp(w.morale + (hungry ? -0.006 : 0.0022) - w.regimeGrudge * 0.0009 - w.density * 0.0008, 0.02, 1);
  w.collapsing = (w.yieldRate < w.consumption) && w.food < 6;

  // 産出低下は「なぜ」が数字の中にない代表例。真の原因は隠し、局長の言い分だけを載せる。
  if (w.gen > 0 && w.tick % 24 === 0 && w.yieldRate < w.consumption * 0.92) {
    const chief = w.bureaus.agri ? w.people.get(w.bureaus.agri) : null;
    const upstream = lastEventOfKinds(w, ['誅殺', '配役', '具申可否', '捕虜']);
    const e = ev(w, '産出低下', {
      actor: chief ? chief.id : null,
      trueCause: upstream ? upstream.id : null,
      claimed: chief ? excuseOf(chief) : '原因は分からない。',
      revealed: w.intel >= 2,
      effects: [{ field: '産出率', delta: -(w.consumption - w.yieldRate) }],
      text: '産出が消費を下回っている。',
    });
    out.push(e);
  }
  return out;
}

function excuseOf(chief) {
  if (!chief) return '原因は分からない。';
  if (G(chief, '保身') > 0.6) return '天候のせいです。人にはどうにもなりません。';
  if (G(chief, '野心') > 0.6) return '軍務局が人を取りすぎたせいです。';
  if (G(chief, '誇り') > 0.65) return '問題ありません。じきに戻ります。';
  if (G(chief, '他責') > 0.6) return '辺境の連中が働かないのです。';
  return '土地が痩せてきています。人手が足りません。';
}

function lastEventOfKinds(w, kinds) {
  for (let i = w.events.length - 1; i >= 0; i--) if (kinds.includes(w.events[i].kind)) return w.events[i];
  return null;
}

// ---------------------------------------------------------------- 世代

export function advanceGeneration(w, rng) {
  const out = [];
  w.gen++;

  // 加齢と死。世代の切れ目で疲労は抜ける（抜けないと全員が上限に張り付く）。
  for (const p of [...w.people.values()]) {
    p.age++;
    p.fatigue = clamp(p.fatigue - 0.55);
    const life = lifespanOf(p);
    let risk = Math.max(0, (p.age - life * 0.68) / (life * 0.5)) * 0.55;
    if (w.food <= 0.5) risk += 0.10;
    if (p.wounded) risk += 0.03;
    if (p.age >= 3 && rng.next() < risk) out.push(die(w, p, '寿命'));
  }

  // 幼体の成熟。発現ウィンドウを抜けたら無役として出てくる。
  const MATURE = 2;
  for (const p of w.people.values()) {
    if (p.role === ROLE.CHILD && p.age >= MATURE) {
      p.role = ROLE.IDLE;
      out.push(ev(w, '成熟', { actor: p.id, revealed: true, text: `${p.name} が働ける歳になった。` }));
    }
  }

  // フェーズ2以降はオーナーの手を離れ、局長が自分の条件式で配役する。
  if (w.phase !== PHASE.VILLAGE) { const e = bureauCasting(w, rng); if (e) out.push(e); }

  // 出産
  out.push(...breed(w, rng));

  // 体制怨恨は消えない。緩やかにしか薄まらない。
  w.regimeGrudge = Math.max(0, w.regimeGrudge - 0.06);

  // フェーズ1の終わり：10体で隣のシャーレが見える
  if (w.phase === PHASE.VILLAGE && w.people.size >= 10 && !w.warReady) {
    w.warReady = true;
    out.push(ev(w, 'フェーズ', { revealed: true, text: '村が10体に達した。隣のシャーレが見つかった。' }));
  }
  // フェーズ2は100体になるまでに何度も戦争する。数世代おきに相手が現れる。
  if (w.phase === PHASE.TRIBE && !w.warReady && w.people.size >= 10
      && (w.gen - (w.lastWarGen ?? -99)) >= 2) {
    w.warReady = true;
    out.push(ev(w, '接触', { revealed: true, text: '別のシャーレが接近している。' }));
  }

  w.history.push(snapshot(w));
  if (w.history.length > 400) w.history.shift();
  w._petitions = [];
  return out;
}

/**
 * 局長による大量配役。オーナーはカードと数値までしか置けない。
 * その数字を局長の人格が歪めてから、実際の配役になる。
 * 「30%と命じたのに、頑迷な局長は40%でやった」は読める歪み。設計として残す側。
 */
function bureauCasting(w, rng) {
  const list = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
  if (!list.length) return null;
  const mil = w.bureaus.military ? w.people.get(w.bureaus.military) : null;
  const agr = w.bureaus.agri ? w.people.get(w.bureaus.agri) : null;

  const distort = (chief, v) => {
    if (!chief) return v;
    let d = 0;
    if (G(chief, '頑迷') > 0.6) d += 10;   // 命じた数字を超えてやる
    if (G(chief, '野心') > 0.6) d += 8;    // 自分の局を膨らませる
    if (G(chief, '保身') > 0.6) d -= 8;    // 責任を取りたくないので控える
    return Math.max(0, Math.min(100, v + d));
  };

  const orderedDrill = w.cards.drill_share?.on ? (w.cards.drill_share.value ?? 20) : 0;
  const orderedFarm = w.cards.farm_share?.on ? (w.cards.farm_share.value ?? 55) : 55;
  const drill = distort(mil, orderedDrill);
  const farm = distort(agr, orderedFarm);

  // 備蓄が下限を割ったら畑へ寄せる
  const floor = w.cards.stock_floor?.on ? (w.cards.stock_floor.value ?? 0) : 0;
  const farmAdj = w.food < floor ? Math.min(100, farm + 20) : farm;

  const sorted = [...list].sort((a, b) => (G(b, '攻撃素質') + S(b, '戦技')) - (G(a, '攻撃素質') + S(a, '戦技')));
  const n = sorted.length;
  const nD = Math.round(n * drill / 100);
  const nF = Math.round(n * farmAdj / 100);
  sorted.forEach((p, i) => {
    if (i < nD) p.role = ROLE.DRILL;
    else if (i < nD + nF) p.role = ROLE.FARM;
    else p.role = ROLE.HUNT;
  });

  const gapD = drill - orderedDrill, gapF = farmAdj - orderedFarm;
  if (Math.abs(gapD) >= 8 && mil) {
    return ev(w, '配役', {
      actor: mil.id, revealed: true,
      text: `${mil.name} は模擬戦を ${orderedDrill}% と命じられて ${drill}% でやった。`,
    });
  }
  if (Math.abs(gapF) >= 8 && agr) {
    return ev(w, '配役', {
      actor: agr.id, revealed: true,
      text: `${agr.name} は畑を ${orderedFarm}% と命じられて ${farmAdj}% でやった。`,
    });
  }
  return null;
}

function die(w, p, cause) {
  p.alive = false; p.deathGen = w.gen; p.deathCause = cause;
  w.people.delete(p.id);
  w.dead.set(p.id, p);
  // 個人怨恨は本人の死で消える
  for (const q of w.people.values()) if (q.grudges[p.id]) delete q.grudges[p.id];
  // 局長が死んだら椅子を空ける。放っておくと死人のidが局に残り、
  // 報告も具申も止まったまま理由が画面に出ない。
  for (const key in w.bureaus) {
    if (w.bureaus[key] === p.id) {
      w.bureaus[key] = null;
      ev(w, '空位', { actor: p.id, revealed: true, text: `${BUREAU_LABEL[key]}長が死んだ。椅子が空いている。` });
    }
  }
  return ev(w, '死亡', { actor: p.id, revealed: true, text: `${p.name} が死んだ（${cause}）。` });
}

function breed(w, rng) {
  const out = [];
  const adults = [...w.people.values()].filter(p => p.role !== ROLE.CHILD && p.age >= 3 && p.age < lifespanOf(p) * 0.8);
  if (adults.length < 2) return out;

  const mix = w.cards.mix_policy?.on ? (w.cards.mix_policy.value ?? 60) / 100 : 0;
  // 備蓄が扶養力の上限を決める。ただし食料が積み上がっても無限には増えない。
  const capacity = 7 + Math.min(w.food, 60) * 0.45;
  const crowd = clamp(w.people.size / 110);
  let budget = Math.max(0, Math.round((capacity - w.people.size * 0.35) * (1 - 0.75 * crowd)));
  if (w.food < 2) budget = 0;

  const males = rng.shuffle(adults.filter(p => p.sex === 0));
  const females = rng.shuffle(adults.filter(p => p.sex === 1));
  if (!males.length || !females.length) return out;

  for (const f of females) {
    if (budget <= 0) break;
    if (rng.next() > 0.45 + 0.55 * G(f, '繁殖性')) continue;
    // 相手選び：融和度が低いと同じ血統を選ぶ＝斑が固定される
    let cands = males;
    const same = cands.filter(m => dominantStrain(m) === dominantStrain(f));
    if (!rng.bool(mix) && same.length) cands = same;
    const m = cands[rng.int(cands.length)];
    // 一腹の数は繁殖性で決まる。住人はカビなので一度に複数産む。
    let litter = 1;
    if (rng.bool(G(f, '繁殖性'))) litter++;
    if (rng.bool(G(f, '繁殖性') * 0.45)) litter++;
    for (let k = 0; k < litter && budget > 0; k++) {
      const child = conceive(w, m, f, rng);
      w.people.set(child.id, child);
      budget--;
      out.push(ev(w, '出生', {
        actor: child.id, target: f.id, revealed: true,
        text: `${child.name} が生まれた（${m.name} × ${f.name}）。`,
      }));
    }
  }
  return out;
}

export function dominantStrain(ind) {
  let best = 'self', bv = -1;
  const L = ind.lineage || { self: 1 };
  for (const k in L) if (L[k] > bv) { bv = L[k]; best = k; }
  return best;
}

function conceive(w, dad, mom, rng) {
  const genes = {}; const alleles = {};

  // 体系：中間遺伝（親の平均にゆらぎ）
  for (const k of BODY_GENES) {
    genes[k] = clamp((G(dad, k) + G(mom, k)) / 2 + rng.normal(0, 0.055), 0.03, 0.97);
  }
  // 心系：離散の優性/劣性。アレル対を持たせるので劣性が数世代潜伏する。
  const plast = ((G(dad, '可塑') + G(mom, '可塑')) / 2);
  const armPick = {};
  for (const k of MIND_GENES) {
    const ch = GENES[k].ch, arm = GENES[k].arm, key = ch + arm;
    if (armPick[key] === undefined || rng.bool(plast)) armPick[key] = rng.bool() ? 0 : 1;   // 可塑=交叉率
    const pick = armPick[key];
    const a = pickAllele(dad, k, pick, rng);
    const b = pickAllele(mom, k, 1 - pick, rng);
    const mutate = (v) => (rng.next() < 0.03 ? clamp(v + rng.normal(0, 0.20), 0.03, 0.97) : v);
    const pair = [mutate(a), mutate(b)];
    alleles[k] = pair;
    genes[k] = Math.max(pair[0], pair[1]);     // 高いほうが優性。低いほうは潜伏する
  }
  normalizeArms(genes);

  const child = makeIndividual(w.nextId++, w.names.take(), {
    genes, age: 0, sex: rng.int(2), born: w.gen, role: ROLE.CHILD,
    fatherId: dad.id, motherId: mom.id,
    district: rng.bool(0.5) ? dad.district : mom.district,
  });
  child.alleles = alleles;
  child.lineage = mergeLineage(dad.lineage, mom.lineage);
  // 体制怨恨は家系に継承される
  child.inheritedGrudge = ((dad.inheritedGrudge || 0) + (mom.inheritedGrudge || 0)) / 2;
  return child;
}

function pickAllele(parent, k, which, rng) {
  const pair = parent.alleles && parent.alleles[k];
  if (!pair) return clamp(G(parent, k) + rng.normal(0, 0.05), 0.03, 0.97);
  return pair[which % 2];
}

export function mergeLineage(a, b) {
  const out = {};
  for (const k in (a || { self: 1 })) out[k] = (out[k] || 0) + (a[k] || 0) * 0.5;
  for (const k in (b || { self: 1 })) out[k] = (out[k] || 0) + (b[k] || 0) * 0.5;
  let tot = 0;
  for (const k in out) { if (out[k] < 0.015) delete out[k]; else tot += out[k]; }
  for (const k in out) out[k] /= (tot || 1);
  return out;
}

// ---------------------------------------------------------------- 「置く」

export function assignRole(w, id, role) {
  const p = w.people.get(id);
  if (!p) return null;
  const prev = p.role;
  if (prev === role) return null;
  p.role = role;
  return ev(w, '配役', {
    actor: id, revealed: true,
    text: `${p.name} を ${roleLabel(prev)} から ${roleLabel(role)} へ回した。`,
  });
}

export function setDistrict(w, id, district) {
  const p = w.people.get(id);
  if (!p || p.district === district) return null;
  p.district = district;
  return ev(w, '移住', {
    actor: id, revealed: true,
    text: `${p.name} を ${district === DISTRICT.FRONTIER ? '辺境' : '中心'} へ移した。`,
  });
}

export function appointBureau(w, key, id) {
  const prev = w.bureaus[key] ? w.people.get(w.bureaus[key]) : null;
  if (prev) { prev.bureau = null; prev.grudges[-1] = (prev.grudges[-1] || 0) + 0.3; }
  const p = id == null ? null : w.people.get(id);
  w.bureaus[key] = p ? p.id : null;
  if (p) { p.bureau = key; p.titles.push(`${BUREAU_LABEL[key]}長`); }
  return ev(w, '任命', {
    actor: p ? p.id : null, revealed: true,
    text: p ? `${p.name} を ${BUREAU_LABEL[key]}長に据えた。` : `${BUREAU_LABEL[key]}長を空位にした。`,
  });
}

export function setCard(w, cardId, on, value) {
  w.cards[cardId] = { on: !!on, value: Number.isFinite(value) ? value : (w.cards[cardId]?.value ?? 0) };
  return w.cards[cardId];
}

export function roleLabel(r) {
  return { idle: '無役', farm: '畑', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '幼体' }[r] || r;
}

// ---------------------------------------------------------------- 検索

export function search(w, filters = {}) {
  const {
    role = null, district = null, ageMin = null, ageMax = null,
    gene = null, geneMin = 0, strain = null, includeDead = false,
    sort = 'power', desc = true, limit = 400,
  } = filters;
  let list = [...w.people.values()];
  if (includeDead) list = list.concat([...w.dead.values()]);
  list = list.filter(p => {
    if (role && p.role !== role) return false;
    if (district && p.district !== district) return false;
    if (ageMin != null && p.age < ageMin) return false;
    if (ageMax != null && p.age > ageMax) return false;
    if (strain && dominantStrain(p) !== strain) return false;
    if (gene && G(p, gene) < geneMin) return false;
    return true;
  });
  const key = (p) => {
    if (sort === 'power') return powerOf(p);
    if (sort === 'age') return p.age;
    if (sort === 'training') return SKILLS.reduce((s, k) => s + S(p, k), 0) / SKILLS.length;
    if (sort === 'name') return p.name;
    if (GENE_NAMES.includes(sort)) return G(p, sort);
    return powerOf(p);
  };
  list.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (typeof ka === 'string') return desc ? String(kb).localeCompare(ka) : String(ka).localeCompare(kb);
    return desc ? kb - ka : ka - kb;
  });
  return list.slice(0, limit);
}

// ---------------------------------------------------------------- 年代記

export function chronicle(w, filters = {}) {
  const { kinds = null, genMin = null, genMax = null, actor = null, limit = 300 } = filters;
  let list = w.events.filter(e => {
    if (kinds && !kinds.includes(e.kind)) return false;
    if (genMin != null && e.gen < genMin) return false;
    if (genMax != null && e.gen > genMax) return false;
    if (actor != null && e.actor !== actor && e.target !== actor) return false;
    return true;
  });
  return list.slice(-limit).reverse();
}

/** 上流（何が原因か）。ただし開示されているのは revealed な事件だけ。 */
export function traceUp(w, eventId) {
  const out = [];
  let e = w.events.find(x => x.id === eventId);
  let guard = 0;
  while (e && e.trueCause != null && guard++ < 16) {
    const up = w.events.find(x => x.id === e.trueCause);
    if (!up) break;
    out.push(up);
    e = up;
  }
  return out;
}

/** 下流（何を引き起こしたか） */
export function traceDown(w, eventId) {
  return w.events.filter(e => e.trueCause === eventId);
}

/** 「編む」：正史の決定。公表された帰属を確定させる。 */
export function canonize(w, eventId, text, { truthful = true } = {}) {
  const e = w.events.find(x => x.id === eventId);
  if (!e) return null;
  e.canon = text;
  if (truthful) { w.regimeGrudge += 1.2; e.revealed = true; }
  else { w.regimeGrudge += 0.0; e.canonRisk = true; }
  return ev(w, '正史', {
    trueCause: eventId, revealed: true,
    text: `第${e.gen}世代の${e.kind}を「${text}」として確定させた。`,
  });
}

// ---------------------------------------------------------------- 具申

const PETITION_TEMPLATES = [
  {
    key: 'budget', bureau: 'military', need: (w) => w.warsFought > 0,
    title: '演習の頻度を上げたい',
    detail: (w, c) => `${c.name}「兵の練度が足りません。模擬戦に回す人手を増やさせてください。畑は少し痩せます。」`,
    approve: (w) => { bumpCard(w, 'drill_share', +15); w.morale -= 0.02; },
    reject: (w, c) => { grudge(w, c, 0.25); },
    gain: '軍務局（人手と発言力）', lose: '農業局（産出）',
  },
  {
    key: 'purge', bureau: 'military', need: (w) => w.regimeGrudge > 2,
    title: '不穏な家系を締めたい',
    detail: (w, c) => `${c.name}「辺境に不満を口にする者がいます。今のうちに見せしめを。」`,
    approve: (w) => { w.regimeGrudge += 2.4; w.morale -= 0.06; },
    reject: (w, c) => { grudge(w, c, 0.3); },
    gain: '軍務局（統制）', lose: '辺境の家系（体制怨恨が積む）',
  },
  {
    key: 'stock', bureau: 'agri', need: (w) => w.food < 22,
    title: '備蓄の下限を上げたい',
    detail: (w, c) => `${c.name}「今の備蓄では一度の凶作で終わります。畑に人を寄せさせてください。」`,
    approve: (w) => { bumpCard(w, 'farm_share', +15); bumpCard(w, 'stock_floor', +10); },
    reject: (w, c) => { grudge(w, c, 0.2); },
    gain: '農業局（人手）', lose: '軍務局（兵が減る）',
  },
  {
    key: 'frontier', bureau: 'agri', need: () => true,
    title: '辺境を耕させてほしい',
    detail: (w, c) => `${c.name}「辺境の土地が遊んでいます。産出は落ちますが、人は育ちます。」`,
    approve: (w) => { setCard(w, 'frontier_farm', true, 0); },
    reject: (w, c) => { grudge(w, c, 0.15); },
    gain: '辺境の家系（練度の伸び）', lose: '中心の家系（人手が抜ける）',
  },
  {
    key: 'mix', bureau: 'civil', need: (w) => w.warsFought > 0,
    title: '外来の血を国民として扱いたい',
    detail: (w, c) => `${c.name}「よそ者を隔てたままでは畑が回りません。混ぜてしまうべきです。」`,
    approve: (w) => { bumpCard(w, 'mix_policy', +25); w.morale -= 0.03; },
    reject: (w) => { w.regimeGrudge += 0.8; },
    gain: '外来の家系（居場所）', lose: '自国産の古い家系（不満）',
  },
  {
    key: 'mercy', bureau: 'civil', need: (w) => w.people.size > 6,
    title: '傷病者を養いたい',
    detail: (w, c) => `${c.name}「働けない者を切り捨てれば、次は自分だと皆が思います。」`,
    approve: (w) => { setCard(w, 'mercy', true, 0); w.morale += 0.05; },
    reject: (w) => { w.regimeGrudge += 1.0; w.morale -= 0.04; },
    gain: '民生局（民心）', lose: '備蓄（消費が増える）',
  },
  {
    key: 'accuse', bureau: 'military', need: (w) => w.bureaus.agri != null,
    title: '農業局長を調べさせてほしい',
    detail: (w, c) => `${c.name}「産出の帳尻が合いません。農業局が何か隠しています。」`,
    approve: (w) => { const a = w.people.get(w.bureaus.agri); if (a) grudge(w, a, 0.5); w.morale -= 0.02; },
    reject: (w, c) => { grudge(w, c, 0.3); },
    gain: '軍務局（他局への影響力）', lose: '農業局長（讒言を受ける）',
  },
];

function bumpCard(w, id, d) {
  const c = w.cards[id] || { on: true, value: 0 };
  setCard(w, id, true, clamp((c.value || 0) + d, 0, 100));
}
function grudge(w, ind, v) { if (ind) ind.grudges[-1] = (ind.grudges[-1] || 0) + v; }

export function petitions(w, rng) {
  if (w._petitions && w._petitions.length) return w._petitions;
  const list = [];
  const chiefs = Object.entries(w.bureaus).filter(([, id]) => id != null);
  if (!chiefs.length) return [];
  const pool = PETITION_TEMPLATES.filter(t => t.need(w) && w.bureaus[t.bureau] != null);
  const shuffled = rng.shuffle([...pool]);
  const n = Math.min(shuffled.length, 2 + rng.int(3));
  for (let i = 0; i < n; i++) {
    const t = shuffled[i];
    const chief = w.people.get(w.bureaus[t.bureau]);
    if (!chief) continue;
    list.push({
      id: `${w.gen}:${t.key}`,
      tkey: t.key,
      gen: w.gen,
      bureau: t.bureau,
      bureauLabel: BUREAU_LABEL[t.bureau],
      fromId: chief.id,
      fromName: chief.name,
      title: t.title,
      detail: t.detail(w, chief),
      gain: t.gain,
      lose: t.lose,
      // 「誰が誰に何を賭けているか」を読ませるための材料
      motive: motiveOf(chief),
      risk: G(chief, '野心') > 0.6 ? '野心が高い。これは要望ではなく手だ。' :
            G(chief, '保身') > 0.6 ? '保身が高い。責任の逃げ道を作ろうとしている。' :
            G(chief, '誇り') > 0.65 ? '誇りが高い。断れば助けを求めなくなる。' : null,
    });
  }
  w._petitions = list;
  return list;
}

function motiveOf(c) {
  const parts = [];
  if (G(c, '野心') > 0.55) parts.push(`野心 ${Math.round(G(c, '野心') * 100)}`);
  if (G(c, '保身') > 0.55) parts.push(`保身 ${Math.round(G(c, '保身') * 100)}`);
  if (G(c, '誇り') > 0.55) parts.push(`誇り ${Math.round(G(c, '誇り') * 100)}`);
  if (G(c, '勤勉') > 0.6) parts.push(`勤勉 ${Math.round(G(c, '勤勉') * 100)}`);
  return parts.join(' / ') || '目立った偏りはない';
}

export function resolvePetition(w, id, approve, rng) {
  const list = w._petitions || [];
  const i = list.findIndex(p => p.id === id);
  if (i < 0) return [];
  const p = list[i];
  const t = PETITION_TEMPLATES.find(x => x.key === p.tkey);
  const chief = w.people.get(p.fromId);
  if (t) (approve ? t.approve : t.reject)(w, chief, rng);
  list.splice(i, 1);
  return [ev(w, '具申可否', {
    actor: p.fromId, revealed: true,
    trueCause: null,
    claimed: approve ? '許した' : '退けた',
    text: `${p.fromName} の具申「${p.title}」を${approve ? '承認' : '却下'}した。`,
  })];
}

// ---------------------------------------------------------------- 対戦相手

// 色相の割り当てには制約が2つある。
//  1. プレイヤーの自国（赤 = 0）から最低60度離す。近い色を混ぜると
//     「捕虜が1体入った瞬間に色が違う」が成立せず、看板がまるごと死ぬ。
//  2. 赤の対蹠点（180度付近）を空ける。0度とほぼ正反対の色相を混ぜると
//     円環上の中点がどちら回りか不安定になり、似た親から正反対の子色が出る。
// よって 60..156 と 204..300 の2帯に散らす。混色は必ず「親の間」に落ちる。
const PROFILES = [
  { id: 'laissez',  name: '放任',   hue: 60,  desc: 'ほとんど何もしない。局長に丸投げ。' },
  { id: 'agrarian', name: '農本',   hue: 84,  desc: '産出優先。備蓄を厚く。戦争は最小限。' },
  { id: 'dynastic', name: '世襲',   hue: 108, desc: '局長の血統を固定。透過率を最小に。' },
  { id: 'merit',    name: '実力主義', hue: 132, desc: '素質上位を抜擢。家柄を無視する。' },
  { id: 'pious',    name: '信仰',   hue: 156, desc: '信仰性・団結傾向を選抜。排他的で捕虜を拒む。' },
  { id: 'purist',   name: '純血',   hue: 204, desc: '捕虜をほぼ誅殺。自国産の血だけで回す。' },
  { id: 'terror',   name: '恐怖',   hue: 228, desc: '怨恨を無視して粛清を多用。従順を選抜。' },
  { id: 'melting',  name: '融和',   hue: 252, desc: '捕虜を全部受け入れる。混血を最大化。' },
  { id: 'martial',  name: '武断',   hue: 276, desc: '狩りと実戦に厚く配役する。降伏しない。' },
  { id: 'fecund',   name: '多産',   hue: 300, desc: '繁殖性優先。質より量。密度ストレスを許容。' },
];

const PROFILE_ANSWERS = {
  martial:  [{ effects: { 胆力: +0.3, 攻撃素質: +0.25, 保身: -0.2, 誇り: +0.2 } }],
  agrarian: [{ effects: { 勤勉: +0.3, 器用: +0.25, 野心: -0.2, 共同作業適性: +0.2 } }],
  fecund:   [{ effects: { 繁殖性: +0.35, 情愛: +0.2, 知性: -0.15 } }],
  purist:   [{ effects: { 頑迷: +0.3, 序列意識: +0.25, 柔軟: -0.25, 懐疑: +0.2 } }],
  melting:  [{ effects: { 柔軟: +0.3, 共同作業適性: +0.25, 頑迷: -0.25, 好奇心: +0.2 } }],
  terror:   [{ effects: { 非情: +0.35, 従順: +0.25, 情愛: -0.3 } }],
  laissez:  [{ effects: { 自律: +0.25, 私欲: +0.2, 勤勉: -0.2 } }],
  pious:    [{ effects: { 信仰性: +0.35, 団結傾向: +0.3, 懐疑: -0.25 } }],
  merit:    [{ effects: { 技術習得: +0.3, 知性: +0.25, 序列意識: -0.25 } }],
  dynastic: [{ effects: { 序列意識: +0.35, 世代間伝承意欲: +0.3, 自律: -0.2 } }],
};

const RIVAL_NAMES = ['錆のシャーレ', '苔のシャーレ', '霞のシャーレ', '灰のシャーレ', '藍のシャーレ',
  '緋のシャーレ', '梟のシャーレ', '蘇のシャーレ', '砂のシャーレ', '氷のシャーレ'];

/** 10国を作って数世代走らせる。プレイヤーの世界と同じ規則で動く。 */
export function createRoster(seed) {
  const rng = new RNG((seed ^ 0x5bf03635) >>> 0);
  const worlds = [];
  PROFILES.forEach((prof, i) => {
    const w = createWorld((seed * 7919 + i * 104729) >>> 0, PROFILE_ANSWERS[prof.id], {
      name: RIVAL_NAMES[i], profile: prof.id, hue: prof.hue, strainName: `${prof.name}の血`,
    });
    // プロファイルが自動でカードを敷く
    applyProfileCards(w, prof.id);
    const r = new RNG((w.seed ^ 0x2545f491) >>> 0);
    for (let g = 0; g < 5; g++) {
      for (let t = 0; t < 30; t++) stepTick(w, r);
      autoOwner(w, r);
      advanceGeneration(w, r);
    }
    worlds.push(w);
  });
  return { seed, worlds, rng };
}

function applyProfileCards(w, id) {
  const P = {
    martial:  { drill_share: 45, farm_share: 30, mix_policy: 40, send_top_pct: 90, surrender_at: 0 },
    agrarian: { drill_share: 5,  farm_share: 85, mix_policy: 50, send_top_pct: 30, surrender_at: 45 },
    fecund:   { drill_share: 10, farm_share: 75, mix_policy: 80, send_top_pct: 40, surrender_at: 40 },
    purist:   { drill_share: 25, farm_share: 60, mix_policy: 0,  send_top_pct: 60, surrender_at: 20 },
    melting:  { drill_share: 20, farm_share: 60, mix_policy: 100, send_top_pct: 50, surrender_at: 35 },
    terror:   { drill_share: 35, farm_share: 55, mix_policy: 20, send_top_pct: 80, surrender_at: 10 },
    laissez:  { drill_share: 15, farm_share: 50, mix_policy: 55, send_top_pct: 50, surrender_at: 30 },
    pious:    { drill_share: 25, farm_share: 65, mix_policy: 5,  send_top_pct: 55, surrender_at: 25 },
    merit:    { drill_share: 30, farm_share: 60, mix_policy: 70, send_top_pct: 100, surrender_at: 30 },
    dynastic: { drill_share: 20, farm_share: 65, mix_policy: 30, send_top_pct: 45, surrender_at: 30 },
  }[id] || {};
  for (const k in P) setCard(w, k, true, P[k]);
  setCard(w, 'child_protect', true, 3);
  setCard(w, 'mercy', id !== 'terror', 0);
}

/** ライバル国の自動オーナー。プロファイルに従って配役だけ撃つ。 */
function autoOwner(w, rng) {
  const farmShare = (w.cards.farm_share?.value ?? 55) / 100;
  const drillShare = (w.cards.drill_share?.value ?? 20) / 100;
  const list = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
  list.sort((a, b) => G(b, '攻撃素質') - G(a, '攻撃素質'));
  const nD = Math.round(list.length * drillShare);
  const nF = Math.round(list.length * farmShare);
  list.forEach((p, i) => {
    if (i < nD) p.role = ROLE.DRILL;
    else if (i < nD + nF) p.role = ROLE.FARM;
    else p.role = ROLE.HUNT;
  });
}

/** 通常は国力しか見せない。構成・人口・思想は伏せる。 */
export function listOpponents(roster) {
  if (!roster) return [];
  return roster.worlds.map(w => ({
    id: w.name,
    name: w.name,
    profile: w.profile,                  // ← デバッグ表示でのみ使うこと
    profileName: (PROFILES.find(p => p.id === w.profile) || {}).name,
    profileDesc: (PROFILES.find(p => p.id === w.profile) || {}).desc,
    hue: w.strains.self.hue,
    power: nationPower(w),
    pop: w.people.size,                  // ← デバッグ表示でのみ使うこと
    gen: w.gen,
    world: w,
  }));
}

/** 開発用デバッグのみ。 */
export function peek(roster, id) {
  if (!roster) return null;
  return roster.worlds.find(w => w.name === id) || null;
}

/** ロスターもプレイヤーと同時に走る。 */
export function stepRoster(roster, rng) {
  if (!roster) return;
  for (const w of roster.worlds) {
    const r = new RNG(((w.seed ^ (w.gen * 2654435761)) >>> 0) || 1);
    for (let t = 0; t < 24; t++) stepTick(w, r);
    autoOwner(w, r);
    advanceGeneration(w, r);
  }
}

/** ロスターが無いときの相手。 */
export function makeGhost(seed, phase = 1, power = 100) {
  const rng = new RNG(((seed ^ 0x27d4eb2f) >>> 0) || 1);
  const i = rng.int(PROFILES.length);
  return {
    id: 'ghost:' + seed, name: RIVAL_NAMES[i], profile: PROFILES[i].id,
    profileName: PROFILES[i].name, hue: PROFILES[i].hue,
    power: Math.round(power * rng.range(0.7, 1.35)), phase, seed, ghost: true,
  };
}

// ---------------------------------------------------------------- 戦闘

function warScore(p) {
  return powerOf(p) * (0.5 + 0.5 * G(p, '攻撃素質')) * (0.6 + 0.6 * S(p, '戦技'));
}

function makeFighter(ind, side, i, n, world) {
  return {
    id: `${side}${ind.id}`, indId: ind.id, side, ind, world,
    name: ind.name,
    hp: 1, fear: 0, state: 'fight', kills: 0,
    x: side === 'a' ? 0.20 : 0.80,
    y: n > 1 ? 0.14 + (0.72 * i) / (n - 1) : 0.5,
    hx: side === 'a' ? 0.20 : 0.80,
  };
}

/** opponent は listOpponents の要素、または makeGhost の返り値。 */
export function startWar(w, rng, opponent) {
  const size = w.phase === PHASE.VILLAGE ? 5 : Math.min(8, Math.max(5, Math.floor(w.people.size * 0.25)));

  // 派遣：カード「上位◯%を派遣」「◯歳以上は温存」に従う
  let pool = [...w.people.values()].filter(p => p.role !== ROLE.CHILD);
  const spare = w.cards.spare_elder?.on ? w.cards.spare_elder.value : null;
  if (spare != null) { const f = pool.filter(p => p.age < spare); if (f.length >= size) pool = f; }
  pool.sort((a, b) => warScore(b) - warScore(a));
  const topPct = (w.cards.send_top_pct?.value ?? 50) / 100;
  const cut = Math.max(size, Math.ceil(pool.length * topPct));
  const ours = rng.shuffle(pool.slice(0, cut)).slice(0, Math.min(size, pool.length));

  // 相手
  let theirs, foeName, foeHue, foeWorld = null, foeStrains = null;
  if (opponent && opponent.world) {
    foeWorld = opponent.world;
    foeName = opponent.name;
    foeHue = opponent.hue;
    foeStrains = foeWorld.strains;
    let fp = [...foeWorld.people.values()].filter(p => p.role !== ROLE.CHILD);
    fp.sort((a, b) => warScore(b) - warScore(a));
    theirs = fp.slice(0, Math.max(size, Math.ceil(fp.length * 0.6)));
    theirs = rng.shuffle(theirs).slice(0, size);
  } else {
    const g = opponent || makeGhost(w.seed + w.gen, w.phase, nationPower(w));
    foeName = g.name; foeHue = g.hue;
    theirs = spawnGhostSquad(g, size, w.gen);
    foeStrains = { self: { key: 'self', name: `${g.profileName || '外'}の血`, hue: g.hue } };
  }

  const battle = {
    id: `w${w.gen}`,
    seed: ((w.seed ^ (w.gen * 40503)) >>> 0) || 1,
    gen: w.gen, t: 0, over: false, outcome: null, surrendered: null,
    opponent: { id: opponent?.id || foeName, name: foeName, hue: foeHue, world: foeWorld, strains: foeStrains },
    a: { name: w.name, hue: w.strains.self.hue, cohesion: 1, base: 1, fighters: [], world: w },
    b: { name: foeName, hue: foeHue, cohesion: 1, base: 1, fighters: [], world: foeWorld },
    log: [],
    deaths: { a: [], b: [] },
  };
  battle.a.fighters = ours.map((p, i) => makeFighter(p, 'a', i, ours.length, w));
  battle.b.fighters = theirs.map((p, i) => makeFighter(p, 'b', i, theirs.length, foeWorld));
  battle.a.base = cohesionOf(battle.a);
  battle.b.base = cohesionOf(battle.b);
  blog(battle, `${w.name} と ${foeName} が衝突した。${ours.length} 対 ${theirs.length}。`, 'hi');
  w.lastWar = battle;
  return battle;
}

function spawnGhostSquad(g, size, gen) {
  const rng = new RNG(((g.seed ^ (gen * 2246822519)) >>> 0) || 1);
  const names = ['アグ', 'ベル', 'コル', 'ドラ', 'エゴ', 'ファ', 'グナ', 'ハザ'];
  const out = [];
  const scale = clamp(g.power / 900, 0.3, 1.3);
  for (let i = 0; i < size; i++) {
    const genes = {};
    for (const n of GENE_NAMES) genes[n] = clamp(0.35 + scale * 0.4 + rng.normal(0, 0.13), 0.05, 0.95);
    normalizeArms(genes);
    const ind = makeIndividual(-(i + 1), names[i % names.length] + '・' + (g.profileName || '外'), {
      genes, age: 5 + rng.int(9), sex: rng.int(2), role: ROLE.WAR,
    });
    for (const n of GENE_NAMES) ind.expressed[n] = true;
    for (const s of SKILLS) ind.skills[s] = clamp(rng.range(0.1, 0.35) + scale * 0.25);
    ind.lineage = { self: 1 };
    ind.foreignFrom = g.name;
    out.push(ind);
  }
  return out;
}

function cohesionOf(side) {
  const act = side.fighters.filter(f => f.state === 'fight');
  if (!side.fighters.length) return 0;
  const lead = side.fighters.reduce((m, f) => Math.max(m, G(f.ind, '統率素質') * (0.4 + 0.6 * S(f.ind, '統率'))), 0);
  const unity = side.fighters.reduce((s, f) => s + G(f.ind, '団結傾向'), 0) / side.fighters.length;
  const raw = act.length / side.fighters.length;
  return clamp(raw * (0.72 + 0.28 * unity) + 0.22 * lead * raw);
}

const COLLAPSE = 0.34;

export function stepBattle(battle, rng) {
  if (battle.over) return [];
  battle.t++;
  const out = [];

  for (const side of ['a', 'b']) {
    const me = battle[side], foe = battle[side === 'a' ? 'b' : 'a'];
    const pressure = 1 - clamp(me.cohesion);
    for (const f of me.fighters) {
      if (f.state === 'dead') continue;

      // 恐怖。恐怖耐性の練度と胆力が抑える。周りが崩れるほど上がる（カスケード）
      const grit = 0.5 * S(f.ind, '恐怖耐性') + 0.5 * G(f.ind, '胆力');
      f.fear = clamp(f.fear + (0.055 + 0.13 * pressure) * (1.25 - grit) - 0.012 * grit);

      if (f.state === 'fight' && f.fear > 0.74) {
        // 逃げるか、固まるか。保身が高いと逃げ、低いと固まる。
        if (G(f.ind, '保身') > 0.48) {
          f.state = 'flee';
          blog(battle, `${f.name} が背を向けた。`, 'flee');
          out.push({ kind: '逃走', name: f.name, side });
        } else {
          f.state = 'freeze';
          blog(battle, `${f.name} が固まって動かない。`, 'flee');
          out.push({ kind: '硬直', name: f.name, side });
        }
      }
      if ((f.state === 'flee' || f.state === 'freeze') && f.fear < 0.5 && rng.bool(0.3)) {
        f.state = 'fight';
        blog(battle, `${f.name} が戻った。`);
      }

      // 位置
      const dir = side === 'a' ? 1 : -1;
      if (f.state === 'fight') f.x += dir * 0.012 * (1 - Math.abs(f.x - 0.5) * 0.4);
      else if (f.state === 'flee') f.x -= dir * 0.026;
      f.x = clamp(f.x, 0.02, 0.98);
      f.y = clamp(f.y + rng.range(-0.006, 0.006), 0.06, 0.94);

      // 攻撃。標的は毎回引き直す。同じtick内で死んだ相手を殴り続けないため。
      const enemies = foe.fighters.filter(x => x.state !== 'dead');
      if (!enemies.length) continue;
      const mult = f.state === 'fight' ? 1 : (f.state === 'freeze' ? 0.15 : 0.05);
      const atk = (0.18 + 0.42 * G(f.ind, '攻撃素質') + 0.36 * S(f.ind, '戦技')) * mult;
      if (atk <= 0.02) continue;
      const tgt = enemies[rng.int(enemies.length)];
      const def = 0.28 + 0.55 * G(tgt.ind, '頑健') + 0.22 * S(tgt.ind, '恐怖耐性')
        + (tgt.state === 'flee' ? -0.22 : 0);
      // 係数が小さいのは意図的。勝敗は殲滅ではなく団結の崩壊で決まるので、
      // 恐怖が閾値に達するより先に全員が死んではいけない。戦死率は低く保つ。
      const dmg = Math.max(0.002, atk * rng.range(0.45, 1.3) * 0.050 / Math.max(0.35, def));
      tgt.hp -= dmg;
      if (tgt.hp <= 0 && tgt.state !== 'dead') {
        tgt.state = 'dead'; tgt.ind.alive = false; f.kills++;
        battle.deaths[tgt.side].push(tgt);
        blog(battle, `${tgt.name} が倒れた。（${f.name}）`, 'bad');
        out.push({ kind: '戦死', name: tgt.name, side: tgt.side, by: f.name });
      }
    }
  }

  battle.a.cohesion = cohesionOf(battle.a);
  battle.b.cohesion = cohesionOf(battle.b);

  const aDown = battle.a.cohesion <= COLLAPSE || battle.a.fighters.every(f => f.state === 'dead');
  const bDown = battle.b.cohesion <= COLLAPSE || battle.b.fighters.every(f => f.state === 'dead');
  if (aDown || bDown || battle.t > 160) {
    battle.over = true;
    if (aDown && !bDown) battle.outcome = 'lose';
    else if (bDown && !aDown) battle.outcome = 'win';
    else battle.outcome = battle.a.cohesion >= battle.b.cohesion ? 'win' : 'lose';
    blog(battle, battle.outcome === 'win'
      ? `${battle.b.name} の団結が折れた。敗走。`
      : `こちらの団結が折れた。敗走。`, battle.outcome === 'win' ? 'hi' : 'bad');
    out.push({ kind: '決着', outcome: battle.outcome });
  }
  return out;
}

function blog(b, text, cls = '') {
  b.log.push({ t: b.t, text, cls });
  if (b.log.length > 400) b.log.shift();
}

/** 降伏。早く折れば安く、粘るほど高い。受諾するかは勝者（＝相手）の裁定。 */
export function surrender(battle) {
  const ours = battle.a.cohesion, theirs = battle.b.cohesion;
  const gap = clamp(theirs - ours + 0.35, 0, 1.6);
  const late = clamp(1 - ours, 0, 1);
  const food = Math.round(4 + 30 * gap * (0.6 + late));
  const captives = Math.max(0, Math.round(gap * 2.2 * (0.5 + late)));
  const roll = (((battle.seed * 2654435761) + battle.t * 97) >>> 0) / 4294967296;
  // 圧勝している相手は殲滅を選ぶことがある（＝自分の取り分を捨てる）
  const accepted = !(gap > 1.15 && roll < 0.35);
  const terms = { food, captives, accepted, gap: +gap.toFixed(2) };
  if (accepted) {
    battle.over = true; battle.outcome = 'surrender'; battle.surrendered = terms;
    blog(battle, `降伏を申し入れた。受諾された。賠償：食料 ${food} / 人 ${captives}。`, 'hi');
  } else {
    blog(battle, `降伏を申し入れたが拒否された。追撃が来る。`, 'bad');
    battle.refused = true;
  }
  return terms;
}

// ---------------------------------------------------------------- 捕虜

const AXES = [
  { key: '攻撃素質', label: '武力' },
  { key: '知性', label: '知性' },
  { key: '繁殖性', label: '繁殖性' },
  { key: '器用', label: '器用' },
  { key: '統率素質', label: '統率' },
];

/** 勝者は相手の平均より上のプールから、敗者は全プールから抽選。 */
export function captiveOptions(battle) {
  const won = battle.outcome === 'win';
  const survivors = battle.b.fighters.filter(f => f.state !== 'dead').map(f => f.ind);
  let pool = survivors;
  if (won && survivors.length > 1) {
    const avg = survivors.reduce((s, p) => s + powerOf(p), 0) / survivors.length;
    const above = survivors.filter(p => powerOf(p) >= avg);
    if (above.length) pool = above;
  }
  // フェーズ1の終わりは1体。フェーズ2は戦ごとに1〜5体。
  const p1 = (battle.a.world?.phase ?? PHASE.VILLAGE) === PHASE.VILLAGE;
  const count = Math.min(pool.length, p1 ? 1 : 1 + ((battle.t + battle.seed) % 3));
  return {
    won,
    axes: won ? AXES : [],           // 軸を選べるのは勝者だけ
    count,
    poolSize: pool.length,
    pool: pool.map(p => ({ id: p.id, name: p.name })),
    note: won ? '相手の平均より上のプールから抽選する。' : '相手の全プールから抽選する。',
  };
}

export function takeCaptives(w, battle, axis, rng) {
  const opt = captiveOptions(battle);
  const survivors = battle.b.fighters.filter(f => f.state !== 'dead').map(f => f.ind);
  let pool = survivors;
  if (opt.won && survivors.length > 1) {
    const avg = survivors.reduce((s, p) => s + powerOf(p), 0) / survivors.length;
    const ab = survivors.filter(p => powerOf(p) >= avg);
    if (ab.length) pool = ab;
  }
  if (opt.won && axis) pool = [...pool].sort((a, b) => G(b, axis) - G(a, axis));
  else pool = rng.shuffle([...pool]);

  const foeWorld = battle.b.world;
  const foeStrains = battle.opponent.strains || {};
  const out = [];
  const n = Math.min(opt.count, pool.length);
  for (let i = 0; i < n; i++) {
    const src = pool[opt.won ? Math.min(i + rng.int(2), pool.length - 1) : rng.int(pool.length)];
    if (!src || out.some(c => c.srcId === src.id)) continue;
    const c = cloneAsCaptive(w, src, battle, foeStrains, foeWorld, rng);
    out.push(c);
    w.borderQueue.push(c);
  }
  ev(w, '捕虜', {
    revealed: true,
    text: out.length
      ? `${battle.opponent.name} から ${out.length} 体を連れ帰った${opt.won && axis ? `（${AXES.find(a => a.key === axis)?.label} 上位から抽選）` : ''}。`
      : '生存者がいなかった。殲滅した瞬間に自分の取り分が消えた。',
  });
  // 取り分がゼロでも戦争は終わる。ここで止めると先へ進めなくなる。
  if (!w.borderQueue.length) settleWar(w, battle);
  return out;
}

function cloneAsCaptive(w, src, battle, foeStrains, foeWorld, rng) {
  // 名前プールは全世界で共通なので、自国民と同名の捕虜が普通に出る。
  // 出自を添えて区別できるようにする（画面上で「どっちの◯◯か」が分からなくなるため）。
  const home = String(battle.opponent.name).replace('のシャーレ', '');
  const c = makeIndividual(w.nextId++, `${src.name}・${home}`, {
    genes: { ...src.genes }, age: src.age, sex: src.sex, born: w.gen - src.age, role: ROLE.IDLE,
    district: DISTRICT.FRONTIER,
  });
  c.srcId = src.id;
  c.alleles = src.alleles ? JSON.parse(JSON.stringify(src.alleles)) : undefined;
  c.skills = { ...src.skills };
  c.expressed = { ...src.expressed };
  c.foreign = true;
  c.homeName = battle.opponent.name;
  c.lineage = importLineage(w, src.lineage, foeStrains, battle.opponent);
  // 力ずくで連れてこられた。怨恨を持って来る。
  c.inheritedGrudge = 0.6 + rng.next() * 0.5;
  // 外国人は総合値の階級しか見えない
  const others = foeWorld ? [...foeWorld.people.values()].map(powerOf) : [];
  if (others.length) {
    const p = powerOf(src);
    const better = others.filter(v => v > p).length;
    const r = better / others.length;
    c.rankPct = r <= 0.01 ? 1 : Math.max(10, Math.ceil(r * 10) * 10);
  } else {
    c.rankPct = [1, 10, 20, 30, 40, 50][rng.int(6)];
  }
  return c;
}

/** 相手の世界の血統キーを、こちらの世界の血統表に登録し直す。 */
function importLineage(w, lineage, foeStrains, opp) {
  const L = lineage && Object.keys(lineage).length ? lineage : { self: 1 };
  const out = {};
  for (const k in L) {
    let key, hue, name;
    if (k === 'self') {
      key = 'n:' + opp.name; hue = opp.hue; name = `${opp.name}の血`;
    } else {
      key = k; hue = (foeStrains[k] && foeStrains[k].hue) ?? undefined; name = (foeStrains[k] && foeStrains[k].name) || k;
    }
    if (!w.strains[key]) w.strains[key] = { key, name, hue: hue ?? (60 + (w.nextId * 47) % 240) };
    out[key] = (out[key] || 0) + L[k];
  }
  return out;
}

// ---------------------------------------------------------------- 国境処理

export function borderDecision(w, captiveId, decision) {
  const i = w.borderQueue.findIndex(c => c.id === captiveId);
  if (i < 0) return null;
  const c = w.borderQueue.splice(i, 1)[0];
  let e;
  if (decision === 'accept') {
    w.people.set(c.id, c);
    e = ev(w, '受入', { actor: c.id, revealed: true, text: `${c.name}（${c.homeName}）を国に入れた。` });
  } else if (decision === 'execute') {
    c.alive = false; c.deathGen = w.gen; c.deathCause = '誅殺';
    w.dead.set(c.id, c);
    w.executed = (w.executed || 0) + 1;
    // 少数なら秘密。大量だと軍務関係者に露呈する。
    if (w.executed % 5 === 0) { w.regimeGrudge += 1.0; }
    e = ev(w, '誅殺', { actor: c.id, revealed: true, text: `${c.name} を国境で誅殺した。遺伝子は世界から永久に消えた。` });
  } else {
    e = ev(w, '送還', { actor: c.id, revealed: true, text: `${c.name} を送り返した。世界の遺伝子プールは保存された。` });
  }
  if (!w.borderQueue.length) settleWar(w, w.lastWar);
  return e;
}

/** 戦後処理の締め。捕虜がゼロでも必ず通る道にしてある。 */
export function settleWar(w, battle) {
  if (battle && battle.settled) return null;
  if (battle) battle.settled = true;
  if (w.borderQueue.length) return null;
  w.warsFought++;
  w.warReady = false;
  w.lastWarGen = w.gen;
  if (w.phase === PHASE.VILLAGE && w.people.size >= 8) {
    w.phase = PHASE.TRIBE;
    return ev(w, 'フェーズ', {
      revealed: true,
      text: '部族になった。もう自分の手で全員を配役することはできない。局長を立てるしかない。',
    });
  }
  return null;
}

// ---------------------------------------------------------------- 補助

export { PROFILES, AXES };
