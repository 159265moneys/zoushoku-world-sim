// 導出層。遺伝子と状態から式で出す値。ここは全部キャッシュせず素で計算してよい
// （v2の規模は最大400体なので問題にならない）。
//
//   実効値 ＝ 素質(遺伝) × 発現(幼少期にその局面に置かれたか) × 練度(環境係数 × 実活動)
//
// 練度は一切遺伝しない。伸び率は環境が決める（world.js の gainSkills を参照）。

import { ROLE, DISTRICT } from '../core/model.js';
import * as C from './constants.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x) => clamp(x, 0, 1);

// 局面ゲート：どの素質がどの局面で開くか。ここに載らない遺伝子は人格なので常に効く。
export const SEGMENT_OF = {
  攻撃素質: 'war', 胆力: 'war', 統率素質: 'war',
  器用: 'prod', 技術習得: 'prod', 共同作業適性: 'prod',
};

// 素質 → 対応する練度軸
export const SKILL_OF = {
  攻撃素質: '戦技', 胆力: '恐怖耐性', 統率素質: '統率',
  器用: '農技', 技術習得: '農技', 共同作業適性: '農技',
};

/** 発現係数。未発現の素質は開かない（0.20）。 */
export function expressionFactor(ind, gene) {
  const seg = SEGMENT_OF[gene];
  if (!seg) return 1;
  return ind.expressed && ind.expressed[seg] ? 1 : C.UNEXPRESSED;
}

/** 練度項。0でも床がある（天才が完全に無力にはならないが、実戦では明確に劣る）。 */
export function trainingFactor(ind, gene) {
  const sk = SKILL_OF[gene];
  if (!sk) return 1;
  const s = clamp01(ind.skills?.[sk] ?? 0);
  return C.TRAINING_FLOOR + (1 - C.TRAINING_FLOOR) * s;
}

/** 実効値。3項積。 */
export function eff(ind, gene) {
  const base = ind.genes?.[gene] ?? 0;
  return base * expressionFactor(ind, gene) * trainingFactor(ind, gene);
}

/** 年齢係数。若すぎ・老いすぎは落ちる。 */
export function ageFactor(ind) {
  const a = ind.age;
  const peak = 3 + 4 * (ind.genes.寿命 ?? 0.5);
  if (a < C.ADULT_AGE) return 0.35 + 0.25 * a;
  if (a <= peak) return 1;
  return clamp(1 - (a - peak) * 0.13, 0.25, 1);
}

/** 遺伝的荷重による生存力。近親交配で腐り、外来血で戻る。 */
export function vitality(ind) {
  return ind.vitality ?? 1;
}

export function conditionFactor(ind) {
  return (1 - clamp01(ind.fatigue) * 0.30) * (ind.wounded ? 0.7 : 1) * vitality(ind);
}

// ---------------------------------------------------------------------------
// 七つの大罪 ＝ 既存遺伝子 × 感受性(8番)
// すべてに感受性が掛かる。すべてにプラスの出力がある（純マイナスの欲は置かない）。
// ---------------------------------------------------------------------------

/** 感受性の乗数。0.5〜1.5。低感受性は淡白、高感受性は欲が強い。 */
export function sensitivity(ind) {
  return 0.5 + (ind.genes.感受性 ?? 0.5);
}

export function sins(ind) {
  const g = ind.genes;
  const s = sensitivity(ind);
  const pair = (a, b) => Math.sqrt(clamp01(a) * clamp01(b));
  return {
    傲慢: clamp01(pair(g.誇り, g.野心) * s),
    強欲: clamp01(g.私欲 * s),
    嫉妬: clamp01(g.序列意識 * s),
    憤怒: clamp01(g.他責 * s),
    色欲: clamp01(g.繁殖性 * s),
    暴食: clamp01(g.代謝 * s),
    怠惰: clamp01((1 - g.勤勉) * s),
  };
}

/** 大罪のプラス側の出力。潰すと必ず何かを失う。 */
export function sinOutputs(sn) {
  return {
    統率補正: 1 + 0.30 * sn.傲慢,        // 傲慢＝士気・戦功
    産出補正: 1 + 0.22 * sn.強欲,        // 強欲＝蓄財・交易
    練度補正: 1 + 0.25 * sn.嫉妬,        // 嫉妬＝競争・模倣伝播
    戦闘補正: 1 + 0.28 * sn.憤怒,        // 憤怒＝戦闘力
    繁殖補正: 1 + 0.35 * sn.色欲,        // 色欲＝人口増
    飢餓耐性: 0.25 + 0.45 * sn.暴食,     // 暴食＝飢餓耐性
    疲労耐性: 1 - 0.45 * sn.怠惰,        // 怠惰＝疲れない
    寿命補正: 1 + 0.20 * sn.怠惰,        // 怠惰＝長命
  };
}

/**
 * 未充足度。世界の状態から欲ごとに0..1で出す。
 * 内発（intrinsic）の欲は報酬ゼロでも行為そのもので満たされるので、
 * その役に就いていれば未充足にならない。外発は報酬が止まれば即不満になる。
 */
export function unmetBySin(ind, world) {
  const sn = sins(ind);
  const foodPer = world.people.size ? world.food / world.people.size : 0;
  const scarcity = clamp01(1 - foodPer / 2.5);
  const sinceWar = world.gen - (world.lastWarGen ?? -99);
  const role = ind.role;
  const active = role === ROLE.HUNT || role === ROLE.WAR || role === ROLE.DRILL;
  const u = {
    傲慢: ind.titles.length ? 0.15 : clamp01(0.75 - ind.deeds.length * 0.12),
    強欲: scarcity,
    嫉妬: clamp01(1 - (ind.deeds.length ? 0.5 : 0) - (ind.bureau ? 0.4 : 0)),
    憤怒: clamp01(sinceWar / 6),
    色欲: ind.age >= C.ADULT_AGE && !ind.mated ? 0.7 : 0.2,
    暴食: scarcity,
    怠惰: role === ROLE.IDLE ? 0.05 : role === ROLE.CHILD ? 0.2 : 0.7,
  };
  // 内発なら、その欲に対応する行為をしている間は満たされる
  const m = ind.motive || {};
  if (m.憤怒 === 'intrinsic' && active) u.憤怒 *= 0.15;
  if (m.怠惰 === 'intrinsic') u.怠惰 *= 0.4;
  if (m.傲慢 === 'intrinsic' && (role === ROLE.WAR || ind.bureau)) u.傲慢 *= 0.2;
  if (m.強欲 === 'intrinsic' && role === ROLE.FARM) u.強欲 *= 0.5;
  return { sn, u };
}

/** 不満 ＝ Σ（欲の強度 × 未充足度） × 感受性 */
export function unmetTotal(ind, world) {
  const { sn, u } = unmetBySin(ind, world);
  let acc = 0, w = 0;
  for (const k of Object.keys(sn)) { acc += sn[k] * u[k]; w += 1; }
  return clamp01((acc / (w || 1)) * sensitivity(ind) * 1.5);
}

// ---------------------------------------------------------------------------
// 国民力：能力のみ。忠誠（野心・感受性・裏切り）は絶対に入れない。
// 未発現の素質は入らない ＝ 国境で「殺してはいけない者を殺す」事故が起きる。
// ---------------------------------------------------------------------------
export function citizenPower(ind) {
  const g = ind.genes;
  const cap =
    0.26 * eff(ind, '攻撃素質') +
    0.12 * eff(ind, '胆力') +
    0.14 * eff(ind, '統率素質') +
    0.14 * eff(ind, '器用') +
    0.10 * eff(ind, '技術習得') +
    0.08 * eff(ind, '共同作業適性') +
    0.10 * g.頑健 +
    0.06 * g.知性;
  return clamp01(cap * ageFactor(ind) * conditionFactor(ind));
}

// ---------------------------------------------------------------------------
// 戦争局面の導出層
// ---------------------------------------------------------------------------
export function combatStats(ind) {
  const g = ind.genes;
  const sn = sins(ind);
  const so = sinOutputs(sn);
  const cond = conditionFactor(ind) * ageFactor(ind);
  const atk = (0.15 + eff(ind, '攻撃素質')) * so.戦闘補正 * cond;
  const def = (0.30 + 0.55 * g.頑健) * (0.75 + 0.25 * (ind.skills.戦技 ?? 0)) * cond;
  const hp = 18 + 55 * g.頑健 + 22 * (ind.skills.戦技 ?? 0);
  const acc = clamp(0.45 + 0.45 * eff(ind, '器用'), 0.2, 0.95);
  const crit = clamp(0.04 + 0.16 * g.器用, 0.02, 0.28);
  const speed = 0.6 + 0.55 * g.代謝 + 0.25 * g.生育速度;
  // 恐怖耐性は練度が本命。素質（胆力）だけでは足りない
  const nerve = clamp01(0.6 * (ind.skills.恐怖耐性 ?? 0) + 0.4 * eff(ind, '胆力'));
  // 逃走率：感受性で振れ幅、保身で方向、誇りが引き留める
  const flee = clamp01((1 - nerve) * (0.45 + 0.55 * g.感受性) * (0.55 + 0.75 * g.保身) * (1 - 0.35 * g.誇り));
  const lead = eff(ind, '統率素質') * so.統率補正;
  const bond = clamp01(0.35 + 0.5 * g.団結傾向 + 0.25 * g.信仰性 - 0.2 * g.自律);
  return { atk, def, hp, acc, crit, speed, nerve, flee, lead, bond };
}

// ---------------------------------------------------------------------------
// 生産局面の導出層
// ---------------------------------------------------------------------------
/**
 * 産出。各項は1.0を中心に振れるように揃えてある。
 * @param landFactor 規模の逓減（働き手が土地を超えると1人あたりが落ちる）。world 側が渡す。
 */
export function produce(ind, world, landFactor = 1) {
  const g = ind.genes;
  const sn = sins(ind);
  const so = sinOutputs(sn);
  const cond = conditionFactor(ind) * ageFactor(ind);
  const diligence = clamp(0.65 + 0.70 * g.勤勉 - 0.40 * sn.怠惰, 0.20, 1.45);
  const coop = 0.85 + 0.30 * eff(ind, '共同作業適性');
  const envAgri = ind.district === DISTRICT.CENTER ? 1.10 : 0.88;
  const envHunt = ind.district === DISTRICT.FRONTIER ? 1.20 : 0.90;
  let gross = 0;
  if (ind.role === ROLE.FARM) {
    gross = C.FARM_BASE * (0.60 + 0.80 * (ind.skills.農技 ?? 0)) * (0.70 + 0.60 * eff(ind, '器用'))
          * diligence * coop * envAgri * cond * so.産出補正 * landFactor;
  } else if (ind.role === ROLE.HUNT) {
    // 狩りだけが生産と両立する。土地には縛られないが上振れも小さい
    gross = C.HUNT_BASE * (0.60 + 0.75 * (ind.skills.狩技 ?? 0)) * (0.70 + 0.55 * eff(ind, '攻撃素質'))
          * diligence * envHunt * cond * so.産出補正 * (0.55 + 0.45 * landFactor);
  }
  // 横領・隠匿：怨恨を溜めた国民は反乱の前にまず収穫を隠す
  const grudge = clamp01(ind.regimeGrudge ?? 0);
  const embezzleRate = clamp01(0.35 * sn.強欲 * (0.25 + grudge) + 0.30 * grudge * (1 - g.従順));
  const hidden = gross * embezzleRate;
  return { gross, hidden, net: gross - hidden, embezzleRate };
}

export function consume(ind) {
  const g = ind.genes;
  const sn = sins(ind);
  const base = C.FOOD_PER_HEAD + C.METAB_COST * g.代謝 + C.GLUTTONY_COST * sn.暴食;
  return ind.age < C.ADULT_AGE ? base * C.CHILD_CONSUME : base;
}

// ---------------------------------------------------------------------------
// 人事の2係数（設計文書「Administrator権限」）
// ---------------------------------------------------------------------------
/** 意欲係数：本人がその席を望んでいるか。 */
export function willingness(ind, role) {
  const g = ind.genes;
  if (role === 'bureau') {
    return clamp(0.3 + 0.55 * g.野心 - 0.35 * g.保身 - 0.15 * g.序列意識 + 0.15 * g.誇り, 0.15, 1.3);
  }
  if (role === ROLE.WAR || role === ROLE.HUNT || role === ROLE.DRILL) {
    return clamp(0.35 + 0.4 * g.攻撃素質 + 0.25 * g.胆力 - 0.3 * g.保身, 0.15, 1.25);
  }
  if (role === ROLE.FARM) {
    return clamp(0.4 + 0.4 * g.勤勉 + 0.2 * g.共同作業適性 - 0.2 * g.野心, 0.15, 1.25);
  }
  return 1;
}

/** 受容係数：周囲が認めるか。実績がなければ無名の抜擢は機能しない。 */
export function acceptance(ind, world) {
  const deeds = ind.deeds.length;
  const born = ind.lineage && ind.lineage.self === 1 ? 0.1 : 0;
  const rank = clamp01(0.15 * deeds) + (ind.titles.length ? 0.2 : 0);
  const rigidity = world.transparency ?? 0.5; // 透過率。低いほど家柄が支配する
  const heir = ind.fatherId && world.bureaus
    ? Object.values(world.bureaus).includes(ind.fatherId) ? 0.3 : 0
    : 0;
  return clamp(0.25 + rank + heir * (1 - rigidity) + rigidity * 0.35 + born, 0.15, 1.2);
}

export { clamp, clamp01 };
