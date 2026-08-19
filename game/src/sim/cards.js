// 「敷く」＝名前つき方針カード ＋ 数値パラメータ ＋ オン/オフ。
// オーナーが置けるのはカードの粒度まで。その先の運用は局長の人格を通って歪む。
// 「30%と命じたのに頑迷な局長は40%でやった」は読める。読めない歪みは作らない。

import { BUREAU } from '../core/model.js';
import { clamp } from './derive.js';

export const CARDS = [
  { id: 'deploy_top',   bureau: BUREAU.MILITARY, label: '上位N%を派遣',       min: 0,  max: 100, step: 5,  def: 40, unit: '%' },
  { id: 'spare_old',    bureau: BUREAU.MILITARY, label: 'N歳以上は温存',      min: 2,  max: 12,  step: 1,  def: 7,  unit: '歳' },
  { id: 'raise_young',  bureau: BUREAU.MILITARY, label: '育成派遣（若手を実戦へ）', min: 0, max: 100, step: 10, def: 20, unit: '%' },
  { id: 'guards',       bureau: BUREAU.MILITARY, label: '要人にN体を随伴',     min: 0,  max: 5,   step: 1,  def: 0,  unit: '体' },
  { id: 'drill',        bureau: BUREAU.MILITARY, label: '模擬戦にN%を割く',    min: 0,  max: 60,  step: 5,  def: 10, unit: '%' },
  { id: 'surrender_at', bureau: BUREAU.MILITARY, label: '団結がN%を切ったら降伏具申', min: 0, max: 90, step: 10, def: 0, unit: '%' },
  { id: 'hunt_ratio',   bureau: BUREAU.AGRI,     label: '狩猟にN%を割く',      min: 0,  max: 80,  step: 5,  def: 30, unit: '%' },
  { id: 'stockpile',    bureau: BUREAU.AGRI,     label: '備蓄をN日分確保',     min: 0,  max: 60,  step: 5,  def: 15, unit: '' },
  { id: 'frontier',     bureau: BUREAU.CIVIL,    label: 'N%の家系を辺境へ',    min: 0,  max: 100, step: 10, def: 20, unit: '%' },
  { id: 'ration_equal', bureau: BUREAU.CIVIL,    label: '配給を平等にする',    min: 0,  max: 100, step: 10, def: 50, unit: '%' },
  { id: 'hereditary',   bureau: BUREAU.CIVIL,    label: '世襲を尊重する',      min: 0,  max: 100, step: 10, def: 50, unit: '%' },
  // フェーズ2の第一問。0＝隔離して純血を保つ / 100＝混ぜて雑種強勢を取る。
  // 「100体の段階で融和か優生かを選ばされる。しかも読める規模で」
  { id: 'mix_policy',   bureau: BUREAU.CIVIL,    label: '外来血を混ぜる',      min: 0,  max: 100, step: 10, def: 50, unit: '%' },
];

export const CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

export function defaultCards() {
  const o = {};
  for (const c of CARDS) o[c.id] = { on: false, value: c.def };
  return o;
}

export function setCard(world, cardId, on, value) {
  const def = CARD_BY_ID.get(cardId);
  if (!def) return null;
  const slot = world.cards[cardId] || (world.cards[cardId] = { on: false, value: def.def });
  slot.on = !!on;
  if (value != null && Number.isFinite(value)) {
    slot.value = clamp(Math.round(value / def.step) * def.step, def.min, def.max);
  }
  return slot;
}

/**
 * カードの実効値。局長の人格でここが歪む。
 *   頑迷 → 自分の慣れた値へ引き戻す（オーダーを読み替える）
 *   野心 → 指令を超えて拡大する
 *   保身 → 縮める
 * 局長が空席（P1）なら歪みはゼロ。オーナーの数字がそのまま通る。
 */
export function readCard(world, cardId) {
  const def = CARD_BY_ID.get(cardId);
  if (!def) return 0;
  const slot = world.cards[cardId];
  if (!slot || !slot.on) return null; // オフのカードは効かない
  const chiefId = world.bureaus[def.bureau];
  const chief = chiefId != null ? world.people.get(chiefId) : null;
  if (!chief) return slot.value;
  const g = chief.genes;
  const span = def.max - def.min;
  let v = slot.value;
  // 頑迷：自分の性格が示す既定値に引き戻す
  const own = def.min + span * clamp(0.35 + 0.5 * g.勤勉 - 0.2 * g.保身, 0, 1);
  v = v + (own - v) * (0.55 * g.頑迷) * (1 - 0.6 * g.柔軟);
  // 野心：拡大、保身：縮小
  v += span * (0.18 * g.野心 - 0.16 * g.保身);
  return clamp(v, def.min, def.max);
}

/** カードがオフのときの既定値。局面ルールが最低限回るための床。 */
export function cardOr(world, cardId, fallback) {
  const v = readCard(world, cardId);
  return v == null ? fallback : v;
}
