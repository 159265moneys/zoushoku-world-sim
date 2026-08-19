// 探索空間の定義と、方針をベクトルに直す係。
//
// tools/SEARCH.md の表がここの唯一の出典。範囲は src/sim/cards.js の CARDS と
// 一致していなければならない（ズレると「範囲外の方針が最良」という嘘が出る）。
// verifySpace() が起動時に実物と突き合わせる。

import { CARDS } from '../../src/sim/cards.js';
import { PROFILE_IDS } from '../../src/sim/rival.js';

/** 12枚の連続カード。min/max は cards.js と同じでなければならない */
export const CARD_IDS = [
  'deploy_top', 'spare_old', 'raise_young', 'guards', 'drill', 'surrender_at',
  'hunt_ratio', 'stockpile', 'frontier', 'ration_equal', 'hereditary', 'mix_policy',
];

export const CAPTIVE_AXES = ['総合', '武力', '知性', '統率', '繁殖性', '器用', '頑健'];
export const BORDERS = ['accept', 'kill', 'return'];
export const PROMOTES = PROFILE_IDS; // sim の PROFILES[*].promote と同じ語彙
export const OPPONENTS = PROFILE_IDS; // 10国

/** カードの範囲を実物から引く */
export const CARD_RANGE = Object.fromEntries(
  CARD_IDS.map((id) => {
    const def = CARDS.find((c) => c.id === id);
    if (!def) throw new Error(`カード ${id} が src/sim/cards.js に無い`);
    return [id, { min: def.min, max: def.max, step: def.step, def: def.def }];
  })
);

/** SEARCH.md の表と実物のズレを検出する。判定の前提が壊れていたら止める。 */
export function verifySpace() {
  const spec = {
    deploy_top: [0, 100], spare_old: [2, 12], raise_young: [0, 100], guards: [0, 5],
    drill: [0, 60], surrender_at: [0, 90], hunt_ratio: [0, 80], stockpile: [0, 60],
    frontier: [0, 100], ration_equal: [0, 100], hereditary: [0, 100], mix_policy: [0, 100],
  };
  const bad = [];
  for (const [id, [lo, hi]] of Object.entries(spec)) {
    const r = CARD_RANGE[id];
    if (r.min !== lo || r.max !== hi) bad.push(`${id}: SEARCH.md=[${lo},${hi}] cards.js=[${r.min},${r.max}]`);
  }
  return bad;
}

/**
 * 特徴量の定義。16個の「つまみ」を33次元に開く。
 * カテゴリは one-hot を 1/√2 で重み付けする。こうすると「カテゴリが違う」の距離が
 * 連続カードが 0→100 に振り切ったのと同じ 1.0 になる。重み付けを忘れると
 * カテゴリの差が √2 倍に化けて、クラスタがカテゴリだけで割れる。
 */
const ONEHOT_W = 1 / Math.SQRT2;
export const N_KNOBS = CARD_IDS.length + 4; // 12枚 + captiveAxis/border/promote/warAppetite

export function encode(policy) {
  const v = [];
  for (const id of CARD_IDS) {
    const r = CARD_RANGE[id];
    const x = policy.cards?.[id];
    v.push(clamp01(((x ?? r.def) - r.min) / (r.max - r.min)));
  }
  for (const a of CAPTIVE_AXES) v.push(policy.captiveAxis === a ? ONEHOT_W : 0);
  for (const b of BORDERS) v.push(policy.border === b ? ONEHOT_W : 0);
  for (const p of PROMOTES) v.push(policy.promote === p ? ONEHOT_W : 0);
  v.push(clamp01(policy.warAppetite ?? 0.5));
  return v;
}

/** 特徴名（回帰の係数を人間に見せるため） */
export const FEATURE_NAMES = [
  ...CARD_IDS,
  ...CAPTIVE_AXES.map((a) => `captive:${a}`),
  ...BORDERS.map((b) => `border:${b}`),
  ...PROMOTES.map((p) => `promote:${p}`),
  'warAppetite',
];

/**
 * 方針間の距離。1つまみあたりのRMSに正規化するので、値は 0〜1 に収まる。
 * 「0.3」は「16個のつまみが平均して範囲の30%ずれている」と読める。
 */
export function distance(a, b) {
  const x = Array.isArray(a) ? a : encode(a);
  const y = Array.isArray(b) ? b : encode(b);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - y[i]) ** 2;
  return Math.sqrt(s / N_KNOBS);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);

/** 空間から一様にサンプルする。Q4の「ランダム方針」の母集団はこれ。 */
export function samplePolicy(rng, id) {
  const cards = {};
  for (const cid of CARD_IDS) {
    const r = CARD_RANGE[cid];
    cards[cid] = Math.round(rng.range(r.min, r.max) / r.step) * r.step;
  }
  return {
    id,
    cards,
    captiveAxis: rng.pick(CAPTIVE_AXES),
    border: rng.pick(BORDERS),
    promote: rng.pick(PROMOTES),
    warAppetite: Math.round(rng.next() * 100) / 100,
  };
}

/** つまみを1つだけ動かした複製（感度分析＝OAT用） */
export function perturb(policy, knob, delta) {
  const p = JSON.parse(JSON.stringify(policy));
  if (CARD_IDS.includes(knob)) {
    const r = CARD_RANGE[knob];
    const raw = (p.cards[knob] ?? r.def) + delta * (r.max - r.min);
    p.cards[knob] = Math.min(r.max, Math.max(r.min, Math.round(raw / r.step) * r.step));
  } else if (knob === 'warAppetite') {
    p.warAppetite = Math.min(1, Math.max(0, (p.warAppetite ?? 0.5) + delta));
  }
  return p;
}

export const CATEGORICAL = { captiveAxis: CAPTIVE_AXES, border: BORDERS, promote: PROMOTES };
