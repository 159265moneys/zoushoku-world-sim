// 状態12個の倍率表（正典 第7部 §1）。**実効値の器そのもの。**
//
//   M[枠] = Π(永続5個)[枠] × ( f[枠] + (1 − f[枠]) × Π(一時7個)[枠] )
//
//   からだ／あたま：実効値 = (才能 + 努力値) × M[枠] × Π(例外倍率)
//   こころ        ：実効値 = 現在値       × M[こころ]
//   国民力①      = (才能 + 努力値) × Π(永続5個) × Π(例外倍率)   ← 括弧を外すだけ
//
// ★ ここに畳んだもの（people.js から消えたもの）
//     ageCurve() の外出し計算   → 永続1「老い」
//     DEBUFF_FLOOR = 0.25       → 廃止。永続に床は無い（老いは0.15まで素通り＝老人の個体差が残る）
//     HUNGRY_MUL = 0.85         → 一時6「欠乏」段1
//     SICK_MUL   = 0.70         → 一時7「病」段2
//     PREGNANT_BODY_MUL = 0.75  → 一時10「妊娠」後期
//   **3つとも1つも捨てていない。**表の該当マスに座っている。
//
// ★ ソフト床 f + (1−f)Π は Π に対して単調なので、**順序はどの深さでも保存される。**
//   （硬い床0.30 だと、健康な55歳も瀕死の55歳も 0.300 で潰れて区別がつかなくなる）
//
// ★ 状態の内部パラメータに使うステは「才能＋努力値」／「gene+drift」の**素の値**を読む。
//   実効値は読まない（循環するため）。

import * as S from '../core/stats.js';
import { bandNorm } from '../core/bands.js';   // レア度の帯（正典2-4）
import {
  ST_PREGNANT, ST_HUNGRY, ST_SICK, ST_GRIEF, ST_NURSING, ST_BARREN,
} from '../core/states.js';

// ---- 枠 -------------------------------------------------------------------
export const FRAME_BODY = 0, FRAME_HEAD = 1, FRAME_HEART = 2;
// f（一時7個の積にだけ掛かる床）。正典2-2「こころは重ならない／あたまは最大4つ／
// からだは全部を食らう」の順。Π一時=1 のとき括弧=1 になるので健康な者は永続の値そのまま
export const FRAME_FLOOR = [0.20, 0.30, 0.45];

// 大項目（CSV）→ 枠。stats.js の BODY/MIND/HEART と同じ並び
export const frameOf = (s) => S.CATEGORY[s];

// ---- 永続1 老い -----------------------------------------------------------
// 25歳未満の立ち上がりも同じスロットに畳む
export const PEAK_AGE = 26;
export const AGE_FALL = 0.85;   // 寿命に達したとき からだ が何割落ちるか
export const AGE_POW = 1.4;     // 落ち方の曲がり。老いの速さ34（母集団の中央）でこの値
export const RISE_POW = 0.60;   // 26歳までの立ち上がり（からだのみ）
export const HEAD_FALL = 0.45;  // あたまは浅く落ちる
export const HEAD_LAG = 0.8;    // あたまは遅く始まる（指数に足す）

/**
 * 老い。3枠ぶんを返す。
 * @param speed 老いの速さ（2番B・レアB・帯15〜53・中央34）の素値。34 で AGE_POW そのもの
 */
export function aging(ageYears, lifespan, speed, out) {
  if (ageYears < PEAK_AGE) {
    const r = ageYears / PEAK_AGE;
    out[0] = r <= 0 ? 0.02 : Math.max(0.02, Math.pow(r, RISE_POW));
    out[1] = 1; out[2] = 1;            // 立ち上がりを あたま・こころ に掛けない
    return out;
  }
  const span = Math.max(1, lifespan - PEAK_AGE);
  let t = (ageYears - PEAK_AGE) / span;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  let p = AGE_POW * (1.35 - 0.35 * speed / 34);
  if (p < 0.98) p = 0.98; else if (p > 1.89) p = 1.89;
  out[0] = 1 - AGE_FALL * Math.pow(t, p);
  out[1] = 1 - HEAD_FALL * Math.pow(t, p + HEAD_LAG);
  out[2] = 1;                          // ★ 老いはこころに×1.00
  return out;
}

// ---- 永続2 古傷 -----------------------------------------------------------
// 部位。0 は「その本は空き」
export const PART_NONE = 0, PART_ARM = 1, PART_LEG = 2, PART_EYE = 3,
             PART_EAR = 4, PART_LOST = 5;
export const PART_NAMES = ['—', '腕', '脚', '眼', '耳', '欠損'];
export const SCAR_SLOTS = 4;           // 最大4本。5本目は同部位なら w を max で統合、無ければ最小 w を捨てる

const SCAR_BODY = [0, 0.18, 0.18, 0.12, 0.06, 0.30];   // b[p]
const SCAR_HEAD = [0, 0.00, 0.00, 0.06, 0.06, 0.03];   // h[p]
// 例外倍率（対象はすべて CSV 実在）。欠損は腕/脚/眼/耳 を1つ抽選して w=3 で適用する
const SCAR_EXC = [0, 0.30, 0.35, 0.55, 0.55, 0];
const SCAR_EXC_STATS = [
  [],
  ['最大筋力', '握力', '手先の器用さ', 'リーチ', '肩幅'],
  ['走力', '敏捷', '持久力', '平衡感覚', '瞬発力'],
  ['視力', '夜目', '色の見分け'],
  ['聴力', '三半規管'],
  [],
];

// ---- 永続3 先天障害 -------------------------------------------------------
export const DEFECT_NONE = 0, DEFECT_BODY = 1, DEFECT_HEAD = 2,
             DEFECT_HEART = 3, DEFECT_HIDDEN = 4;
export const DEFECT_NAMES = ['—', '体', '頭', '心', '隠れ'];
export const DEFECT_SHARE = [0.45, 0.30, 0.10, 0.15];   // 体/頭/心/隠れ
export const DEFECT_W_SHARE = [0.60, 0.30, 0.10];       // w=1/2/3
/** 発現確率／出生。生存力0.74（実測平均）→1.83%／0.35（LOAD_FLOOR）→3.98% */
export function defectRate(vitality) {
  const p = 0.004 + 0.055 * (1 - vitality);
  return p < 0 ? 0 : p > 0.25 ? 0.25 : p;
}

// ---- 永続4 繁殖不能 -------------------------------------------------------
// ★ 2026-08-28 オーナー裁定（裁定を仰ぐ.md B-13）
//   「不妊はシンプルに**その出産が失敗**なだけで、永続するデバフでなくていい」
//   → 難産から繁殖不能へ行く道は**閉じた。**12% は「そのお産が流れる」になった。
//   残る発生源は 去勢（刑罰）と 重い病（生殖器）だけ。どちらもまだ実装が無い。
export const BARREN_HEART = 0.95;
export const HARD_BIRTH_EASE = 25;             // お産の軽さの素値がこれ未満なら難産
export const HARD_BIRTH_FAIL = 0.12;           // 難産のうち、そのお産が流れる割合

// ---- 永続5 発育不全 -------------------------------------------------------
// 16歳までに 欠乏 段2以上の累計月数 M が 6≤M<18 → w=1 ／ 18≤M → w=2
export const STUNT_AGE = 16, STUNT_M1 = 6, STUNT_M2 = 18;
const STUNT_EXC_STATS = ['身長', '骨太さ', '肩幅', 'リーチ', '体重'];

// ---- 一時7個の表 ----------------------------------------------------------
// [段-1][枠]。枠は からだ/あたま/こころ
export const TEMP = {
  欠乏: [[0.85, 0.94, 0.96], [0.72, 0.86, 0.90], [0.58, 0.76, 0.82]],
  病:   [[0.86, 0.93, 0.97], [0.70, 0.80, 0.92], [0.52, 0.66, 0.86]],
  負傷: [[0.85, 1.00, 0.98], [0.66, 1.00, 0.94], [0.45, 1.00, 0.88]],
  疲労: [[0.94, 0.90, 0.95], [0.86, 0.76, 0.88], [0.74, 0.58, 0.78]],
  妊娠: [[0.95, 0.99, 0.96], [0.86, 0.98, 0.92], [0.75, 0.97, 0.88]],
};
// 産後は段が2つ（産褥 月1-2／授乳 月3-6）
export const AFTER_BIRTH = [[0.84, 0.95, 0.92], [0.93, 0.98, 0.96]];
export const AFTER_BIRTH_HARD_BODY = 0.72;   // 難産だった場合、産褥期のからだを置換

// 共通の緩和：実際の倍率 = 1 − (1 − 表の値) × (1 − 耐性の素値/250)
// 耐性100 でも損失は 0.6倍までしか消えない。**完全無効化しない**
export const EASE_DIV = 250;
export const ease = (v, resist) => 1 - (1 - v) * (1 - resist / EASE_DIV);

// 妊娠の例外倍率
const PREG_EXC = [0.95, 0.85, 0.70];
const PREG_EXC_STATS = ['走力', '敏捷', '瞬発力', '持久力', '平衡感覚', '柔軟性'];

// 喪
export const GRIEF_HEAD = 0.15, GRIEF_HEART = 0.35;
export const GRIEF_KIN = { 子: 1.00, 伴侶: 0.90, 親: 0.60, きょうだい: 0.50, 孫: 0.40 };
export const GRIEF_DROP = 0.05;    // s がこれを切ったら状態を落とす
/** τ（ヶ月）。情55（E・中央）→5.80 ／ 情0→3.60 ／ 情100・死の受容100→3.30 */
export function griefTau(mercy, acceptance = 0) {
  return 6 * (0.6 + mercy / 150) * (1 - acceptance / 200);
}

// 疲労点
export const FATIGUE_MAX = 12;
export const FATIGUE_GAIN = 2.60, FATIGUE_DRAIN = 3.10;
export const LOAD_IDLE = 0, LOAD_NORMAL = 1.0, LOAD_HARVEST = 1.3,
             LOAD_WAR = 1.5, LOAD_RUSH = 1.8;
export const fatigueStage = (pt) => (pt < 3 ? 0 : pt < 6 ? 1 : pt < 10 ? 2 : 3);

// ---- ステ番号。起動時に1度だけ引く -----------------------------------------
const ID = {
  老いの速さ: S.needId('老いの速さ'),
  飢えへの強さ: S.needId('飢えへの強さ'),
  病への強さ: S.needId('病への強さ'),
  情: S.needId('情'),
  繁殖力: S.needId('繁殖力'),
  疲労の抜けやすさ: S.needId('疲労の抜けやすさ'),
  必要睡眠: S.needId('必要睡眠'),
  お産の軽さ: S.needId('お産の軽さ'),
  傷の治り: S.needId('傷の治り'),
};
export { ID as STAT_ID };

// 例外倍率の当たり先を、ステ番号 → 係数の対応表に畳んでおく（毎月引き直さない）
function idsOf(names) { return names.map(n => S.needId(n)); }
const SCAR_EXC_IDS = SCAR_EXC_STATS.map(idsOf);
const PREG_EXC_IDS = idsOf(PREG_EXC_STATS);
const STUNT_EXC_IDS = idsOf(STUNT_EXC_STATS);
const ID_STRENGTH = S.needId('最大筋力');

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * ある個体の M[枠] を3枠ぶん求める。
 * @param out 長さ3の配列を使い回す（毎月10万人ぶん呼ぶので確保しない）
 * @param permOnly 真なら括弧を外す＝国民力①（一時7個を見ない）
 */
const _age = [0, 0, 0];
export function frames(P, i, out, permOnly = false) {
  const A = P.a;
  // ★★ 錨を**帯**へ（2026-08-31・レア度の帯の実装にあわせて）★★
  //   この関数の中の係数（老いの速さ／飢えへの強さ／病への強さ／疲労／必要睡眠）は
  //   すべて「才能50が中央」で校正されている。帯を入れると 106ステのうち **77個（D/C/B/A）
  //   の帯が50より下**に来るので、そのままだと全員が虚弱になる（実測：病死 21.8%→31.5%）。
  //   `bandNorm×100` は **帯の中心をちょうど50に写す**ので、校正済みの係数が1つも動かない。
  //   ★ 逆に、正典が**帯に紐づけて決めた閾値は写さない**（例：宗教の発起 T_f=60 は
  //     「帯F 44〜77 の上位半分」と正典が明記しているので、生の値のまま読む）
  const raw = (s) => bandNorm(s, A.gene[s][i] + A.ev[s][i]) * 100;

  // ---- 永続5個 ----
  aging(A.ageMonths[i] / 12, A.lifespan[i], raw(ID.老いの速さ), _age);
  let b = _age[0], h = _age[1], c = _age[2];

  // 2 古傷
  for (let k = 0; k < SCAR_SLOTS; k++) {
    const p = A.scarPart[k][i];
    if (!p) continue;
    const w = A.scarW[k][i];
    b *= 1 - SCAR_BODY[p] * w / 3;
    h *= 1 - SCAR_HEAD[p] * w / 3;
  }

  // 3 先天障害
  const dt = A.defectType[i];
  if (dt) {
    const w = A.defectW[i];
    if (dt === DEFECT_BODY) b *= 1 - 0.15 * w;
    else if (dt === DEFECT_HEAD) h *= 1 - 0.15 * w;
    else if (dt === DEFECT_HEART) c *= 1 - 0.10 * w;
    else if (dt === DEFECT_HIDDEN) b *= 1 - 0.03 * w;
  }

  // 4 繁殖不能
  if (A.state[i] & ST_BARREN) c *= BARREN_HEART;

  // 5 発育不全
  const st = A.stunt[i];
  if (st) { b *= 1 - 0.07 * st; h *= 1 - 0.03 * st; }

  if (permOnly) { out[0] = clamp01(b); out[1] = clamp01(h); out[2] = clamp01(c); return out; }

  // ---- 一時7個 ----
  let tb = 1, th = 1, tc = 1;
  const state = A.state[i];

  // 6 欠乏（連続1〜2ヶ月=軽／3〜5=中／6〜=重）。緩和は飢えへの強さ
  if (state & ST_HUNGRY) {
    const m = A.hungerMonths[i];
    const w = m >= 6 ? 2 : m >= 3 ? 1 : 0;
    const r = raw(ID.飢えへの強さ), row = TEMP.欠乏[w];
    tb *= ease(row[0], r); th *= ease(row[1], r); tc *= ease(row[2], r);
  }

  // 7 病（1軽／2重／3疫病）。緩和は病への強さ
  const sick = A.sickStage[i];
  if (sick) {
    const r = raw(ID.病への強さ), row = TEMP.病[sick - 1];
    tb *= ease(row[0], r); th *= ease(row[1], r); tc *= ease(row[2], r);
  }

  // 8 負傷（1軽／2中／3重）。★ 負傷は深さでなく治癒月数に効くので緩和を掛けない
  const hurt = A.hurtStage[i];
  if (hurt) {
    const row = TEMP.負傷[hurt - 1];
    tb *= row[0]; th *= row[1]; tc *= row[2];
  }

  // 9 疲労
  const fw = fatigueStage(A.fatigue[i]);
  if (fw) {
    const row = TEMP.疲労[fw - 1];
    tb *= row[0]; th *= row[1]; tc *= row[2];
  }

  // 10 妊娠（初期1-3／中期4-7／後期8-10）
  const pw = pregStage(P, i);
  if (pw) {
    const row = TEMP.妊娠[pw - 1];
    tb *= row[0]; th *= row[1]; tc *= row[2];
  }

  // 11 産後（産褥 月1-2／授乳 月3-6）
  const aw = afterBirthStage(P, i);
  if (aw) {
    const row = AFTER_BIRTH[aw - 1];
    tb *= (aw === 1 && A.hardBirth[i]) ? AFTER_BIRTH_HARD_BODY : row[0];
    th *= row[1]; tc *= row[2];
  }

  // 12 喪
  const g = A.grief[i];
  if (g > 0) { th *= 1 - GRIEF_HEAD * g; tc *= 1 - GRIEF_HEART * g; }

  out[0] = clamp01(b * (FRAME_FLOOR[0] + (1 - FRAME_FLOOR[0]) * tb));
  out[1] = clamp01(h * (FRAME_FLOOR[1] + (1 - FRAME_FLOOR[1]) * th));
  out[2] = clamp01(c * (FRAME_FLOOR[2] + (1 - FRAME_FLOOR[2]) * tc));
  return out;
}

// 最終 clamp。0除算よけであって、設計上の床ではない
const clamp01 = (v) => (v < 0.01 ? 0.01 : v > 1 ? 1 : v);

/** 妊娠の段（0=なし／1初期／2中期／3後期） */
export function pregStage(P, i) {
  const A = P.a;
  if (!(A.state[i] & ST_PREGNANT)) return 0;
  const left = (A.pregDue[i] - P.tickNow) / 30;         // 残り月数
  const m = 10 - left;                                  // 経過月（1〜10）
  return m <= 3 ? 1 : m <= 7 ? 2 : 3;
}

/** 産後の段（0=なし／1産褥 月1-2／2授乳 月3-6） */
export function afterBirthStage(P, i) {
  const A = P.a;
  if (!(A.state[i] & ST_NURSING)) return 0;
  const m = (P.tickNow - A.lastBirth[i]) / 30;
  return m < 2 ? 1 : m < 6 ? 2 : 0;
}

/**
 * ステ1本ぶんの例外倍率（Π(例外倍率[i])）。M[枠] の外に掛かる。
 * 古傷の部位・発育不全・妊娠が、名指しのステだけをさらに削る。
 */
/**
 * その人に例外倍率の**元が1つでもあるか**。★ 無ければ `exception` は必ず 1.0。
 * 古傷・発育不全・先天障害（体／隠れ）・妊娠 のどれも無い者が大半なので、
 * ここで弾くと 国民力①（75ステ）の計算から `exception` の呼び出しがまるごと消える。
 * ★ 近似ではない。**無い者は本当に 1.0 になる**（下の exception と同じ条件を見ている）。
 */
export function hasException(P, i) {
  const A = P.a;
  for (let k = 0; k < SCAR_SLOTS; k++) if (A.scarPart[k][i]) return true;
  if (A.stunt[i]) return true;
  const dt = A.defectType[i];
  if (dt === DEFECT_BODY || dt === DEFECT_HIDDEN) return true;
  return pregStage(P, i) > 0;
}

export function exception(P, i, s) {
  const A = P.a;
  let m = 1;
  for (let k = 0; k < SCAR_SLOTS; k++) {
    const p = A.scarPart[k][i];
    if (!p) continue;
    const w = A.scarW[k][i];
    // 欠損は、生えたときに抽選した部位の例外倍率を w=3 で当てる
    const q = p === PART_LOST ? A.scarLostPart[k][i] : p;
    if (!q || !SCAR_EXC[q]) continue;
    const ww = p === PART_LOST ? 3 : w;
    if (SCAR_EXC_IDS[q].includes(s)) m *= 1 - SCAR_EXC[q] * ww / 3;
  }
  if (A.stunt[i]) {
    const w = A.stunt[i];
    if (STUNT_EXC_IDS.includes(s)) m *= 1 - 0.13 * w;
    if (s === ID_STRENGTH) m *= 1 - 0.10 * w;
  }
  if (A.defectType[i] === DEFECT_BODY && A.defectPart[i] === s) m *= 1 - 0.20 * A.defectW[i];
  if (A.defectType[i] === DEFECT_HIDDEN && s === ID.繁殖力) m *= 1 - 0.25 * A.defectW[i];
  const pw = pregStage(P, i);
  if (pw && PREG_EXC_IDS.includes(s)) m *= PREG_EXC[pw - 1];
  return m;
}

/** 治癒月数 = ceil((1 + 2w) × (1 − 傷の治りの素値/200))。傷の治り100 で半分 */
/**
 * 病が治るまでの月数。★★ B-26：正典は病の段（1軽/2重/3疫病）と緩和の倍率は書くが、
 *   **治るまでの月数をどこにも書いていない。**負傷は healMonths が 傷の治り で持っている。
 *   → 数字を発明せず、**負傷と同じ形をそのまま使い、効く能力だけ 病への強さ に替える**。
 *     疫病（段3）・病への強さ42 なら (1+2×3)×(1−42/200) ＝ 5.5 → 6ヶ月。
 *   ★ これが無いと、疫病にかかった者は**一生 からだ×0.52 のまま**になる（治る道が無い）。
 */
export function sickMonths(P, i, stage) {
  const r = bandNorm(ID.病への強さ, P.a.gene[ID.病への強さ][i] + P.a.ev[ID.病への強さ][i]) * 100;   // ★ 帯へ
  return Math.max(1, Math.ceil((1 + 2 * stage) * (1 - r / 200)));
}

export function healMonths(P, i, w) {
  const r = bandNorm(ID.傷の治り, P.a.gene[ID.傷の治り][i] + P.a.ev[ID.傷の治り][i]) * 100;   // ★ 帯へ
  return Math.max(1, Math.ceil((1 + 2 * w) * (1 - r / 200)));
}

/**
 * 古傷を1本足す。最大4本。
 * 5本目は同部位があれば w を max で統合、無ければ最小 w の本を捨てる。
 */
export function addScar(P, i, part, w, lostPart = 0) {
  const A = P.a;
  let empty = -1, same = -1, weakest = 0;
  for (let k = 0; k < SCAR_SLOTS; k++) {
    const p = A.scarPart[k][i];
    if (!p) { if (empty < 0) empty = k; continue; }
    if (p === part && same < 0) same = k;
    if (A.scarW[k][i] < A.scarW[weakest][i]) weakest = k;
  }
  if (same >= 0) {
    if (w > A.scarW[same][i]) A.scarW[same][i] = w;
    return same;
  }
  const k = empty >= 0 ? empty : weakest;
  if (empty < 0 && A.scarW[weakest][i] >= w) return -1;   // 弱い本しか無いなら捨てない
  A.scarPart[k][i] = part; A.scarW[k][i] = w; A.scarLostPart[k][i] = lostPart;
  return k;
}

// ---------------------------------------------------------------------------
// 供給源。ここが無いと器は空回りする
// ---------------------------------------------------------------------------

/**
 * 先天障害を出生時に1回だけ抽選する（永続3）。ストリームは 出生（#17 §10-3 の1番）。
 * ★ 既存の遺伝的荷重パイプラインをそのまま使う。荷重の死亡率補正 LOAD_MORTALITY とは
 *   二重ではない（荷重＝死にやすさ／先天障害＝できなさ）。
 * ★ 掟：分岐で呼び出し回数を変えない。当たらなくても同じ回数だけ引く
 */
export function rollDefect(P, i, rng) {
  const A = P.a;
  const hit = rng.next() < defectRate(A.vitality[i]);
  const rt = rng.next();      // 型
  const rw = rng.next();      // 重さ
  const rp = rng.next();      // 「体」のときの部位
  if (!hit) return 0;
  let t = DEFECT_BODY, acc = 0;
  for (let k = 0; k < DEFECT_SHARE.length; k++) {
    acc += DEFECT_SHARE[k];
    if (rt < acc) { t = k + 1; break; }
  }
  let w = 1; acc = 0;
  for (let k = 0; k < DEFECT_W_SHARE.length; k++) {
    acc += DEFECT_W_SHARE[k];
    if (rw < acc) { w = k + 1; break; }
  }
  A.defectType[i] = t; A.defectW[i] = w;
  if (t === DEFECT_BODY) {
    // 部位を1つ抽選 ×(1 − 0.20w)。からだのステから引く
    const body = S.BY_CATEGORY[S.BODY];
    A.defectPart[i] = body[Math.min(body.length - 1, (rp * body.length) | 0)];
  }
  return t;
}

/**
 * 疲労点（一時9）。働いた月に溜まり、毎月抜ける。
 * 中央値（抜けやすさ34・必要睡眠48）の抜けは 2.656/月 で、**負荷1.0 が均衡点**（張り付かない）。
 * 帯の下端（抜けやすさ15・必要睡眠66）は負荷1.0 でも +0.91/月 ＝ **壊れるのは眠りの浅い者だけ。**
 */
export function fatigueMonth(P, i, load) {
  const A = P.a;
  const raw = (s) => bandNorm(s, A.gene[s][i] + A.ev[s][i]) * 100;   // ★ 帯へ（上と同じ理由）
  let pt = A.fatigue[i] + FATIGUE_GAIN * load;
  pt -= FATIGUE_DRAIN
      * (0.5 + raw(ID.疲労の抜けやすさ) / 100)
      * (0.5 + (100 - raw(ID.必要睡眠)) / 100);
  A.fatigue[i] = pt < 0 ? 0 : pt > FATIGUE_MAX ? FATIGUE_MAX : pt;
}

/** 喪に1本足す（一時12）。τ はその者の情と教義の死の受容から出る */
export function addGrief(P, i, kinship, acceptance = 0) {
  const A = P.a;
  const mercy = A.gene[ID.情][i] + A.ev[ID.情][i];
  A.griefTau[i] = griefTau(mercy, acceptance);
  const g = A.grief[i] + kinship;
  A.grief[i] = g > 1 ? 1 : g;                 // 複数の喪は合算し 1.0 で頭打ち
  A.state[i] |= ST_GRIEF;
}

/** 喪の減衰。s = Σ k×exp(−経過月/τ) を、毎月 exp(−1/τ) を掛ける形で持つ（同じ式） */
export function griefDecay(P, i) {
  const A = P.a;
  if (!(A.state[i] & ST_GRIEF)) return;
  const tau = A.griefTau[i] > 0 ? A.griefTau[i] : 6;
  const g = A.grief[i] * Math.exp(-1 / tau);
  if (g < GRIEF_DROP) { A.grief[i] = 0; A.state[i] &= ~ST_GRIEF; }
  else A.grief[i] = g;
}

/**
 * 発育不全（永続5）。16歳までに 欠乏 段2以上の累計月数 M が
 *   6 ≤ M < 18 → w=1 ／ 18 ≤ M → w=2
 * ★ 16歳を過ぎたら二度と評価しない（永続なので確定させる）
 */
export function stuntMonth(P, i, ageYears, lackStage) {
  const A = P.a;
  if (ageYears > STUNT_AGE) return;
  if (lackStage >= 2 && A.lackMonths[i] < 65535) A.lackMonths[i]++;
  const m = A.lackMonths[i];
  A.stunt[i] = m >= STUNT_M2 ? 2 : m >= STUNT_M1 ? 1 : 0;
}

/** 欠乏の段（0=なし／1軽=連続1〜2ヶ月／2中=3〜5／3重=6〜） */
export function lackStage(P, i) {
  const A = P.a;
  if (!(A.state[i] & ST_HUNGRY)) return 0;
  const m = A.hungerMonths[i];
  return m >= 6 ? 3 : m >= 3 ? 2 : 1;
}

/**
 * 負傷の治癒（一時8 → 永続2 の変換）。治り切ったら確率で古傷が残る。
 *   段3、または手当ての担い手がいない村で治癒 → 古傷（同部位・w=段−1、最低1）確率 0.60
 * ★ 掟：当たらなくても同じ回数だけ引く
 */
export const HURT_TO_SCAR = 0.60, SICK_TO_SCAR = 0.20, HARD_BIRTH_TO_SCAR = 0.25;
export function healMonth(P, i, rng) {
  const A = P.a;
  if (!A.hurtStage[i]) return 0;
  if (A.hurtHeal[i] > 0) A.hurtHeal[i]--;
  if (A.hurtHeal[i] > 0) return 0;
  const w = A.hurtStage[i], part = A.hurtPart[i] || PART_ARM;
  const r = rng.next();
  A.hurtStage[i] = 0; A.hurtPart[i] = 0;
  if (w >= 3 && r < HURT_TO_SCAR) { addScar(P, i, part, Math.max(1, w - 1)); return 1; }
  return 0;
}

/**
 * 状態の月次。生きている全員を1度なめる（#15「逆引きテーブルを持たない」の掟どおり全走査）。
 * @param loadOf (i) → 疲労の負荷。0非番／1.0平時／1.3収穫期・普請／1.5従軍／1.8突貫。
 *               ★ どの職がどの負荷かは村と暦が知っていることなので、呼ぶ側が決める
 *                  （condition.js が village.js を読むと循環する）
 * @param rng    負傷が古傷に変わるときだけ引く。ストリームは 厄災（6番）
 */
export function conditionMonth(P, tick, loadOf, rng) {
  const A = P.a;
  let scarred = 0, stunted = 0, healed = 0;
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    const y = (A.ageMonths[i] / 12) | 0;
    // 病臥は非番と同じ（負荷0）
    // 病の治癒（B-26）。★ 乱数を引かない。段が下がるのではなく、治ったら消える
    if (A.sickStage[i] > 0) {
      if (A.sickHeal[i] > 0) A.sickHeal[i]--;
      if (A.sickHeal[i] <= 0) { A.sickStage[i] = 0; healed++; }
    }
    fatigueMonth(P, i, A.sickStage[i] >= 2 ? LOAD_IDLE : loadOf(i));
    const before = A.stunt[i];
    stuntMonth(P, i, y, lackStage(P, i));
    if (A.stunt[i] > before) stunted++;
    griefDecay(P, i);
    scarred += healMonth(P, i, rng);
  }
  return { scarred, stunted, healed };
}

/**
 * 喪（一時12）。その月に死んだ者の近親に s を積む。
 * ★ 逆引きテーブルを作らない（#15）。死んだ側から辿れる線（親・伴侶）は死者を1周、
 *   下向きの線（子・きょうだい・孫）は生者を1周して、上へ辿って拾う。O(死者)+O(生者)。
 */
export function mourn(P, dead) {
  if (!dead.length) return 0;
  const A = P.a;
  const gone = new Set(dead);
  const lostChild = new Set();        // 子を亡くした親（＝きょうだいの判定にも使う）
  let n = 0;
  const grieve = (i, k) => {
    if (i < 0 || i >= A.len || !A.alive[i] || gone.has(i)) return;
    addGrief(P, i, k); n++;
  };
  for (const d of dead) {
    grieve(A.spouse[d], GRIEF_KIN.伴侶);
    grieve(A.mother[d], GRIEF_KIN.子);
    grieve(A.father[d], GRIEF_KIN.子);
    if (A.mother[d] >= 0) lostChild.add(A.mother[d]);
  }
  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i] || gone.has(i)) continue;
    const m = A.mother[i], f = A.father[i];
    if (gone.has(m) || gone.has(f)) { addGrief(P, i, GRIEF_KIN.親); n++; continue; }
    if (m >= 0 && lostChild.has(m)) { addGrief(P, i, GRIEF_KIN.きょうだい); n++; continue; }
    // 孫。祖父母を亡くした
    const gp = [m >= 0 ? A.mother[m] : -1, m >= 0 ? A.father[m] : -1,
                f >= 0 ? A.mother[f] : -1, f >= 0 ? A.father[f] : -1];
    for (const g of gp) if (g >= 0 && gone.has(g)) { addGrief(P, i, GRIEF_KIN.孫); n++; break; }
  }
  return n;
}

/**
 * 難産のあと（一時11 → 永続 の変換）。ストリームは 出生（1番）。
 * ★ 掟：当たらなくても同じ回数だけ引く
 */
export function afterHardBirth(P, mother, rng) {
  const A = P.a;
  const ease = A.gene[ID.お産の軽さ][mother] + A.ev[ID.お産の軽さ][mother];
  const hard = ease < HARD_BIRTH_EASE;
  const rFail = rng.next(), rScar = rng.next();
  A.hardBirth[mother] = hard ? 1 : 0;
  if (!hard) return 0;
  let out = 0;
  // ★ そのお産が流れる。母は繁殖不能にならない（B-13 裁定）。次はまた産める
  if (rFail < HARD_BIRTH_FAIL) out |= 1;
  if (rScar < HARD_BIRTH_TO_SCAR) { addScar(P, mother, PART_LOST, 1, PART_ARM); out |= 2; }
  return out;
}

// ---------------------------------------------------------------------------
// 国民力①（正典4-4 ＋ #13 の直し2）
// ---------------------------------------------------------------------------
//
// ★ **からだ50 ＋ あたま25 の実効値だけ。こころ31は、ひとつも含めない**（正典4-4・2箇所）。
//   理由は正典が3つ挙げている：
//     ① 「能力は見えるが忠誠は見えない」という背骨と一致する
//     ② **入れると地雷が死ぬ。**腕っぷし98・忠誠0の男が減点されて見抜けてしまう
//     ③ 検索画面の既定の並び順が罠になる
//
// ★ **単純合計や単純平均で取らない。上位5本の平均で取る**（#13 の直し2）。
//   対抗アーム予算（同じ染色体の平均A＋平均B＝100）が**和を定数に固定する**ので、
//   単純平均だと「①が年齢計」になり、正典3-14 の理由3 が一度も発火しない。
//   順序統計量（上位5本）だけが、腕予算を壊さずに集約列を機能させる唯一の道。
//
// ★ 永続5個だけを掛ける（一時の不調で国の強さが毎月ぶれない）。捕虜もこれ。
//
// ★★ 残っている裁定：**この値は 0〜100 に収まらない。**
//   実測の中央は 231.7（上位5本）。正典4-4 の合計式 `0.55×① + 0.15×② + 0.20×③ + 0.10×④`
//   は ①〜④ がすべて 0〜100 である前提で書かれている。
//   #13 が測った「上位5本＝58.4」は **努力値を50倍にした改訂（O-34・2026-08-26）より前**の値で、
//   いまは努力値が主役なので実効値が約5倍ある。
//   **正規化の仕方は、国民力②③④ を作る日に決める**（それまで嫉妬は順位しか読まないので影響なし）。
export const CIVIC_BODY_W = 50, CIVIC_MIND_W = 25;
export const CIVIC_TOP = 5;

const _civ = [0, 0, 0];
const _top = new Float64Array(64);
function top5(P, i, cat, m, exc) {
  const A = P.a, list = S.BY_CATEGORY[cat];
  // ★ 例外の元が1つも無い者は `exception` を1回も呼ばない（大半がこちら）
  if (!exc) {
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      _top[k] = (A.gene[s][i] + A.ev[s][i]) * m;
    }
  } else {
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      _top[k] = (A.gene[s][i] + A.ev[s][i]) * m * exception(P, i, s);
    }
  }
  // 上位5本だけ要るので、全部は並べない
  let sum = 0;
  for (let n = 0; n < CIVIC_TOP; n++) {
    let best = n;
    for (let k = n + 1; k < list.length; k++) if (_top[k] > _top[best]) best = k;
    const t = _top[n]; _top[n] = _top[best]; _top[best] = t;
    sum += _top[n];
  }
  return sum / CIVIC_TOP;
}

/** 国民力① ＝ ( 50×上位5本(からだ) + 25×上位5本(あたま) ) / 75 */
export function civicTotal(P, i) {
  frames(P, i, _civ, true);
  const exc = hasException(P, i);            // ★ 1人につき1回だけ見る
  return (CIVIC_BODY_W * top5(P, i, S.BODY, _civ[S.BODY], exc)
        + CIVIC_MIND_W * top5(P, i, S.MIND, _civ[S.MIND], exc)) / (CIVIC_BODY_W + CIVIC_MIND_W);
}
