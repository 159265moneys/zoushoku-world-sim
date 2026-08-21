// 自動生成。手で直さない。
// もと: docs/v3/gifts.csv (sha256 bbd1f0dab43fc447714974350b6cd25c9d9190be5b2e291372d8382a3efb0389)
// 作り直し: node game2/tools/gen-gifts.mjs
//
// S以上＝授かりもの。104ステとは別枠。A-23。
//   ・0〜100の値ではなく「持っている／いない」
//   ・1つの座位。野生型(NONE=0) と 10個の授かりもの(1〜10)
//   ・繁栄だけ顕性。残り9つは劣性ホモでのみ発現
//   ・同じ座位なので、2つ同時に発現することは構造上ありえない

export const SOURCE = "docs/v3/gifts.csv";
export const SOURCE_SHA256 = "bbd1f0dab43fc447714974350b6cd25c9d9190be5b2e291372d8382a3efb0389";
export const COUNT = 10;

/** 野生型。持っていない状態 */
export const NONE = 0;

export const TIERS = ["S", "SS", "SSS", "G"];

/** 添字は 1〜COUNT。0番は野生型なので空けてある */
export const KEY   = ["", "long_life", "prosper", "brave", "heart_eye", "sturdy", "lucid", "tactician", "harvest", "gifted", "miracle"];
export const NAME  = ["", "長寿", "繁栄", "勇敢", "心眼", "剛健", "明晰", "軍師", "豊穣", "天賦", "奇跡"];
export const TIER  = [-1, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3];
export const EFFECT = ["", "最大寿命が70で確定する", "交叉が起きない。自分のステの組み合わせがそのまま子に渡る", "恐怖しない。戦場で退かない", "こころ系ステの成長率が1.2倍", "からだ系ステの成長率が1.2倍", "あたま系ステの成長率が1.2倍", "戦場で自兵のからだステ1.2倍＋その戦でからだ成長率1.2倍", "同じ村の農の生産系ステ成長率1.1倍＋収穫量1.05倍", "すべてのステの成長率が1.3倍", "老衰以外では死なない"];
export const WHEN  = ["", "いつでも", "いつでも", "戦が実装されてから", "こころの成長が実装されてから", "いつでも", "いつでも", "戦が実装されてから", "いつでも", "いつでも", "いつでも"];

/** 顕性か。繁栄だけ true */
export const DOMINANT = [false, false, false, false, false, false, false, false, false, false, false];

/** 新規変異が起きたとき、どれになるかの重み。合計 106 */
export const WEIGHT = [0, 20, 20, 20, 10, 10, 10, 6, 6, 2, 2];
export const WEIGHT_TOTAL = 106;

/** 出産1回あたり、新しい授かりものの種が生まれる確率。A-23 */
export const MUT_PER_BIRTH = 1 / 4700;

export const OF = Object.freeze(Object.fromEntries(
  KEY.map((k, i) => [k, i]).filter(([k]) => k)));

/** 重み付きで1つ引く。rng は core/rng.js の RNG */
export function rollGift(rng) {
  let r = rng.next() * WEIGHT_TOTAL;
  for (let g = 1; g <= COUNT; g++) { r -= WEIGHT[g]; if (r < 0) return g; }
  return COUNT;
}

/** 2本の対立遺伝子から、実際に発現しているものを決める。0なら何も無し */
export function express(a, b) {
  if (a !== NONE && DOMINANT[a]) return a;        // 顕性は1本で出る
  if (b !== NONE && DOMINANT[b]) return b;
  if (a === b && a !== NONE) return a;            // 劣性は揃ったときだけ
  return NONE;
}

/** 発現はしていないが隠して運んでいるもの（保因） */
export function carried(a, b) {
  const e = express(a, b);
  const out = [];
  if (a !== NONE && a !== e) out.push(a);
  if (b !== NONE && b !== e && b !== a) out.push(b);
  return out;
}
