// v2 のチューニング定数。バランス調整はここだけを触れば済むようにする。
// 「上限なしの上位互換を置かない」ため、成長系はすべて漸近（1に届かない）形にしてある。

export const TICKS_PER_GEN = 12;

// --- 年齢（単位は世代） ---
export const EXPRESS_AGE = 1;    // 幼少期＝この年齢以下。発現ウィンドウはここだけ
export const ADULT_AGE = 2;      // 成人。役に就ける／繁殖できる
// 繁殖可能年齢の上限は「崖」ではなく「傾斜」にする。
// 定数の打ち切りにしていたときは、蔵が満杯で民心も高いのに
// 生き残りが全員10歳を超えていて子が1人も生まれず滅ぶ世界が出た。
export const FERTILE_MAX = 13;
export const FERTILE_PEAK = 6;       // ここまでは満額
export const FERTILE_FALL = 0.16;    // 1世代ごとに落ちる分
export const BASE_LIFESPAN = 4;  // 寿命遺伝子0で4世代
export const LIFESPAN_SPAN = 9;  // 寿命遺伝子1で13世代

// --- 人口 ---
export const MAX_POP = 400;      // 安全弁。v2はP2（100体）までなので実運用では触れない
// 繁殖の基礎率はフェーズで変えない。
// P2で人為的に絞っていたとき、飢饉のあとに人口が戻れず、
// 天井付近の振動がそのままゼロまで落ちる世界が出た。
// 上を抑えるのは土地・密度・食料の3つで足りる。低密度での回復力は殺さない。
export const PHASE_FERT = { 1: 2.6, 2: 2.4 };

// --- 遺伝 ---
export const CROSSOVER_MIN = 0.03;   // 可塑0のときの交叉率
export const CROSSOVER_MAX = 0.45;   // 可塑1のときの交叉率
export const MUT_RATE = 0.004;       // 座位あたりの突然変異率
export const MUT_DOMINANCE_FLIP = 0.30;
export const BODY_JITTER = 0.045;    // 中間遺伝のゆらぎ
// 創世のばらつき。回答＝種族の重心、アダムとイザナミはそこから引いた2サンプル。
// 小さすぎると二匹がほぼ同じで交叉しても何も出ず、大きすぎると回答が薄まって
// 「自分の種族」に見えなくなる。実測で決めた値（README の「創世の spread」を参照）。
export const FOUND_SPREAD = 0.16;
// 体系（代謝・頑健・攻撃素質…）は性格診断の対象外なので、心系の spread に
// 連動させず固定幅で振る。回答の解像度を上げても体格が揃ってしまわないように。
export const BODY_FOUND_SPREAD = 0.22;

export const RECESSIVE_P = 0.35;     // 創世時に劣性対立遺伝子を引く確率
export const DRIFT_PULL = 0.02;      // 制約のない座位（可塑）の中央回帰

// 遺伝的荷重（劣性が隠して運ぶ欠陥）。近親交配ペナルティと雑種強勢はここから出る。
export const LOAD_P = 0.55;          // 劣性対立遺伝子が荷重を持つ確率
export const LOAD_WEIGHT = 0.25;     // 荷重1につき生存力が何割落ちるか
export const LOAD_FLOOR = 0.35;      // どれだけ腐っても死にはしない床

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
// 各係数は「1.0を中心に振れる項」に揃えてある。BASE を読めば
// 「未熟な働き手1人が何人を養えるか」がそのまま分かるようにするため。
//   FARM_BASE=2.7 → 練度0の農夫が約1.9/tick 産み、大人1人は約0.73/tick 食う
//   ＝未熟でも2.5人分、熟練すると5人分。この余剰が人口を増やす唯一のエンジン。
export const FARM_BASE = 3.3;
export const HUNT_BASE = 2.7;
export const FOOD_PER_HEAD = 0.45;
export const METAB_COST = 0.30;      // 代謝の分
export const GLUTTONY_COST = 0.25;   // 暴食の分
// 子どもは産まないが食う。この比が高いほど扶養比率で経済が詰まる。
// 世代あたり2体以上生まれる設計なので、人口の半分近くが常に子どもになる。
export const CHILD_CONSUME = 0.45;
export const FOOD_CAP_BASE = 30;
export const FOOD_CAP_PER_HEAD = 5;
export const START_FOOD = 24;

// --- 土地：産出の上限を決める唯一の資源 ---
// 働き手が土地を超えると1人あたりの産出が落ちる（規模の逓減）。
// 開墾で増え、放っておくと痩せる。人口の天井は結局これが決める。
export const LAND_START = 18;
// v2 のスコープは P1+P2（〜100体）なので、土地の上限がそのまま人口の天井になる。
// P3 の閾値あたりで頭打ちになる値にしてある。
export const LAND_MAX = 45;
export const LAND_GROW = 0.30;       // 余剰があるとき働き手1人あたりの開墾量
export const LAND_DECAY = 0.020;     // 土地消耗率
export const POP_PER_LAND = 2.6;     // 密度ストレスの基準

// --- 民心・怨恨 ---
// 村内婚の強さ。近い血がどれだけ結ばれやすいか。
// これがゼロだと成人50人の村がランダム交配になり、劣性ホモ率が理論下限から動かず
// 「閉じた血統は腐る」も「外来血で戻る」も両方とも実測できない。
export const ENDOGAMY = 3.0;

// 兄弟・親子の忌避。村内婚（ENDOGAMY）とは別の軸で、統治方針では動かない。
export const INCEST_AVOID = 0.15;

export const GRUDGE_INHERIT = 0.62;   // 体制怨恨の家系継承率
// 風化率そのものはオーナーの手にない（祭祀局の性能）。v2には祭祀局がないので
// 固定値だが、0.006 にしていたときは全世界の怨恨が1.0に飽和し、
// 「体制怨恨は消えない」が「体制怨恨は必ず最大になる」に化けていた。
// 半減期がおよそ12世代になる値にする。3世代後に返る鎖は十分に残る。
export const GRUDGE_DECAY = 0.055;
export const REBEL_COOLDOWN = 2;      // 一揆の不応期（世代）
export const MORALE_FLOOR = 0.02;

// --- 戦闘 ---
export const LUCK_SHARE = 0.10;       // 戦死のうち完全ランダム（流れ矢）の割合
export const MAX_ROUNDS = 40;
export const WOUND_SHARE = 0.40;      // 致命打のうち傷病で済む割合
export const ROUT_FLED_DEATH = 0.30;  // 敗走時、逃げていた個体の基礎死亡率
export const ROUT_FLED_CROWD = 0.28;  // ＋逃走率に比例して上がる分（頻度依存の本体）
export const ROUT_HELD_DEATH = 0.11;  // 敗走時、踏み止まっていた個体の死亡率

// 初戦（10体到達時の強制戦争）の規模。設計の看板の場面なので固定する。
// 「5対5なら、攻撃力天才が恐怖で固まって死ぬのを目撃できる」
export const FIRST_WAR_SIZE = 5;

// ゴーストの候補を何倍作って淘汰するか。1.0 は無淘汰（＝実在しない集団）。
export const GHOST_OVERDRAW = 2.0;
// 走っている国は突然変異と淘汰が釣り合った水準にいる。創世（LOAD_P）と同じ値を
// 使うと、移民が自国民より欠陥を多く持つ「実在しない集団」になる。
export const GHOST_LOAD_P = 0.37;

// --- 捕虜 ---
export const CAPTIVE_COUNT = { 1: [1, 1], 2: [1, 5] };
