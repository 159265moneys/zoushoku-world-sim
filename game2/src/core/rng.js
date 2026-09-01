// 決定的乱数。同じ種から同じ歴史を再現するために必須。
// Math.random() はコード中どこでも使わないこと。
//
// game/src/core/rng.js からの移植。xorshift32 の本体・int/range/pick/bool/
// normal/clampNormal/shuffle/fork は一字も変えていない（同じ種で同じ列が出る）。
// 追加したのは save()/load() の2つだけ（セーブで乱数の続きを再現するため。
// 既存の挙動には触れていない）。

export class RNG {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }
  // xorshift32
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  range(a, b) { return a + this.next() * (b - a); }
  pick(arr) { return arr[this.int(arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
  // 平均mu、標準偏差sigmaの正規乱数（Box-Muller）
  normal(mu = 0, sigma = 1) {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  clampNormal(mu, sigma, lo, hi) {
    return Math.max(lo, Math.min(hi, this.normal(mu, sigma)));
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  fork(tag = 0) { return new RNG((this.s ^ (tag * 2654435761)) >>> 0); }

  // --- ここから下は追加分（セーブ用。上の挙動は変えない） ---

  // いまの状態を数ひとつで取り出す
  save() { return this.s >>> 0; }
  // 取り出した状態に戻す。以後は保存した時点の続きが出る
  load(state) { this.s = (state >>> 0) || 1; return this; }
}

// 種から作る。RNG を new せずに書けるようにするだけの入口
export function rng(seed = 1) { return new RNG(seed); }

// ---------------------------------------------------------------------------
// 機能ごとの12ストリーム（正典 #17 §10-3・A-01）
//
// **1本のままだと、これから足す機能のたびに基準線（M-01/M-05/M-07/**M-73**）が全損する。**
//   ★ 2026-09-01：M-32 は重複していたので M-73 へ移した（300年6通りの絶滅率のほう）
// 実際この設計を書いているあいだだけで「#9 の嵐」「#11-D の重み付き結婚」「#16 の授かりもの」
// 「#17 の分村検査」「#18 の目標と取り合い」「R-28 の狩りの当たり」が、それぞれ消費順を変えた。
//
// master seed から SplitMix64 で12本を派生させ、機能ごとに固定する。
// 以後、ストリーム k に呼び出しを足しても**他の11本は1ビットも動かない**ので、
// 取り直すのは k に依存する検査だけになる。
//
// ★ 掟：ストリーム内では、分岐で呼び出し回数を変えない。
//   （gifts.js が既に「天井が当たっても引いて捨てる」でやっている形を、全ストリームに広げる）
//
// ★ 0番（地形）だけは既にある。mapgen.generate(seed) が自前で RNG を立てて
//   起動時に使い切るので、構造として既に独立している。ここでは番号を予約するだけで、
//   種は付け替えない（付け替えると地図の実測値が理由なく全部ずれる）。

export const STREAM = {
  TERRAIN: 0,    // 地形（#17 S0）。既にある。mapgen が自前で立てる
  BIRTH: 1,      // 出生・遺伝・先天障害・性別
  GIFT: 2,       // 授かりもの（#16 rollGift）
  DEATH: 3,      // 死亡判定（老衰・病・事故・乳幼児）
  MARRY: 4,      // 結婚の相手選び（#11-D）
  SPLIT: 5,      // 分村（#11-B の θ と r）
  DISASTER: 6,   // 厄災（嵐・凶作・疫病・火災・獣害・洪水）
  HUNT: 7,       // 狩り・漁の当たり（#17 §5-2）
  RELIGION: 8,   // 宗教（発起・伝播・⑤の4出口）＋ #18 の目標の選び直しと6つの窓
  CRIME: 9,      // 犯罪（横領・不倫・冤罪・#7 §8）
  BATTLE: 10,    // 戦闘（O-27 後）
  SPARE: 11,     // 予備
};
export const STREAM_COUNT = 12;
export const STREAM_NAMES = [
  '地形', '出生', '授かりもの', '死亡', '結婚', '分村',
  '厄災', '狩り', '宗教', '犯罪', '戦闘', '予備',
];

// SplitMix64。12回しか呼ばないので BigInt でよい（速さは要らない）
const M64 = (1n << 64n) - 1n;
function splitmix64(state) {
  state = (state + 0x9E3779B97F4A7C15n) & M64;
  let z = state;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return { state, z: z ^ (z >> 31n) };
}

/**
 * 種1つから12本のストリームを派生させる。
 * @returns {RNG[]} 添字は STREAM の番号
 */
export function makeStreams(masterSeed = 1) {
  let st = BigInt((masterSeed >>> 0) || 1);
  const out = [];
  for (let i = 0; i < STREAM_COUNT; i++) {
    const r = splitmix64(st); st = r.state;
    // xorshift32 は 0 を種にできない
    out.push(new RNG((Number(r.z & 0xFFFFFFFFn) >>> 0) || (i + 1)));
  }
  return out;
}

/** 12本ぶんの状態を配列で取り出す（セーブ用） */
export function saveStreams(streams) { return streams.map(r => r.save()); }
/** 取り出した状態に戻す */
export function loadStreams(streams, states) {
  for (let i = 0; i < streams.length && i < states.length; i++) streams[i].load(states[i]);
  return streams;
}
