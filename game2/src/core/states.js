/**
 * 状態のビット。**ただの定数**なので world に置く理由がない。
 *
 * people.js に置いていたら、looks.js（見た目）が ST_HUNGRY を引こうとした瞬間に
 * people.js → looks.js → people.js の循環になって落ちた。
 * ビットの定義だけを core に出しておけば、誰がどこから引いても循環しない。
 */
export const ST_PREGNANT = 1 << 0;   // 妊娠。10ヶ月
export const ST_HUNGRY   = 1 << 1;   // 飢え
export const ST_SICK     = 1 << 2;   // 病
export const ST_GRIEF    = 1 << 3;   // 喪
export const ST_NURSING  = 1 << 4;   // 産後。次の子までの間
// ★ 永続4「繁殖不能」（正典 第7部 §1）。去勢（刑罰）／難産後の不妊／重い病（生殖器）。
//   受胎確率0・こころ×0.95。永続なので一度立つと落ちない
export const ST_BARREN   = 1 << 5;

export const STATE_BITS = [
  [ST_PREGNANT, '身重'],
  [ST_HUNGRY,   '飢え'],
  [ST_SICK,     '病'],
  [ST_GRIEF,    '喪'],
  [ST_NURSING,  '乳飲み子あり'],
  [ST_BARREN,   '子ができない'],
];
