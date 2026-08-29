/**
 * 授かりもの（S以上）。**正典3-5（オーナー裁定で遺伝を廃止し、抽選に置き換えた）。**
 *
 * **104ステとは別枠。**0〜100の値ではなく「持っている／いない」。
 * 席は1つで10種類の値を取るので、**1人が2つ持つことはありえない。**
 *
 * **遺伝しない。出生のたびに1回抽選する。**
 *   確率 ＝ K × 重み、K = 1/200,000
 *     S（長寿・繁栄・勇敢）   重み20 → 各 1/1万
 *     SS（心眼・剛健・明晰）  重み10 → 各 1/2万
 *     SSS（軍師・豊穣）       重み 6 → 各 1/3.3万
 *     G（天賦・奇跡）         重み 2 → 各 1/10万
 *   何か持っている率は 106/200,000 ≒ 1/1,887。10万人で53人。
 *
 * **天井（ガチャと同じ）。**段ごとに「確率の逆数」の出産数で確定する。
 * 出たらその段の天井はリセット。
 *
 * **最初の村には出ない。それでよい**（オーナー裁定）。
 * 1つの村を300年回した累積出産は約1,000回なので、S級で0.1体。
 * 天井が効き始めるのは人口が万を超えてから（10万人ならS級2.5年・G級25年）。
 *
 * 廃止したもの：劣性ホモの判定／創世の種／出産ごと1/4700の変異／親からの受け渡し。
 * ここは腕の予算にも normalizeArms にも一切触らない。連鎖群とも無関係。
 */
import * as G from '../core/gifts.gen.js';
import * as S from '../core/stats.js';

export { G };
export const NONE = G.NONE;

/** その個体が持っている授かりもの。0なら無し */
export function giftOf(P, i) {
  return P.a.gift0[i];
}

/** 保因という状態は無くなった（遺伝を廃止したので）。空を返す */
export function giftsCarried(P, i) {
  return [];
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

// ---- 抽選と天井 ------------------------------------------------------------
/**
 * 確率 ＝ K × 重み。K を「S級1個が 1/1万」に合わせる。
 * 重みは gifts.gen.js の WEIGHT（S=20 / SS=10 / SSS=6 / G=2）。
 */
/**
 * **正典3-5の表は「素の確率」。**ソシャゲの天井と同じで、**天井は上乗せ。**
 * S級1個で 1/1万、G級1個で 1/10万。天井は「確率の逆数」の出産数。
 *
 * 天井があるぶん、**実際に手に入る速さは表より1.58倍くらい速くなる**
 * （天井 N＝1/p のとき平均は (1−e⁻¹)/p ＝ 0.632/p）。それでよい。
 */
export const DRAW_K = 1 / 200000;

/** 素の確率。K × 重み */
export function baseRateOf(g) { return DRAW_K * G.WEIGHT[g]; }
/** 段ごとの天井。この出産数で確定する。＝ 素の確率の逆数 */
export function pityOf(g) { return Math.round(1 / baseRateOf(g)); }

/**
 * 天井のカウンタ。**世界に1本。**P（人の器）にぶら下げるので、呼ぶ側は持ち回らなくていい。
 */
function pityCounter(P) {
  if (!P._giftPity) P._giftPity = new Float64Array(G.COUNT + 1);
  return P._giftPity;
}

/**
 * 出生のたびに1回。**遺伝しない。**
 * @returns 引いた授かりもの（G.NONE なら無し）
 */
export function drawGift(P, rng) {
  const pity = pityCounter(P);

  // ★ 正典 #16 の実装の掟。順番そのものが仕様なので、崩さないこと（2026-08-29 に直した）
  //   (1) 先に**10本すべて** pity[g]++ する
  //       （当たった時点で return すると、それ以降の授かりものの天井が系統的に遅れる）
  for (let g = 1; g <= G.COUNT; g++) pity[g] += 1;

  //   (2) **乱数は出産あたり必ず1回。天井が当たっても引いて捨てる**
  //       ★ ここが 12ストリーム分割の掟「ストリーム内では、分岐で呼び出し回数を変えない」
  //         の根拠そのもの。引かずに return すると、同じ種でも世界が分岐する
  const r = rng.next();

  //   (3) 天井は**添字の大きい順（G > SSS > SS > S）**に見る
  //       昇順だと、天井の低い長寿（S）が奇跡（G）を押しのける
  for (let g = G.COUNT; g >= 1; g--) {
    if (pity[g] >= pityOf(g)) { pity[g] = 0; return g; }   // (4) リセットは出た1本だけ
  }

  // 天井が無ければ、いま引いた r を重みで使う
  let acc = 0;
  for (let g = 1; g <= G.COUNT; g++) {
    acc += baseRateOf(g);
    if (r < acc) { pity[g] = 0; return g; }
  }
  return G.NONE;
}

/** 創世の8人にも同じ抽選を回すだけ。種は持たせない */
export function seedFounder(P, i, k, rng) {
  P.a.gift0[i] = drawGift(P, rng);
  P.a.gift1[i] = G.NONE;
}

/** 子。**親を一切見ない。**出生の抽選をそのまま入れる */
export function breedGift(P, child, father, mother, rng) {
  P.a.gift0[child] = drawGift(P, rng);
  P.a.gift1[child] = G.NONE;
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
