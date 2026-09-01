// 10国のライバル・ロスター ── 正典1-1c（530-566）
//
// > **オンライン前は、あらかじめ10の国を同じルールで走らせ、その記録（ゴースト）を持つ。**
// > そこから相手を選んで戦争する。
// > **★ 10国は開発時に1度回して記録を取る。本番のセッション中に並行して走らせるのではない**
// >   （#12-C の予算を動かさないため）。
// > **★ 作者が書いた CPU ではなく、同じルールで実際に走った世界であること。**
// >   **これが柱4「他の遊び手が新しい血の供給元」を、オンライン前でも成立させる唯一の方法。**
//
// ★ **見せ方**：相手の選択画面では **国力しか見せない**（#13 の情報遮断）。
//   内訳を覗くのは開発用のデバッグトグルだけで、本番には出さない。
// ★ **乱数を1回も引かない。**

/** 10の経営思想（正典540-551 の表そのまま。id は原文のまま） */
export const PROFILES = [
  { id: 'martial',  name: '武断',   how: '狩り・実戦に厚く配役。武の才能を優先抜擢。降伏しない' },
  { id: 'agrarian', name: '農本',   how: '産出優先。備蓄を厚く。戦争は最小限' },
  { id: 'fecund',   name: '多産',   how: '繁殖力優先。質より量。密度ストレスを許容' },
  { id: 'purist',   name: '純血',   how: '捕虜をほぼ誅殺。自国産の血だけで回す' },
  { id: 'melting',  name: '融和',   how: '捕虜を全部受け入れる。混血を最大化' },
  { id: 'terror',   name: '恐怖',   how: '恨みを無視して粛清を多用。従順を選抜' },
  { id: 'laissez',  name: '放任',   how: 'ほとんど何もしない。局長に丸投げ' },
  { id: 'pious',    name: '信仰',   how: '信心・団結を選抜。排他的で捕虜を拒む' },
  { id: 'merit',    name: '実力主義', how: '才能上位を抜擢。家柄を無視（透過率を最大に）' },
  { id: 'dynastic', name: '世襲',   how: '局長の血統を固定（透過率を最小に）' },
];

/**
 * ★ 各国が動かすカード（動詞5つの自動運転・正典565
 *   「自動オーナーは、動詞5つをプロファイルに従って自動で撃つ」）。
 *   ★ **正典に数値パラメータは無い**（B-46）。ここは方針の名前から素直に引いた段だけを置く。
 *   ★ どれも #18 §1 の既存のカードで、**新しいつまみを作らない**。
 */
export const PROFILE_CARDS = {
  martial:  { 徴兵率: 2, 工事に回す働き手の割合: -1 },
  agrarian: { 徴兵率: -2, 蔵の上限: 2, 工事に回す働き手の割合: 1 },
  fecund:   { 婚姻圧: 2, 徴兵率: -1 },
  purist:   { よそ者の受け入れ: -2, 徴兵率: 1 },
  melting:  { よそ者の受け入れ: 2, 婚姻圧: 1 },
  terror:   { 徴兵率: 1 },
  laissez:  {},
  pious:    { よそ者の受け入れ: -1 },
  merit:    {},
  dynastic: {},
};

/**
 * ロスター1件（ゴースト）。**記録であって、走っている世界ではない。**
 * ★ 相手の選択画面に出せるのは `power` だけ（正典562 の情報遮断）
 */
export class Ghost {
  constructor(id, name, how, seed, power, snapshot = null) {
    this.id = id; this.name = name; this.how = how;
    this.seed = seed; this.power = power;
    this._snapshot = snapshot;      // ★ 開発用。本番の画面には出さない
  }
  /** 画面に出してよいもの（正典562「国力しか見せない」） */
  get shown() { return { id: this.id, name: this.name, power: this.power }; }
}

/** 記録の入れ物。★ 開発時に1度走らせて詰める */
export class Roster {
  constructor(ghosts = []) { this.ghosts = ghosts; }
  get length() { return this.ghosts.length; }
  /**
   * 相手を探す（正典3677「国力の帯を数値で指定 → 候補一覧」）。
   * ★ **地理でマッチングしない**（正典517「隣接は戦争の条件ではない」）
   */
  search(myPower, bandPct = 20) {
    const lo = myPower * (1 - bandPct / 100), hi = myPower * (1 + bandPct / 100);
    return this.ghosts.filter((g) => g.power >= lo && g.power <= hi).map((g) => g.shown);
  }
  /** 順位（正典508「国力ランキング1位。それは全プレイヤー間の順位」） */
  ranking(myPower) {
    const all = [...this.ghosts.map((g) => ({ id: g.id, name: g.name, power: g.power })),
                 { id: 'me', name: 'あなたの国', power: myPower }];
    all.sort((a, b) => b.power - a.power);
    return all.map((x, k) => ({ ...x, rank: k + 1 }));
  }
}

// ---------------------------------------------------------------------------
// ★★ 記録（ゴースト）── **開発時に1度回して取った**（正典533）★★
// ---------------------------------------------------------------------------
//   2026-09-01 に、**同じルールで実際に10の世界を300年走らせて**記録した。
//   作者が書いた CPU ではない（正典535「同じルールで実際に走った世界であること」）。
//   ★ 各国は**別の種**（＝別の地図・別の血）で、方針カードだけを自分の思想に寄せてある。
//   ★ 走らせ方：`new World(seed).genesis()` → プロファイルのカードを置く → 300年。
//     再現したければ同じ手順で1文字も違わない結果が出る（決定性は検査が毎回証明している）。
export const GHOSTS = [
  { id: 'martial',  seed:  3, pop: 1433, power: 122.5 },
  { id: 'agrarian', seed: 13, pop: 3135, power: 191.1 },
  { id: 'fecund',   seed: 37, pop: 1572, power: 131.1 },
  { id: 'purist',   seed: 11, pop: 1684, power: 136.2 },
  { id: 'melting',  seed:  7, pop: 3222, power: 214.4 },
  { id: 'terror',   seed: 17, pop:  687, power:  79.4 },
  { id: 'laissez',  seed: 19, pop: 2163, power: 143.2 },
  { id: 'pious',    seed: 47, pop: 3534, power: 229.4 },
  { id: 'merit',    seed: 61, pop:  351, power:  63.3 },
  { id: 'dynastic', seed: 67, pop: 1339, power: 110.5 },
];

/** 既定のロスター（10国）。★ 本番の画面に出せるのは `power` だけ */
export function defaultRoster() {
  const byId = new Map(PROFILES.map((p) => [p.id, p]));
  return new Roster(GHOSTS.map((g) => {
    const p = byId.get(g.id);
    return new Ghost(g.id, p.name, p.how, g.seed, g.power, { pop: g.pop });
  }));
}
