// v2 のチューニング定数。バランス調整はここだけを触れば済むようにする。
// 「上限なしの上位互換を置かない」ため、成長系はすべて漸近（1に届かない）形にしてある。

export const TICKS_PER_GEN = 12;

// --- 年齢（単位は世代） ---
export const EXPRESS_AGE = 1;    // 幼少期＝この年齢以下。発現ウィンドウはここだけ
export const ADULT_AGE = 2;      // 成人。役に就ける／繁殖できる
export const FERTILE_MAX = 9;
export const BASE_LIFESPAN = 4;  // 寿命遺伝子0で4世代
export const LIFESPAN_SPAN = 9;  // 寿命遺伝子1で13世代

// --- 人口 ---
export const MAX_POP = 400;      // 安全弁。v2はP2（100体）までなので実運用では触れない
export const PHASE_FERT = { 1: 2.6, 2: 1.15 };

// --- 遺伝 ---
export const CROSSOVER_MIN = 0.03;   // 可塑0のときの交叉率
export const CROSSOVER_MAX = 0.45;   // 可塑1のときの交叉率
export const MUT_RATE = 0.004;       // 座位あたりの突然変異率
export const MUT_DOMINANCE_FLIP = 0.30;
export const BODY_JITTER = 0.045;    // 中間遺伝のゆらぎ
export const RECESSIVE_P = 0.35;     // 創世時に劣性対立遺伝子を引く確率
export const DRIFT_PULL = 0.02;      // 制約のない座位（可塑）の中央回帰

// 対抗アームの予算から外す染色体。
// 8番は「感受性＝振れ幅」と「他責＝向き」で、設計文書上は対抗ではなく独立座位。
// ここに予算を掛けると「高感受性×高他責＝扇動者」という原型が構造的に作れなくなる。
export const ARM_EXEMPT = new Set([8]);

// --- 素質・発現・練度 ---
export const UNEXPRESSED = 0.20;   // 未発現の素質にかかる係数。開かない
export const TRAINING_FLOOR = 0.35; // 練度0でも実効値がゼロにはならない床
export const SKILL_GAIN = {
  farm:  { 農技: 0.16 },
  hunt:  { 狩技: 0.16, 戦技: 0.05, 恐怖耐性: 0.035 },
  drill: { 戦技: 0.13, 恐怖耐性: 0.045, 統率: 0.05 },
  war:   { 恐怖耐性: 0.22, 戦技: 0.16, 統率: 0.10 },
  idle:  {},
  child: {},
};

// --- 生産・消費 ---
export const FOOD_PER_HEAD = 0.55;
export const CHILD_CONSUME = 0.55;
export const FOOD_CAP_BASE = 40;
export const FOOD_CAP_PER_HEAD = 6;

// --- 民心・怨恨 ---
export const GRUDGE_INHERIT = 0.62;   // 体制怨恨の家系継承率
export const GRUDGE_DECAY = 0.006;    // 世代あたりの自然風化（祭祀局がないv2では雀の涙）
export const MORALE_FLOOR = 0.02;

// --- 戦闘 ---
export const LUCK_SHARE = 0.10;       // 戦死のうち完全ランダム（流れ矢）の割合
export const MAX_ROUNDS = 40;
export const WOUND_SHARE = 0.40;      // 致命打のうち傷病で済む割合
export const ROUT_FLED_DEATH = 0.30;  // 敗走時、逃げていた個体の基礎死亡率
export const ROUT_FLED_CROWD = 0.28;  // ＋逃走率に比例して上がる分（頻度依存の本体）
export const ROUT_HELD_DEATH = 0.11;  // 敗走時、踏み止まっていた個体の死亡率

// --- 捕虜 ---
export const CAPTIVE_COUNT = { 1: [1, 1], 2: [1, 5] };
