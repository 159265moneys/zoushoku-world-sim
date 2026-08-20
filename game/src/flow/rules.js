// flow/rules.js — 進行層の定数を1か所に集める（R-950）。
//
// ここに無い数字を flow/ の他のファイルに直書きしない。
// 「10体で止まる」「16体から戦える」「不応期は2世代」は全部この1枚で読めること。
//
// 掟：
//   - DOM も window も知らない（node から叩ける）
//   - Math.random() を書かない。Date.now() に依存した挙動を書かない
//   - 依存の向きは ui → flow → sim → core。sim へは index.js の公開面だけを触る

import { PHASE, PHASE_THRESHOLD, GEN_MS } from '../core/model.js';
import * as sim from '../sim/index.js';

export { PHASE, PHASE_THRESHOLD, GEN_MS };

// sim の定数はここで名前を付け直して配る（flow の他所から sim/constants を直接読まない）
export const TICKS_PER_GEN = sim.SIM_CONST.TICKS_PER_GEN;   // 12
export const ADULT_AGE = sim.SIM_CONST.ADULT_AGE;           // 2
export const FIRST_WAR_SIZE = sim.SIM_CONST.FIRST_WAR_SIZE; // 5

// ---------------------------------------------------------------------------
// 状態（10-設計-進行ロジック §2-2）。run.stage は常にこの12個のどれか1つ。
// ---------------------------------------------------------------------------
export const STAGE = {
  OPENING: 'OPENING',
  VILLAGE_GROW: 'VILLAGE_GROW',
  VILLAGE_FULL: 'VILLAGE_FULL',
  WAR_PICK: 'WAR_PICK',
  WAR_FORCE: 'WAR_FORCE',
  WAR_FIGHT: 'WAR_FIGHT',
  WAR_SETTLE: 'WAR_SETTLE',
  WAR_CAPTIVE: 'WAR_CAPTIVE',
  WAR_BORDER: 'WAR_BORDER',
  WAR_DONE: 'WAR_DONE',
  TRIBE: 'TRIBE',
  ENDED: 'ENDED',
};

/** 戦争の途中。この間は world の値から stage を作り直さない（war.js が持ち主） */
export const WAR_STAGES = new Set([
  STAGE.WAR_PICK, STAGE.WAR_FORCE, STAGE.WAR_FIGHT,
  STAGE.WAR_SETTLE, STAGE.WAR_CAPTIVE, STAGE.WAR_BORDER,
]);

/** 世界の時計が動いてよい stage はこの2つだけ（R-956） */
export const RUNNING_STAGES = new Set([STAGE.VILLAGE_GROW, STAGE.TRIBE]);

// ---------------------------------------------------------------------------
// 村（R-954 / R-955 / R-956 / R-957）
// ---------------------------------------------------------------------------
/** 村の人口上限。10。ここを超えて増えない（R-104 / R-954） */
export const VILLAGE_CAP = PHASE_THRESHOLD[1];       // 10
/** 段A：世代の直前に fertBias を絞る割り算の分母。実測で /3 が平均4.1世代・最遅6（§3-2） */
export const FERT_DIVISOR = 3;
/** あふれた新生児の死因（R-955）。戦死・餓死・老衰とは別に数える */
export const CAUSE_LEAVE = '旅立ち';
/** P1のあいだ固定する透過率。0.5 だと村中が狩人になって第7世代で飢饉（R-957） */
export const VILLAGE_TRANSPARENCY = 0.9;
/** P2に上がった瞬間に戻す値。以降は hereditary カードが握る（R-320 / R-323） */
export const TRIBE_TRANSPARENCY = 0.5;

// ---------------------------------------------------------------------------
// 初戦（R-958 / R-959）
// ---------------------------------------------------------------------------
/** 隣村ゴーストをいくつ作るか。相手選択画面に並ぶ数 */
export const NEIGHBOR_COUNT = 3;
/**
 * makeGhost に渡す power。**1 以外を渡してはいけない。**
 * 300 を渡すと clamp01(rng.range(0,0.30) * 300) が上限に張り付き、
 * 実測で練度の 99.0%（6378/6440項目）が 1.00 ＝ 最強の相手が出る（R-958）。
 */
export const NEIGHBOR_POWER = 1;
/** ゴーストの種を world.seed から導くための撹拌値。Date.now() は使わない（R-001） */
export const NEIGHBOR_SALT = 0x51ed;

// ---------------------------------------------------------------------------
// P2の戦争（R-963）
// ---------------------------------------------------------------------------
/** ① 相手の出撃上限＝こちらの出撃数の1.5倍。国力の差は「数」ではなく「質」で出す */
export const ENEMY_DEPLOY_RATIO = 1.5;
/** pickEnemyForce に渡す割合の下限・上限（sim 側の式が壊れない範囲） */
export const ENEMY_DEPLOY_MIN = 0.05;
export const ENEMY_DEPLOY_MAX = 0.45;
/** ② 戦いに行ける最低人口。実測で10体のまま戦い続けると 6/10 が人口5未満に落ちた */
export const WAR_MIN_POP = 16;
/** ③ 不応期。P2は1世代180秒なので実時間6分（R-960 適用後） */
export const WAR_COOLDOWN_GENS = 2;
/** 相手候補一覧から外す人口。滅びかけの国を「いちばん弱い相手」として並べない */
export const OPPONENT_MIN_POP = 8;
/** 自軍の出撃がこれを割るなら開戦しない（1体で行かせない） */
export const MIN_DEPLOY = 2;

// ---------------------------------------------------------------------------
// 戦闘の時間（R-961）。UI が読む。flow 自身はミリ秒を数えない
// ---------------------------------------------------------------------------
export const ROUND_MS_FIRST = 2500;
export const ROUND_MS_TRIBE = 1200;
export const SETTLE_HOLD_MS = 8000;

// ---------------------------------------------------------------------------
// 崩壊と終端（R-965）
// ---------------------------------------------------------------------------
/** モーダルで止めるのはここだけ。人口が2未満＝もう子が生まれない */
export const EXTINCT_POP = 2;
/** v2 の終端。世界は止めない */
export const HUNDRED = PHASE_THRESHOLD[2];           // 100

// ---------------------------------------------------------------------------
// P2に上がった瞬間に立てる既定カード（R-964）。id は sim/cards.js のもの
// ---------------------------------------------------------------------------
export const TRIBE_CARDS = [
  { id: 'hunt_ratio', value: 30, why: '狩りは生産と練度を両立する唯一の役（R-425）' },
  { id: 'stockpile', value: 15, why: '蔵の目標を持たないと飢饉の前に配給を絞れない' },
  { id: 'ration_equal', value: 50, why: '配給の傾斜を中立に置く' },
  { id: 'hereditary', value: 50, why: 'ここで透過率が 0.9 から離れて世襲が起動する（R-320）' },
  { id: 'mix_policy', value: 50, why: 'P2の第一問（融和か隔離か・R-311）' },
];
/** P1では1枚も立てない（R-964）。この配列が空であること自体が要件 */
export const VILLAGE_CARDS = [];

// ---------------------------------------------------------------------------
// 国境の3択（R-750）。画面の語彙 → sim が読む語
// ---------------------------------------------------------------------------
export const BORDER_DECISION = {
  accept: 'accept', 受け入れ: 'accept',
  kill: 'kill', execute: 'kill', 誅殺: 'kill',
  return: 'return', 送還: 'return',
};

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);

/** world だけから決まる stage。戦争中（WAR_STAGES）には使わない */
export function stageOf(world) {
  if (!world || !world.people) return STAGE.OPENING;
  if (world.people.size < EXTINCT_POP) return STAGE.ENDED;
  if (world.phase !== PHASE.VILLAGE) return STAGE.TRIBE;
  if (world.pendingFirstWar) return STAGE.VILLAGE_FULL;
  return STAGE.VILLAGE_GROW;
}

/** まだ初戦を終えていないか（初戦は R-963 の3条件を全部無視する） */
export function isFirstWar(world) {
  return !!world && world.phase === PHASE.VILLAGE && !world.firstWarDone;
}
