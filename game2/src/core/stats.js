// 106ステの定義。
//
// 中身は stats.gen.js（docs/v3/stats_v3.csv から自動生成）。
// ここは索引と、段階（「高い」「やや低い」）を数に直す表と、
// 染色体・腕でまとめ直したものを足すだけ。
//
// 掟：実行時に CSV を読まない。CSV を直したら node game2/tools/gen-stats.mjs。
//
// 確定事項より：
//   A-3  ステは人間を数値に分解した結果。先天/後天は分類の軸ではない
//   A-5  分布は遺伝方式から決まる（中間遺伝→釣り鐘／優劣→両極）
//        レア度は閾値ひとつで表せる
//   A-5  連鎖群は必須。敵対するものを同じ染色体の反対の腕に置く
//   A-22 105→104。腕の数が 52/52 で完全に均等

import * as G from './stats.gen.js';

export const COUNT = G.COUNT;                    // 106（N-22 で104→106）
export const SOURCE = G.SOURCE;
export const SOURCE_SHA256 = G.SOURCE_SHA256;

// 段階の名前（そのまま出す）
export const CATEGORIES = G.CATEGORIES;          // からだ／あたま／こころ
export const SUBCATEGORIES = G.SUBCATEGORIES;
export const RARITY_LEVELS = G.RARITY_LEVELS;    // N F E D C B A AA S SS
export const THRESHOLD_LEVELS = G.THRESHOLD_LEVELS;
export const GROWTH_LEVELS = G.GROWTH_LEVELS;
export const INHERIT_MODES = G.INHERIT_MODES;    // 中間遺伝／優劣
export const HERITABILITY_LEVELS = G.HERITABILITY_LEVELS;
export const SEXLIMIT_LEVELS = G.SEXLIMIT_LEVELS;
export const PLACE_LEVELS = G.PLACE_LEVELS;      // 変わらない／中央／辺境／両方

// 列（添字がステ番号）
export const NAME = G.NAME;
export const CATEGORY = G.CATEGORY;
export const SUB = G.SUB;
export const CHROMOSOME = G.CHROMOSOME;          // 1〜14
export const ARM = G.ARM;                        // 0=A 1=B
export const PAIR = G.PAIR;                      // 対になるステ。無ければ -1
export const RARITY = G.RARITY;
export const THRESHOLD = G.THRESHOLD;
export const GROWTH = G.GROWTH;
export const INHERIT = G.INHERIT;
export const HERITABILITY = G.HERITABILITY;
export const SEXLIMIT = G.SEXLIMIT;
export const PLACE = G.PLACE;

// 名前の並び（大項目の番号）
export const BODY = 0, MIND = 1, HEART = 2;      // からだ／あたま／こころ
export const ARM_A = 0, ARM_B = 1;
export const BLEND = 0, DOMINANT = 1;            // 中間遺伝／優劣
export const SEX_ANY = 0, SEX_FEMALE = 1, SEX_MALE = 2;
export const PLACE_SAME = 0, PLACE_CENTER = 1, PLACE_FRONTIER = 2, PLACE_BOTH = 3;

// ===========================================================================
// 仮の数値。**確定事項で数が決まっていないもの。ここだけ直せば全部変わる。**
// 使う側（world/grow.js・world/genetics.js）はこの表を読むこと。自分で書かない。
// ===========================================================================

// 努力値の閾値。才能がこれ未満なら、何年やっても努力値が積まれない（A-4）。
// 段階が5つ（なし／低い／中／高い／非常に高い）で、A-5 の実測表の刻みが
// 0／15／50／80／95 の5つなので、そのまま当てている。
//   閾値0=100% 15=87.5% 50=14.8% 80=0.71% 95=0.10% が積める人口
// 「該当なし」は こころ の29個。閾値という概念が原理的に無い（野心を鍛える職が無い）
export const THRESHOLD_NONE = -1;
export const THRESHOLD_VALUE = [THRESHOLD_NONE, 0, 15, 50, 80, 95];

// 伸びしろ。努力値がどれだけ積めるかの効き。0〜1の係数として持つ。
// **数は確定事項に無い。仮。** こころ（該当なし）は普通の努力では動かず、
// statsText.gen.js の GROWTH_NOTE に書かれた出来事でだけ動く
export const GROWTH_ROOM = [0, 0.1, 0.4, 0.7, 1.0];

// 遺伝率の基準値。**数は確定事項に無い。仮。**
// B-9「容姿の遺伝率は中のまま（上げると美形の血を集めるのが最適解になる）」に合わせ、
// 中を 0.5 に置き、上下に等間隔で振っている
export const HERITABILITY_VALUE = [0.20, 0.35, 0.50, 0.65, 0.80];

// 伸びる場所の補正（A-21）。**補正の大きさは未決。仮。**
// 旧実装の 0.92／1.22（1.33倍差）は破棄されたので、控えめに 0.90／1.10 を置く。
// 添字は [伸びる場所][住んでいる場所]。住んでいる場所は 0=中央 1=辺境
export const WHERE_CENTER = 0, WHERE_FRONTIER = 1;
export const PLACE_MULTIPLIER = [
  [1.00, 1.00],  // 変わらない
  [1.10, 0.90],  // 中央（教える者がいる・道具と材料が揃う）
  [0.90, 1.10],  // 辺境（体を使わざるを得ない・獣が近い）
  [1.10, 1.10],  // 両方
];

// ===========================================================================
// 索引
// ===========================================================================

const INDEX = new Map();
for (let i = 0; i < COUNT; i++) INDEX.set(NAME[i], i);

/** 名前 → ステ番号。無ければ -1 */
export function idOf(name) { const i = INDEX.get(name); return i === undefined ? -1 : i; }
/** ステ番号 → 名前 */
export function nameOf(id) { return NAME[id]; }
/** 名前 → ステ番号。無ければ投げる（書き間違いを早く見つけるため） */
export function needId(name) {
  const i = idOf(name);
  if (i < 0) throw new Error(`stats: 「${name}」というステは無い`);
  return i;
}
export function has(name) { return INDEX.has(name); }

// ---- 一つ引くもの ---------------------------------------------------------
export function categoryOf(id) { return CATEGORIES[CATEGORY[id]]; }
export function subOf(id) { return SUBCATEGORIES[SUB[id]]; }
export function rarityOf(id) { return RARITY_LEVELS[RARITY[id]]; }
export function armOf(id) { return ARM[id] === ARM_A ? 'A' : 'B'; }
export function pairOf(id) { return PAIR[id]; }
export function inheritOf(id) { return INHERIT_MODES[INHERIT[id]]; }
export function isBlend(id) { return INHERIT[id] === BLEND; }
export function isDominant(id) { return INHERIT[id] === DOMINANT; }

/** 努力値の閾値（数）。-1 は「閾値という概念が無い」（こころ） */
export function thresholdOf(id) { return THRESHOLD_VALUE[THRESHOLD[id]]; }
/** 才能 talent の者が、このステに努力値を積めるか */
export function canTrain(id, talent) {
  const t = THRESHOLD_VALUE[THRESHOLD[id]];
  if (t === THRESHOLD_NONE) return false;   // こころ。普通の努力では積まれない
  return talent >= t;
}
/** 伸びしろ（0〜1） */
export function growthRoomOf(id) { return GROWTH_ROOM[GROWTH[id]]; }
/** 遺伝率（0〜1） */
export function heritabilityOf(id) { return HERITABILITY_VALUE[HERITABILITY[id]]; }
/** 住んでいる場所（0=中央 1=辺境）での伸びの倍率 */
export function placeMultiplier(id, where) { return PLACE_MULTIPLIER[PLACE[id]][where]; }
/** 性別限定。0=なし 1=女のみ 2=男のみ */
export function sexLimitOf(id) { return SEXLIMIT[id]; }
/** sex（0=男 1=女）の者がこのステを持つか */
export function appliesToSex(id, sex) {
  const s = SEXLIMIT[id];
  if (s === SEX_ANY) return true;
  return s === SEX_FEMALE ? sex === 1 : sex === 0;
}

// ---- まとめ直したもの -----------------------------------------------------

/** 染色体の本数（1〜CHROMOSOME_COUNT） */
export const CHROMOSOME_COUNT = Math.max(...CHROMOSOME);

// 染色体ごと・腕ごとのステ番号の一覧。連鎖群そのもの。
// BY_ARM[c][a] … c 番染色体の a 腕（0=A 1=B）に載っているステ番号
export const BY_ARM = [];
for (let c = 0; c <= CHROMOSOME_COUNT; c++) BY_ARM.push([[], []]);
for (let i = 0; i < COUNT; i++) BY_ARM[CHROMOSOME[i]][ARM[i]].push(i);

/** c 番染色体の a 腕に載っているステ番号 */
export function armMembers(c, a) { return BY_ARM[c][a]; }
/** id と同じ腕に載っているもの（自分を含む）＝一緒に上がり下がりする群 */
export function linkedWith(id) { return BY_ARM[CHROMOSOME[id]][ARM[id]]; }
/** id の反対の腕に載っているもの＝伸ばすと割を食う側 */
export function opposingArm(id) { return BY_ARM[CHROMOSOME[id]][ARM[id] ^ 1]; }

// 大項目ごとのステ番号
export const BY_CATEGORY = CATEGORIES.map(() => []);
for (let i = 0; i < COUNT; i++) BY_CATEGORY[CATEGORY[i]].push(i);

// レア度ごと
export const BY_RARITY = RARITY_LEVELS.map(() => []);
for (let i = 0; i < COUNT; i++) BY_RARITY[RARITY[i]].push(i);

// ---- 1件ずつの姿（UI とデバッグ用。simの内側では列を直に読むこと） --------
export const STATS = [];
for (let i = 0; i < COUNT; i++) {
  STATS.push(Object.freeze({
    id: i,
    name: NAME[i],
    category: CATEGORIES[CATEGORY[i]],
    sub: SUBCATEGORIES[SUB[i]],
    chromosome: CHROMOSOME[i],
    arm: ARM[i] === ARM_A ? 'A' : 'B',
    pair: PAIR[i],
    pairName: PAIR[i] >= 0 ? NAME[PAIR[i]] : null,
    rarity: RARITY_LEVELS[RARITY[i]],
    threshold: THRESHOLD_LEVELS[THRESHOLD[i]],
    thresholdValue: THRESHOLD_VALUE[THRESHOLD[i]],
    growth: GROWTH_LEVELS[GROWTH[i]],
    growthRoom: GROWTH_ROOM[GROWTH[i]],
    inherit: INHERIT_MODES[INHERIT[i]],
    heritability: HERITABILITY_LEVELS[HERITABILITY[i]],
    heritabilityValue: HERITABILITY_VALUE[HERITABILITY[i]],
    sexLimit: SEXLIMIT_LEVELS[SEXLIMIT[i]],
    place: PLACE_LEVELS[PLACE[i]],
  }));
}
Object.freeze(STATS);
