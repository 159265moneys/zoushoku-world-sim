// 方針カード（動詞「敷く」）。名前つきカード ＋ 数値 ＋ オン/オフ。
// ここに書いてあるのは表示のための定義。実際の運用は sim 側 world.cards を読む。
// sim が CARDS を export していればそちらを優先する（api.js が解決）。

export const CARDS = [
  // ---- 軍務局 ----
  { id: 'send_top_pct', bureau: 'military', name: '上位◯%を派遣',
    desc: '戦力の高いほうから順に戦場へ送る。', unit: '%', min: 10, max: 100, step: 10, def: 50, on: true },
  { id: 'spare_elder', bureau: 'military', name: '◯歳以上は温存',
    desc: '老いた個体を戦場から外す。練度は残るが数が減る。', unit: '歳', min: 8, max: 40, step: 2, def: 18, on: false },
  { id: 'escort_talent', bureau: 'military', name: '才能に護衛を付ける',
    desc: '上位の個体に護衛を随伴させる。護衛は代わりに死ぬ。', unit: '人', min: 0, max: 3, step: 1, def: 1, on: false },
  { id: 'surrender_at', bureau: 'military', name: '団結が◯%を割ったら降伏を具申',
    desc: '不在時の応戦方針。0 なら降伏しない。', unit: '%', min: 0, max: 60, step: 5, def: 25, on: true },
  { id: 'drill_share', bureau: 'military', name: '模擬戦に回す割合',
    desc: '産出しないが安全に練度が伸びる。', unit: '%', min: 0, max: 60, step: 5, def: 20, on: true },

  // ---- 農業局 ----
  { id: 'farm_share', bureau: 'agri', name: '畑に回す割合',
    desc: '産出の本体。残りは狩りと模擬戦へ。', unit: '%', min: 0, max: 100, step: 5, def: 55, on: true },
  { id: 'stock_floor', bureau: 'agri', name: '備蓄を◯以下にしない',
    desc: '割り込むと配役が畑へ強制的に寄る。', unit: '', min: 0, max: 60, step: 5, def: 15, on: true },
  { id: 'frontier_farm', bureau: 'agri', name: '辺境も耕す',
    desc: '産出は落ちるが、辺境は練度の伸びがよい。', unit: '', min: 0, max: 0, step: 1, def: 0, on: false },

  // ---- 民生局 ----
  // sim の cards.js が本体（既定50＝中立）。ここは既定値を流し込むためだけに持つ。
  // 60 で撒いていたときは、プレイヤーが何も選んでいないのに融和側へ倒れていた。
  { id: 'mix_policy', bureau: 'civil', name: '外来血を混ぜる',
    desc: '0で隔離、100で融和。低いままだと外来の血は入っても混ざらず、斑が固定される。',
    unit: '%', min: 0, max: 100, step: 10, def: 50, on: true, flagship: true },
  { id: 'child_protect', bureau: 'civil', name: '◯歳未満は働かせない',
    desc: '発現ウィンドウを守る。産出は落ちる。', unit: '歳', min: 0, max: 8, step: 1, def: 3, on: true },
  { id: 'mercy', bureau: 'civil', name: '傷病者を養う',
    desc: '消費が増える。切り捨てると民心が落ちる。', unit: '', min: 0, max: 0, step: 1, def: 0, on: true },
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map(c => [c.id, c]));

/** world.cards に既定値を流し込む */
export function seedCards(api, world, list = CARDS) {
  for (const c of list) {
    if (world.cards && world.cards[c.id]) continue;
    api.setCard(world, c.id, c.on, c.def);
  }
}

export function cardValue(world, id, fallback = 0) {
  const c = world?.cards?.[id];
  if (!c || c.on === false) return fallback;
  return Number.isFinite(c.value) ? c.value : fallback;
}
