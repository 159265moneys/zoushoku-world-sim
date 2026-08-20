// v2 の共有データ契約。sim / ui / test の3モジュールはすべてこの形に対して書く。
// ここを変えるときは3モジュールを同時に直すこと。

import { GENE_NAMES } from './genes.js';

export const PHASE = { VILLAGE: 1, TRIBE: 2 };

// フェーズ移行の人口閾値
export const PHASE_THRESHOLD = { 1: 10, 2: 100 };

// 1世代あたりの実時間（ミリ秒）。R-960 / 10-設計-進行ロジック §7-2。
// P1 = 75秒（10体まで平均4.4世代 × 75秒 ＝ 約5.5分）。
// P2 = 180秒（100体まで平均10.2世代 × 180秒 ＝ 約30分。1セッション3〜9分＝1〜3世代）。
// 読むのは flow/clock.js の genMs()／tickMs() だけ。UI は clock 越しに読むこと。
export const GEN_MS = { 1: 75 * 1000, 2: 180 * 1000 };

// 役割。v2 では戦争局面と生産局面しか回さないので、この5つで足りる。
export const ROLE = {
  IDLE: 'idle',       // ニート。消費するが産出しない
  FARM: 'farm',       // 農作業。産出する
  HUNT: 'hunt',       // 狩り。産出しつつ武力の練度が伸びる。死ぬこともある
  DRILL: 'drill',     // 模擬戦。産出しないが安全に練度が伸びる
  WAR: 'war',         // 実戦。恐怖耐性の本命。死ぬ
  CHILD: 'child',     // 未成年。発現ウィンドウの中にいる
};

// 局（v2 は3つだけ。P2で解禁）
export const BUREAU = {
  MILITARY: 'military', // 軍務局
  AGRI: 'agri',         // 農業局
  CIVIL: 'civil',       // 民生局
};

export const BUREAU_LABEL = { military: '軍務局', agri: '農業局', civil: '民生局' };

// 練度が伸びる軸。素質（遺伝子）とは別に個体ごとに蓄積する。
export const SKILLS = ['恐怖耐性', '統率', '戦技', '農技', '狩技'];

// 居住区。環境係数を通じて練度の伸び率と発現を左右する。
export const DISTRICT = { CENTER: 'center', FRONTIER: 'frontier' };

/** 個体 */
export function makeIndividual(id, name, opts = {}) {
  return {
    id,
    name,
    alive: true,
    born: opts.born ?? 0,          // 生まれた世代
    age: opts.age ?? 0,
    sex: opts.sex ?? 0,            // 0/1。繁殖の組み合わせにのみ使う
    genes: opts.genes ?? blankGenes(),   // 素質。0..1。生涯不変
    expressed: opts.expressed ?? {},     // 発現済みフラグ（幼少期に局面に置かれたか）
    skills: opts.skills ?? blankSkills(),// 練度。0..1。遺伝しない
    role: opts.role ?? ROLE.CHILD,
    district: opts.district ?? DISTRICT.CENTER,
    bureau: null,                  // 局長ならどの局か
    fatherId: opts.fatherId ?? null,
    motherId: opts.motherId ?? null,
    // 血統の混合比。合計1。色相はこれで決まる（出自であってステータス傾向ではない）
    lineage: opts.lineage ?? { self: 1 },
    fatigue: 0,
    wounded: false,
    // 個人怨恨：相手idごとの負の重み。本人の死で消える。
    grudges: {},
    // 満たされていない欲。大罪は感受性×既存遺伝子から毎tick導出する。
    unmet: 0,
    deeds: [],                     // 実績。評価値の入力になる
    titles: [],                    // 叙勲・断罪。編むが書き込む
    deathGen: null,
    deathCause: null,
  };
}

export function blankGenes() {
  const g = {};
  for (const n of GENE_NAMES) g[n] = 0.5;
  return g;
}
export function blankSkills() {
  const s = {};
  for (const n of SKILLS) s[n] = 0;
  return s;
}

/** 村（プレイヤーの国） */
export function makeVillage() {
  return {
    phase: PHASE.VILLAGE,
    gen: 0,
    tick: 0,
    people: new Map(),      // id -> individual（生存者のみ）
    dead: new Map(),        // id -> individual（記録方針に従って間引く）
    nextId: 1,
    food: 20,               // 食料ストック
    yieldRate: 0,           // 産出率（直近の産出）
    consumption: 0,         // 消費
    density: 0,             // 密度ストレス
    tech: 0,                // 技術ポイント（v2では雀の涙）
    // 体制怨恨：民衆から国へ。消えない。家系に継承される。
    regimeGrudge: 0,
    morale: 0.6,            // 民心
    bureaus: { military: null, agri: null, civil: null }, // 局長のid
    budget: { military: 0.34, agri: 0.33, civil: 0.33 },  // 「配る」。合計1
    cards: {},              // 「敷く」。card id -> {on:bool, value:number}
    collapsing: false,
  };
}

/** 事件レコード。年代記の台座。真の原因と公表された帰属を別に持つのが要点。 */
export function makeEvent(id, gen, kind, opts = {}) {
  return {
    id, gen, kind,
    actor: opts.actor ?? null,     // 誰が
    target: opts.target ?? null,   // 誰に
    trueCause: opts.trueCause ?? null,   // 上流の事件id。システムだけが知る
    claimed: opts.claimed ?? null,       // 局長が報告した帰属
    canon: null,                          // オーナーが確定させた正史
    revealed: opts.revealed ?? false,     // 発生時点の諜報水準で確定
    effects: opts.effects ?? [],   // [{field, delta, subjectId}]
    text: opts.text ?? '',
  };
}

// 出所を持たせるのはこの5本だけ（設計文書「年代記」）
export const TRACKED = ['怨恨', '民心', '産出率', '血統', '帰属'];
