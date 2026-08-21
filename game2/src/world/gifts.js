/**
 * 授かりもの（S以上）。A-23。
 *
 * **104ステとは別枠。**0〜100の値ではなく「持っている／いない」。
 * 1つの座位が11種類の値を取る（野生型＋10個）ので、**1人が2つ発現することはありえない**。
 *
 * 繁栄だけ顕性。残り9つは劣性ホモでのみ発現する。
 *
 * 供給は2本立て（どちらも実測して決めた・A-23）：
 *   1. 創世の十匹が10種を1本ずつ隠して持つ。600年以内に必ずどこかで出るが、
 *      **49%の確率で16世代目までに全部消える**（拾い上げるのがオーナーの役割）
 *   2. 出産1回につき 1/4700 で新規変異。国家規模になって初めて効き始める
 *      （村100人だとSの種が1つ出るまで6000年、Gは63000年かかる）
 *
 * ここは腕の予算にも normalizeArms にも一切触らない。連鎖群とも無関係。
 */
import * as G from '../core/gifts.gen.js';
import * as S from '../core/stats.js';

export { G };
export const NONE = G.NONE;

/** その個体に発現している授かりもの。0なら無し */
export function giftOf(P, i) {
  return G.express(P.a.gift0[i], P.a.gift1[i]);
}

/** 発現はしていないが隠して運んでいるもの（オーナーだけが見える・A-7） */
export function giftsCarried(P, i) {
  return G.carried(P.a.gift0[i], P.a.gift1[i]);
}

/** UI に渡す形。持っていなければ空配列 */
export function giftInfo(P, i) {
  const g = giftOf(P, i);
  if (g === G.NONE) return [];
  return [{
    key: G.KEY[g], name: G.NAME[g],
    tier: G.TIERS[G.TIER[g]], text: G.EFFECT[g],
    active: G.WHEN[g] === 'いつでも',
  }];
}

export function has(P, i, key) { return giftOf(P, i) === G.OF[key]; }

/** 繁栄：交叉が起きない。自分の染色体がまるごと子へ渡る */
export function hasProsper(P, i) { return giftOf(P, i) === G.OF.prosper; }

// ---- 創世の十匹に種を配る --------------------------------------------------
/**
 * 創世者に授かりものの種を1本だけ持たせる。**本人には発現しない**
 * （繁栄だけは顕性なので出てしまう）。
 *
 * **段の重みで引く。**十匹に10種を1つずつ配ると、村ほどの小集団では
 * すぐ劣性ホモが揃って、300年で奇跡が人口の10%を占めた（実測）。
 * 重みで引けば S が過半・G は十匹に0.4本しか入らない。段の梯子が村でも効く。
 *
 * FOUNDER_SEED_P … 種を持って生まれる創世者の割合。
 */
export const FOUNDER_SEED_P = 0.6;

export function seedFounder(P, i, k, rng) {
  const g = rng.next() < FOUNDER_SEED_P ? G.rollGift(rng) : G.NONE;
  P.a.gift0[i] = g;
  P.a.gift1[i] = G.NONE;
}

// ---- 子への受け渡し --------------------------------------------------------
/**
 * 親それぞれから1本ずつ引く。引いたあとに新規変異が乗る。
 * breed() の最後から呼ぶ。104ステの交叉とは完全に独立。
 */
export function breedGift(P, child, father, mother, rng) {
  const A = P.a;
  let a = rng.bool() ? A.gift0[father] : A.gift1[father];
  let b = rng.bool() ? A.gift0[mother] : A.gift1[mother];
  // 新規変異。全国民に平等（オーナー指定）。1回の出産につき MUT_PER_BIRTH
  if (rng.next() < G.MUT_PER_BIRTH) {
    if (rng.bool()) a = G.rollGift(rng); else b = G.rollGift(rng);
  }
  A.gift0[child] = a;
  A.gift1[child] = b;
}

// ---- 効果 ------------------------------------------------------------------
/** 長寿：最大寿命が70で確定する。素の寿命に上書きで効く */
export function lifespanOverride(P, i) {
  return giftOf(P, i) === G.OF.long_life ? 70 : -1;
}

/** 奇跡：老衰以外では死なない */
export function deathless(P, i) {
  return giftOf(P, i) === G.OF.miracle;
}

/**
 * 成長率の倍率。ステの大項目ごとに変わる。
 *   天賦 … 全部 1.3倍
 *   剛健 … からだ 1.2倍／明晰 … あたま 1.2倍／心眼 … こころ 1.2倍
 */
export function growthMul(P, i, s) {
  const g = giftOf(P, i);
  if (g === G.NONE) return 1;
  if (g === G.OF.gifted) return 1.3;
  const cat = S.CATEGORY[s];
  if (g === G.OF.sturdy && cat === S.BODY) return 1.2;
  if (g === G.OF.lucid && cat === S.HEAD) return 1.2;
  if (g === G.OF.heart_eye && cat === S.HEART) return 1.2;
  return 1;
}

/** 豊穣：同じ村にいるだけで、その村の農の生産系が伸びる／収穫が増える */
export function harvestBonusOf(P, village) {
  const A = P.a;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || A.village[i] !== village) continue;
    if (giftOf(P, i) === G.OF.harvest) return { growth: 1.1, yield: 1.05, who: i };
  }
  return { growth: 1, yield: 1, who: -1 };
}

/** 世界にいま何人が何を持っているか。収束計とデバッグ用 */
export function census(P) {
  const A = P.a;
  const shown = new Int32Array(G.COUNT + 1);
  const hidden = new Int32Array(G.COUNT + 1);
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    shown[giftOf(P, i)]++;
    for (const c of giftsCarried(P, i)) hidden[c]++;
  }
  return { shown, hidden };
}
