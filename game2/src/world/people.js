// 個体。列ごとの型付き配列（SoA）ひとつに、生きている者も死んだ者も全部入っている。
//
// 確定事項より：
//   A-2  列ごとの型付き配列。オブジェクトの配列にしない
//   A-3  先天と後天は別の種類ではない。同じ「腕っぷし」という1つの量
//   A-4  実効値 ＝（才能 ＋ 努力値）× M[枠] × Π(例外倍率)
//        才能0〜100・一生変わらない／努力値は上限なし
//   A-4  デバフは既存のステを直接下げない。倍率を掛ける（素の値が汚れない）
//   A-6  ピークは26歳固定。寿命40〜70・平均55。老衰のみ
//   B-2  ★ 決着した。旧「デバフ倍率の下限0.25」は**廃止**（正典 第7部 §1）。
//        永続に床は無く、一時7個にだけ枠別のソフト床 f が掛かる。
//        倍率の計算はぜんぶ world/condition.js（状態12個の倍率表）
//   A-20 性別はステータスではなく属性。別管理。完全ランダムで1/2
//
// 掟：添字は詰めない。死んだら alive[i]=0 にするだけ。
//     詰めるとしがらみ（辺のリスト）の from/to が全部ずれる。

import * as S from '../core/stats.js';
import * as C from '../core/calendar.js';
import { make } from '../core/arrays.js';
import { ST_PREGNANT, ST_HUNGRY, ST_SICK, ST_GRIEF, ST_NURSING, ST_BARREN } from '../core/states.js';
import { frames, exception } from './condition.js';
import { bandNorm, bandDev } from '../core/bands.js';   // レア度の帯（正典2-4）
import { LOOK_SPEC, FOUNDER_COUNT } from './looks.js';
import { lifespanOverride, deathless } from './gifts.js';

// ---- 属性の番号 -----------------------------------------------------------
export const SEX_MALE = 0, SEX_FEMALE = 1;
export const SEX_NAMES = ['男', '女'];

// ---- 身分の段（正典 #10-A。★2026-08-26 に農奴ぶん1段足して 0〜7 になった） -----
//
// ★ 正典の中で 0〜7 と 0〜6 が8箇所に割れていた。0〜7 が正しい（B-17 の裁定）。
//   根拠：#10-A の表7行すべてと `P = max(0, rank − 2)` が 0〜7 で整合し、
//   #10-A 自身が「P の値は1つも動いていない。rank を1つずらして分母を合わせただけ」と書いている。
//
// ★ 旧 RANK_POOR/COMMON/RICH/NOBLE（0〜3）は破棄（#10-H が明記）。
//   「貧民・富裕・貴族」は新しい体系に対応物が無い。富は rank ではなく commonTier（平民の段）へ。
export const RANK_SERF = 0, RANK_COMMON = 1, RANK_KNIGHT = 2, RANK_BARON = 3,
             RANK_VISCOUNT = 4, RANK_EARL = 5, RANK_MARQUIS = 6, RANK_DUKE = 7;
export const RANK_COUNT = 8;
export const RANK_NAMES = ['農奴', '平民', '騎士', '男爵', '子爵', '伯爵', '侯爵', '公爵'];

/** 爵位の段 P（0..5）。★ 平民も騎士も P=0（騎士は土地を治めないから。正典 #6-B） */
export const titleStep = (rank) => (rank < RANK_BARON ? 0 : rank - 2);

// 就き始める年齢。★ この8つの数は正典に無い（正典は「各家庭と身分に任せる」としか書かない）。
//   旧 [7,10,10,7]（貧民7・平民10・富裕10・貴族7）の意図
//   ＝「貧しい子は早く働き、貴族の子も早くから仕込まれる」をそのまま8段へ広げた。
//   ★ 4要素のままだと rank 4以上で undefined になり、比較が全部 false になって
//     貴族が生後0ヶ月から働き始める（6箇所が黙って壊れる）
export const WORK_START_AGE = [7, 10, 7, 7, 7, 7, 7, 7];

// ---- 役職の段 Q（正典 #10-D。身分とは別軸。世襲しない） ---------------------
export const POST_NONE = 0, POST_HEADMAN = 1, POST_MAYOR = 2, POST_CHIEF = 3;

// ---- 中核10局（正典 4-1 の表そのまま）--------------------------------------
// ★ 局は**街が生えるたびに1つ**生える（正典 8-3）。上限10。
//   人口900 → 村9 → 街1 → 局1 ／ 人口9,000 → 街10 → 局10（打ち止め）
// ★ 順番：フェーズ2→3 の印が「**農業局長・教育局長・法務局長が座った日**」（正典3821）
//   なのでこの3つが先頭。残りは正典4-1 の表の並び。
export const BUREAUS = ['農業局', '教育局', '法務局', '軍務局', '技術部',
                        '商会', '刑務局', '民生局', '祭祀局', '諜報'];
export const BUREAU_MAX = 10;
export const TOWN_VILLAGES = 9;      // 村9つで街1つ（#10-D・公爵の条件）
export const POST_NAMES = ['無役', '村長', '街長', '局長'];
export const HEADMAN_HOUSES = 10;      // 村長の席は「10軒目が建った日」に生える

// ---- 等級 g（正典 #10-C。階級章の横線＝銅銀金） -----------------------------
export const GRADE_MIN = 1, GRADE_MAX = 3;
export const GRADE_YEARS = [0, 8, 16];      // g1→2 は在任8年、g2→3 は16年
export const GRADE_REP = [0, 30, 55];       // ＋ 評判がこの値以上

// 未所属を表す値。Uint32/Uint16 なので -1 が置けない
export const NO_HOUSE = 0xFFFFFFFF;
export const NO_VILLAGE = 0xFFFF;
export const NO_ONE = -1;

// 状態異常（A-3 の「状態」。1ヶ月単位で計算する）。u32 のビット
// 状態のビットは core/states.js にある（循環参照を避けるため）。ここからも出しておく
export { ST_PREGNANT, ST_HUNGRY, ST_SICK, ST_GRIEF, ST_NURSING, ST_BARREN } from '../core/states.js';
export const STATE_NAMES = [
  [ST_PREGNANT, '妊娠'], [ST_HUNGRY, '飢え'], [ST_SICK, '病'],
  [ST_GRIEF, '喪'], [ST_NURSING, '産後'], [ST_BARREN, '繁殖不能'],
];

// ---- 死因（正典 #9-D。13値で確定。以後1つも足さない） ---------------------
//
// 空き番も残さない（残すと必ず埋めたくなる）。
// 旧版は #15 が9値・#9-D が8値・実装が6値の3版に割れていた。しかもこれが
// **族＝宗教の起源の入力**なので、確定しないと宗教が実装ごとに別物になっていた。
//
// ★ いま到達するのは 1老衰・2病・4餓死・5難産・7乳幼児 の5つだけ。
//   3事故 は厄災（ストリーム6）、8戦死 は戦争、9〜12 は刑罰・私闘・内乱・自殺が
//   入った日に生きる。**番号は今日確定させ、後から動かさない。**
export const DEATH_NONE     = 0;   // なし
export const DEATH_AGE      = 1;   // 老衰
export const DEATH_ILL      = 2;   // 病（疫病＝病の段3を含む）
export const DEATH_ACCIDENT = 3;   // 事故（倒壊・溺死・凍死・獣害・嵐）
export const DEATH_HUNGER   = 4;   // 餓死
export const DEATH_BIRTH    = 5;   // 難産（母）
export const DEATH_CHILDBED = 6;   // 産褥（産後1〜2ヶ月の母）
export const DEATH_INFANT   = 7;   // 乳幼児（5歳未満・原因を特定しない）
export const DEATH_WAR      = 8;   // 戦死
export const DEATH_EXECUTED = 9;   // 処刑（粛清・異端・冤罪）
export const DEATH_FEUD     = 10;  // 私闘・暗殺
export const DEATH_REVOLT   = 11;  // 内乱（暴動・謀反・家督争い）
export const DEATH_SELF     = 12;  // 自殺（集団自殺を含む）
export const DEATH_COUNT    = 13;

export const DEATH_NAMES = [
  '—', '老衰', '病', '事故', '飢え', 'お産', '産褥',
  '乳幼児', '戦死', '処刑', '私闘', '内乱', '自殺',
];

// 乳幼児と数えるのは何歳未満か（#9-D）
export const INFANT_AGE = 5;

// ---- 族（#9-D。その月・その村で最多だった死因から引く。宗教の起源になる） ---
// 「数えない」死因（老衰・難産・産褥・乳幼児）は族を持たない。
// 同数で並んだら族番号の小さいほうを採る（決定性のため）。
// ★ 番号の並びは 正典 9-C（6713-6718）と #6-C（5868）が2箇所とも
//   **疫 → 飢 → 天 → 兵 → 罰 → 内** で一致している。
//   9-D は「同数で並んだら**族番号の小さいほうを採る**」ので、並びが逆だと
//   餓死2・事故2 の村で別の宗教が起きる（起源補正が 蓄財−20/慰霊+10 と
//   信仰性+15/儀礼+15 で別物になる）。★2026-08-29 に 天↔飢 を正典の順へ直した
export const KIN_NONE = 0, KIN_PLAGUE = 1, KIN_FAMINE = 2, KIN_HEAVEN = 3,
             KIN_WAR = 4, KIN_PUNISH = 5, KIN_STRIFE = 6;
export const KIN_NAMES = ['—', '疫', '飢', '天', '兵', '罰', '内'];

// ---- 宗派の段（#8 §3）------------------------------------------------------
// ★ 無信仰は在る。ID=0。理由は4つ、どれも構造上のもの（#8 §2）：
//   ①宗教は「起きる」ものなので起きる前の状態が要る
//   ②異端審問会の獲物が絶えない床になる（無信仰の d は30固定で常に網に入る）
//   ③棄教の行き先が要る
//   ④無信仰者は帰属の付け替えを受けないので**③が生で溜まる**
export const SECT_NONE = 0;
export const MODE_LAY = 0, MODE_ZEALOT = 1, MODE_RESIGNED = 2;
export const STEP_NONE = 0, STEP_NOMINAL = 1, STEP_BELIEVER = 2, STEP_DEVOUT = 3;
export const STEP_NAMES = ['無信仰', '名ばかり', '信徒', '篤信'];
/** faith から段を出す（#8 §3 の表） */
export const faithStep = (sect, faith) =>
  sect === SECT_NONE ? STEP_NONE : faith >= 70 ? STEP_DEVOUT : faith >= 35 ? STEP_BELIEVER : STEP_NOMINAL;
// 段ごとの倍率（帰属の付け替え／慰霊）。★ 無信仰は両方 ×0
export const STEP_DIVERT = [0, 0.3, 1.0, 1.4];
export const STEP_MOURN  = [0, 0.5, 1.0, 1.3];
export const DIVERT_CAP = 0.60;        // 正典3-16c「4割は必ず統治に残る」は絶対
export const NOFAITH_D = 30;           // 無信仰のズレ d は30固定（#7 で常に最優先の候補）
// ★ 6『内』は永久に origin になれない（#6-C 5870・9-C 6718）。
//   宗教の結果として起きた集団自殺から新しい宗教が起きる、という循環を潰すため
export const KIN_CAN_ORIGIN = (kin) => kin >= KIN_PLAGUE && kin <= KIN_PUNISH;

/** 死因 → 族。添字が死因番号 */
export const DEATH_KIN = [
  KIN_NONE,    // 0 なし
  KIN_NONE,    // 1 老衰      → 数えない
  KIN_PLAGUE,  // 2 病        → 疫
  KIN_HEAVEN,  // 3 事故      → 天
  KIN_FAMINE,  // 4 餓死      → 飢
  KIN_NONE,    // 5 難産      → 数えない
  KIN_NONE,    // 6 産褥      → 数えない
  KIN_NONE,    // 7 乳幼児    → 数えない
  KIN_WAR,     // 8 戦死      → 兵
  KIN_PUNISH,  // 9 処刑      → 罰
  KIN_PUNISH,  // 10 私闘・暗殺 → 罰（下手人が名指しできる死だから）
  KIN_STRIFE,  // 11 内乱     → 内
  KIN_STRIFE,  // 12 自殺     → 内
];

// ---- 死亡率（中世並・年あたり） -------------------------------------------
// 確定事項の表そのまま。老衰（寿命）はこれとは別に効く。
export const MORTALITY = [
  { from: 0,  to: 0,   rate: 0.20  },
  { from: 1,  to: 4,   rate: 0.06  },
  { from: 5,  to: 14,  rate: 0.012 },
  { from: 15, to: 39,  rate: 0.010 },
  { from: 40, to: 54,  rate: 0.020 },
  { from: 55, to: 999, rate: 0.050 },
];

/** その歳の年あたり死亡率 */
export function annualDeathRate(ageYears) {
  for (const m of MORTALITY) if (ageYears >= m.from && ageYears <= m.to) return m.rate;
  return 0.05;
}
/** 月あたりに直す。年率 p を12回に分けて同じになるように */
export function monthlyDeathRate(ageYears) {
  return 1 - Math.pow(1 - annualDeathRate(ageYears), 1 / 12);
}

// ---- 老いとデバフは condition.js へ移した -----------------------------------
//
// 旧 `ageCurve()` は永続1「老い」に、`HUNGRY_MUL/SICK_MUL/PREGNANT_BODY_MUL` は
// 一時7個の表の該当マスに座っている（**3つとも1つも捨てていない**）。
// `DEBUFF_FLOOR = 0.25` は廃止（B-2 の決着。永続に床は無い）。
// A-6 の年齢曲線の検算7点は condition.js の `aging()` がそのまま満たす。
export { aging, frames, exception, PEAK_AGE, AGE_FALL, AGE_POW, RISE_POW } from './condition.js';

// 遺伝的荷重が死亡率をどれだけ押し上げるか。生存力0.8で死亡率1.12倍
export const LOAD_MORTALITY = 0.6;

// ---- 個体の束 -------------------------------------------------------------

// 1人ぶんの列。gene と ev は 104 本ずつ、対立遺伝子は2組。
export const SPEC = {
  // 才能（0〜100・一生変わらない）と努力値（上限なし）
  gene: `f32*${S.COUNT}`,
  ev:   `f32*${S.COUNT}`,

  // 対立遺伝子2本。u16 に ALLELE_Q 倍で入れている（0〜100 を 1/600 刻みで）
  a0: `u16*${S.COUNT}`,
  a1: `u16*${S.COUNT}`,
  // 優劣（こころのぶん）のビット。0=劣性 1=顕性
  // ★ 29 と書かない。N-22（106化）で こころ が29→31 に増えたときに黙ってずれる
  dom0: 'u32', dom1: 'u32',
  // 遺伝的荷重（こころの劣性が隠して運ぶ欠陥）。0〜255 で 0〜1
  ld0: `u8*${S.BY_CATEGORY[S.HEART].length}`, ld1: `u8*${S.BY_CATEGORY[S.HEART].length}`,
  // 可塑（交叉率を決めるメタ遺伝子。ステータスではないので104に入っていない）
  pl0: 'f32', pl1: 'f32', plast: 'f32',

  ageMonths: 'u16',      // 月齢。70年=840ヶ月なので u16 で足りる
  sex: 'u8',
  house: 'u32',
  village: 'u16',
  rank: 'u8',
  job: 'u8',             // どのエリアで働いているか（village.js の AREA）
  wealth: 'f32',
  state: 'u32',
  alive: 'u8',
  lifespan: 'u8',        // 40〜70。寿命ステから決まる

  vitality: 'f32',       // 遺伝的荷重から出る生存力（産む・生きる・老いる に掛かる）

  // ---- 状態12個の器（正典 第7部 §1。倍率の計算は world/condition.js） ----
  // 旧 `scar: f32`（からだ一律のデバフ1つ）はここに置き換わった。
  // 古傷は**部位と重さを持つ本が最大4本**で、部位ごとに例外倍率の当たり先が違う
  scarPart: `u8*${4}`,   // 0=空き／1腕 2脚 3眼 4耳 5欠損
  scarW:    `u8*${4}`,   // 1〜3
  scarLostPart: `u8*${4}`, // 欠損のとき、抽選で当たった部位（例外倍率をw=3で当てる先）
  defectType: 'u8',      // 先天障害 0=なし／1体 2頭 3心 4隠れ
  defectW: 'u8',         // 1〜3
  defectPart: 'u8',      // 「体」のとき例外倍率が当たるステ番号（+1。0=なし）
  stunt: 'u8',           // 発育不全 0/1軽/2重
  lackMonths: 'u16',     // 16歳までの「欠乏 段2以上」の累計月数（発育不全の入口）
  sickStage: 'u8',       // 病 0/1軽/2重/3疫病
  hurtStage: 'u8',       // 負傷 0/1軽/2中/3重
  hurtHeal: 'u8',        // 負傷の残り治癒月数
  sickHeal: 'u8',        // 病の残り治癒月数（#9 の疫病で初めて使う。B-26）

  // ---- 宗派（#8 §1。6バイト／人。10万人で 0.6MB）------------------------
  // ★ 教義のコピーを個人は持たない。教義は宗派側に1組だけ。
  //   個人は「どこに属し、どれだけ深いか」だけ。代替わりで教義が動いても書き換えは1件で済む
  // ★ 信心（13番B・性向）と faith は別物。信心は「信じやすい性質」、
  //   faith は「いまその宗派にどれだけ深く入っているか」。同じ信心の2人が違う faith を持つ
  sect: 'u16',           // 0 = 無信仰。1以上は宗派ID。★ 世界の初期状態は全員0
  // ★★ B-32：正典 #8 §1 は `faith u8`（6バイト／人）と書いているが、**u8 では表せない。**
  //   §4 の月次の変化は 流入×(1−f/100) − 流出×(f/100) で、実測の1ヶ月ぶんは **+0.10 前後**。
  //   u8 に入れると毎月まるごと切り捨てられ、faith は継承時の値（38）から**一生動かない**。
  //   実測：平衡は 53〜83 なのに 全員 31〜38 で凍結 → 段2（35以上）が村から消える
  //   → 誘い手がゼロ → 伝播が永久に止まる → 500年で宗派3件すべて消滅・信者0。
  //   `fatigue` が同じ理由で f32（「★ u8 では表せない」）なのと同じ話。1人あたり +3B。
  faith: 'f32',          // 信仰の深さ 0〜100
  mode: 'u8',            // 0 = 平信徒 / 1 = 狂信 / 2 = 諦観
  sectMon: 'u16',        // いまの sect に居る月数（改宗の連打を止めるためだけに使う）
  hurtPart: 'u8',        // 負傷の部位（古傷に変わるときの行き先）
  fatigue: 'f32',        // 疲労点 0〜12。★ u8 では表せない
                         //   （中央値の均衡が −0.056/月。u8 の刻み 1/16=0.0625 だと 0 に丸まって
                         //    「負荷1.0 で均衡」という設計そのものが消える）
  grief: 'f32',          // 喪の s。Σ k×exp(−経過月/τ)。毎月 exp(−1/τ) を掛けて減らす
  griefTau: 'f32',       // その者の τ（情と教義の死の受容から出る。喪に入った月に決める）
  hardBirth: 'u8',       // 直近の出産が難産だったか（産褥期のからだを0.72に置換する）

  // ---- 身分・爵位・役職（正典 #10-H） -------------------------------------
  // ★ rank は既存の列を意味づけし直した（0〜3 の旧4段 → 0〜7 の新8段）。
  //   全員が rank=1（平民）なので、意味づけを変えても値は1つも動かない
  grade: 'u8',           // 等級 g（1〜3。階級章の横線＝銅銀金）
  post: 'u8',            // 役職の段 Q（0無役 / 1村長 / 2街長 / 3局長）。世襲しない
  rankSince: 'i32',      // いまの rank に叙された tick（等級の在任年数の起点）
  commonTier: 'u8',      // 平民の段 1〜5（村内の財の五分位。★毎年引き直す。下がる）
  postVillage: 'u16',    // 治めている村（村長のとき）。★爵位は治める土地の大きさで決まる
  bureau: 'u8',          // 局長のとき、どの局か（1起点。0=局長でない）
  postSince: 'i32',      // その席に就いた tick（街長の席を回すときの順に要る）
  loyalty: 'f32',        // 忠誠 L（#14）。★下がる事由は「オーナーが上書きしたとき」だけ
  planSeed: 'u8',        // 立案の位相（同じ月に全員が立てないようにするだけ。乱数を引かない）
  tieN: 'u16',           // つながりの数（好き嫌い≥60 の人数）。月に1度だけ数え直す
  infl: 'f32',           // 影響力 I ＝（評判＋立場＋つながり点）/3。月に1度だけ引き直す

  // ---- 欲7つ（正典 #3。倍率と式は world/desire.js） ----------------------
  rep: 'f32',            // 評判 R ∈ [−100,+100]（#6-A）。年−1で0へ戻る。死んだら凍結
  repOnce: 'u8',         // 一生に1度の評判の出来事（子5人・60歳）のビット
  raised: 'u8',          // 5歳まで育てた子の数（評判 +5 の入口。逆引きを作らずO(1)で数える）

  // ---- 戦果（O-27）。★ 正典 7554-7555 が「O-27 が入るまで常に0」と名指しした2列 ----
  //   T7 戦に出た回数 ／ T8 敗走・脱走した回数（度胸の低さが見える）
  //   ★ kills は「目に見えてわかる戦果」。叙爵の功績はここから来る
  faction: 'u16',        // 派閥（正典3-3）。0＝どこにも属さない。★手で作らない。線の密な塊
  kills: 'u16',          // 討ち取った数（通算）
  battles: 'u8',         // 戦に出た回数（T7）
  routed: 'u8',          // 敗走・脱走した回数（T8）
  ref: 'f32*3',          // A群の参照点 R（強欲・暴食・嫉妬）。12歳到達時に30
  innate: 'u8',          // 内発フラグ。欲ごとに1ビット。13歳の誕生月に固定
  childAll: 'f32*2',     // 6〜12歳に積んだ供給の合計（傲慢・憤怒だけ判定する）
  childAct: 'f32*2',     // うち ACT（行為そのもの）由来
  childActMonths: 'u8*2',
  intake: 'u8*3',        // 直近3ヶ月の1人あたり実配給（0〜100）。暴食の供給
  civicSum: 'f32',       // 国民力の合計（月に1度だけ引き直す。嫉妬の順位に使う）
  desireOut: 'f32*7',    // 出力_k = g×(1−U)×ι。毎月引き直す導出値

  // ---- 不満6本と恨み6本（正典3-5 ＋ 第7部 §2 ＋ #4） --------------------
  // ★ 2列にする。日常は**不満**にしか入らない。恨みは事件からしか積まない
  dis: 'f32*6',          // 不満［①特定の人／②身近な集団／③統治／④自分／⑤神・世界／⑥外］
  grudge: 'f32*6',       // 恨み。同じ6本
  grudge1Who: 'u32*4',   // ① は相手つき。4枠。5人目は最も低い枠を②へ全額移して空ける
  grudge1Pt: 'f32*4',
  disOnce: 'u8',         // 一生に1度の④の出口（初就労）のビット

  birthTick: 'i32',
  deathTick: 'i32',
  deathCause: 'u8',
  mother: 'i32', father: 'i32', spouse: 'i32',

  pregDue: 'i32',        // 産む tick。妊娠していなければ -1
  pregFather: 'i32',
  pregCount: 'u8',       // 何人みごもっているか（双子・三つ子）
  lastBirth: 'i32',
  births: 'u8',          // これまでに産んだ数

  hungerMonths: 'u8',
  gen: 'u16',            // 何代目か（家族の単位。A-12）
  blood: 'u16',          // 創世の十匹のうち誰の血が入っているか。10ビットの旗。
                         // 子は 父の旗 | 母の旗。収束計「血統の生き残り数」がこれを数える

  // 授かりもの（S以上・A-23）。**104ステとは別枠の1座位。**
  // 0=野生型、1〜10=授かりもの。繁栄だけ顕性、残り9つは劣性ホモでのみ発現。
  // 同じ座位なので、1人が2つ発現することは構造上ありえない
  gift0: 'u8', gift1: 'u8',

  // 見た目（キャラビジュアル.md §2/§3）。**ステではない。**何にも効かない血統の指紋。
  // blood（旗）は「誰の血が入ったか」の有無しか言えないので、割合は別に持つ。
  ...LOOK_SPEC,
};

export const HEART0 = S.BY_CATEGORY[S.HEART][0];          // 104ステで75／106ステで75
export const HEART_COUNT = S.BY_CATEGORY[S.HEART].length; // 104ステで29／106ステで31
// 優劣は dom0/dom1 の u32 に1ビットずつ載せている。こころが32を超えたら黙って溢れる
if (HEART_COUNT > 32) throw new Error(`people.js: こころが${HEART_COUNT}個。dom0/dom1 の u32 に載らない`);
// こころは添字が連続していることを前提に k = s - HEART0 で引いている
if (S.BY_CATEGORY[S.HEART][HEART_COUNT - 1] !== HEART0 + HEART_COUNT - 1) {
  throw new Error('people.js: こころの添字が連続していない（stats_v3.csv の並び順）');
}
export const ALLELE_Q = 600;                             // u16 に詰める倍率

export class People {
  constructor(cap = 256) {
    this.a = make(cap, SPEC);
    this.count = 0;      // 生きている数
    this.born = 0;       // これまでに生まれた総数
    this.dead = 0;
    // ★ いまの tick。妊娠と産後の「段」を出すのに要る（world.js が毎 tick 入れる）。
    //   1人ずつではなく束に1つ持つ。0 のままでも落ちないよう初期値を置いておく
    this.tickNow = 0;
    // M[枠] の受け皿。毎月10万人ぶん呼ぶので、そのたびに配列を作らない
    this._M = [1, 1, 1];
  }

  get len() { return this.a.len; }

  // 列に直接触れるための入口（sim の内側は列を直に読むこと）
  get gene() { return this.a.gene; }
  get ev() { return this.a.ev; }
  get alive() { return this.a.alive; }
  get sex() { return this.a.sex; }
  get ageMonths() { return this.a.ageMonths; }
  get house() { return this.a.house; }
  get village() { return this.a.village; }
  get rank() { return this.a.rank; }
  get job() { return this.a.job; }
  get state() { return this.a.state; }
  get wealth() { return this.a.wealth; }
  get lifespan() { return this.a.lifespan; }
  get spouse() { return this.a.spouse; }
  get mother() { return this.a.mother; }
  get father() { return this.a.father; }
  get blood() { return this.a.blood; }

  /** 席を1つ取って、生きた個体として立てる。中身（遺伝子）はまだ空 */
  spawn(tick) {
    const i = this.a.alloc();
    this.a.clear(i);
    const A = this.a;
    A.alive[i] = 1;
    A.house[i] = NO_HOUSE;
    A.village[i] = NO_VILLAGE;
    A.mother[i] = NO_ONE; A.father[i] = NO_ONE; A.spouse[i] = NO_ONE;
    A.pregDue[i] = -1; A.pregFather[i] = NO_ONE; A.lastBirth[i] = -1;
    A.birthTick[i] = tick; A.deathTick[i] = -1;
    A.rank[i] = RANK_COMMON;
    A.vitality[i] = 1;
    A.lifespan[i] = 55;
    A.blood[i] = 0;
    for (let f = 0; f < FOUNDER_COUNT; f++) A.bloodMix[f][i] = 0;
    this.count++; this.born++;
    return i;
  }

  kill(i, tick, cause = DEATH_ILL) {
    if (!this.a.alive[i]) return false;
    const A = this.a;
    A.alive[i] = 0;
    A.deathTick[i] = tick;
    A.deathCause[i] = cause;
    A.state[i] = 0;
    A.pregDue[i] = -1;
    this.count--; this.dead++;
    return true;
  }

  // ---- 見るだけのもの ----------------------------------------------------
  ageYears(i) { return (this.a.ageMonths[i] / C.MONTHS_PER_YEAR) | 0; }
  isAlive(i) { return this.a.alive[i] === 1; }
  isAdult(i) { return this.a.ageMonths[i] >= 18 * C.MONTHS_PER_YEAR; }
  isWorking(i) { return this.ageYears(i) >= WORK_START_AGE[this.a.rank[i]]; }
  has(i, bit) { return (this.a.state[i] & bit) !== 0; }
  set(i, bit) { this.a.state[i] |= bit; }
  unset(i, bit) { this.a.state[i] &= ~bit; }

  /** 才能。生まれつき。一生変わらない */
  talent(i, s) { return this.a.gene[s][i]; }

  /**
   * デバフの倍率（A-4）。既存のステを直接下げず、これを掛ける。
   * 老い と 古傷 は からだ のみ（A-4 に明記）。
   */
  /**
   * ステ1本に掛かる倍率 ＝ M[枠(s)] × Π(例外倍率[s])（正典 第7部 §1）。
   * @param permOnly 真なら一時7個を見ない＝国民力①（括弧を外すだけ）
   */
  debuff(i, s, permOnly = false) {
    frames(this, i, this._M, permOnly);
    return this._M[S.CATEGORY[s]] * exception(this, i, s);
  }

  /** 国民力①。永続5個だけ（一時の不調で国の強さが毎月ぶれない）。捕虜もこれ */
  civic(i, s) {
    return (this.a.gene[s][i] + this.a.ev[s][i]) * this.debuff(i, s, true);
  }

  /** 実効値 ＝（才能 ＋ 努力値）× デバフ（A-4） */
  effective(i, s) {
    return (this.a.gene[s][i] + this.a.ev[s][i]) * this.debuff(i, s);
  }

  /** 何本かのステの実効値の重み付き平均。仕事の出来を出すときに使う */
  effectiveOf(i, list) {
    let sum = 0, w = 0;
    for (let k = 0; k < list.length; k++) {
      const s = list[k][0], ww = list[k][1];
      sum += this.effective(i, s) * ww; w += ww;
    }
    return w > 0 ? sum / w : 0;
  }

  // ---- 数える ------------------------------------------------------------
  aliveCount() { return this.count; }
  *living() { const A = this.a; for (let i = 0; i < A.len; i++) if (A.alive[i]) yield i; }

  bytesPerRow() { return this.a.bytesPerRow(); }
  bytes() { return this.a.bytes(); }
}

// ---- 寿命 -----------------------------------------------------------------
// 寿命はステの1つ（45番）なので、乱数ではなく遺伝から出す。
// 才能50（集団の中央）で55年になり、0で40年、100で70年。確定事項の「40〜70・平均55」と合う。
// 老いの速さ（46番・寿命の対）と 遺伝的荷重 で削る。
export const LIFESPAN_MIN = 40, LIFESPAN_MAX = 70;
const ID_LIFESPAN = S.needId('寿命');
const ID_AGING = S.needId('老いの速さ');

/**
 * 素の寿命。遺伝だけで決まる。**40〜70・平均55**（確定事項 A-6 そのまま）。
 * 才能50（集団の中央）で55年、0で40年、100で70年。老いの速さ（寿命の対）で ±5年。
 */
export function baseLifespanOf(P, i) {
  const A = P.a;
  // ★★ 錨を**帯**へ移した（2026-08-31・帯の実装にあわせて）★★
  //   寿命はレア度A（帯 1〜45・平均25.3）、老いの速さはレア度B（帯 15〜53・平均34）。
  //   旧式 `40 + 30×(才能/100)` は才能が0〜100の一様分布である前提だったので、
  //   帯を入れると平均寿命が 55 → **47.6** に落ち、確定事項A-6「40〜70歳・平均55」を割る。
  //   **帯の下端→40／中心→55／上端→70** に貼り直す。A の帯 1〜45 が 40〜70 に丸ごと乗る
  const base = LIFESPAN_MIN + (LIFESPAN_MAX - LIFESPAN_MIN) * bandNorm(ID_LIFESPAN, A.gene[ID_LIFESPAN][i]);
  const fast = bandDev(ID_AGING, A.gene[ID_AGING][i]) * 5;   // 老いの速さが高いほど短い
  const v = Math.round(base - fast);
  return v < LIFESPAN_MIN ? LIFESPAN_MIN : v > LIFESPAN_MAX ? LIFESPAN_MAX : v;
}

/**
 * 実際の寿命。素の寿命に、遺伝的荷重（＝閉じた血統に溜まる欠陥）が乗る。
 * 荷重が無ければ素のまま。近親が続いた家系は短くなる。
 */
export function lifespanOf(P, i) {
  // 長寿（S・A-23）は素の寿命も荷重も無視して70で確定する
  const gift = lifespanOverride(P, i);
  if (gift > 0) return gift;
  const base = baseLifespanOf(P, i);
  const v = Math.round(base * loadLifeMul(P.a.vitality[i]));
  // ★ 2026-08-31（別セッションの精査で発見）：**下限を 20 にしていたので、荷重の重い
  //   血統が 30 まで落ちて確定事項 A-6「寿命は 40〜70歳」を割っていた**（実測 最小30）。
  //   正典1310 の例も「血を固めた世代6は **40歳**で死ぬ」で、**40が床**。
  return v < LIFESPAN_MIN ? LIFESPAN_MIN : v > LIFESPAN_MAX ? LIFESPAN_MAX : v;
}

// ★★ 荷重が寿命に効く倍率。**母集団の中央で 1.00 になるよう錨を打つ**（2026-08-31・M-52）★★
//   旧：`0.75 + 0.25 × vitality` ── これは vitality = 1.0 でしか 1.00 にならない。
//   だが **生存力1.0（劣性ホモを1つも持たない）の者は1人もいない**（実測の中央 0.721）。
//   M-30 が「無関係な親でも劣性ホモは 12.4%」と測っているとおり、荷重は全員が持つ。
//   結果、**全員が無条件に寿命を7%削られ**、平均が 55 → **50.9** になっていた
//   ── 正典1504・確定事項 A-6「**寿命は40〜70歳、平均55**」への違反。
//   最高齢60歳・60歳以上0.2%・老衰死の最高65歳という壁もこれが作っていた。
//   ★ **Q_DIVISOR 373 とまったく同じ型のバグ**（母集団が到達しない基準値に対する校正）。
//
//   直し方：**錨を「生存力1.0」から「母集団の中央」へ移す。**両端の意味は変えない ──
//     生存力 0.72（並の血）      → 倍率 1.00 ＝ 素の寿命そのまま（平均55が戻る）
//     生存力 0.35（床・固めた血） → 倍率 0.75 ＝ 従来の最悪と同じ（寿命41前後）
//   ★ 正典1310「血を固めた世代6は40歳で死ぬ」は**旧・遺伝方式の実測で、正典自身が
//     「そのまま当たらない」と注記している**ので錨には使えない。使えるのは A-6 だけ。
export const VIT_BASE = 0.72;        // 実測 M-52。無関係な親から生まれた子の生存力の中央
export const LOAD_LIFE_MIN = 0.75;   // 生存力が床まで落ちた血統の倍率（＝旧実装の最悪と同値）
const VIT_FLOOR = 0.35;              // genetics.js の LOAD_FLOOR と同じ（循環 import を避けて写す）
export function loadLifeMul(vit) {
  const m = 1 - (VIT_BASE - vit) * ((1 - LOAD_LIFE_MIN) / (VIT_BASE - VIT_FLOOR));
  return m < LOAD_LIFE_MIN ? LOAD_LIFE_MIN : m > 1 ? 1 : m;
}

// ---- 1ヶ月ぶんの加齢と死 ---------------------------------------------------
/**
 * 歳を取り、死ぬ。月に1度だけ呼ぶ。
 * @returns {{aged:number, died:number, byCause:number[], dead:number[]}}
 */
export function agingAndDeath(P, tick, rng) {
  const A = P.a;
  const byCause = new Array(DEATH_COUNT).fill(0);
  const dead = [];             // ★ その月に死んだ者。喪（第7部 §1 一時12）の入力になる
  let aged = 0, died = 0;

  for (let i = 0; i < A.len; i++) {
    if (!A.alive[i]) continue;
    A.ageMonths[i]++;
    aged++;
    const y = (A.ageMonths[i] / C.MONTHS_PER_YEAR) | 0;

    // 老衰。寿命に届いた者から順に落ちる（ぴったり同じ日には死なせない）
    if (y >= A.lifespan[i]) {
      // 超えた年数ぶんだけ月ごとの確率が上がる。寿命+5年で必ず死ぬ
      const over = y - A.lifespan[i];
      const p = 1 - Math.pow(1 - Math.min(1, 0.20 + over * 0.15), 1 / 12);
      if (rng.next() < p) {
        P.kill(i, tick, DEATH_AGE); died++; byCause[DEATH_AGE]++; dead.push(i);
        continue;
      }
    }

    // 奇跡（G・A-23）。老衰以外では死なない。この先の病・飢え・お産・戦を全部素通りする
    if (deathless(P, i)) continue;

    // 中世並の死亡率（確定事項の表）。ここが素の値。
    // 生存力（遺伝的荷重）はその上に乗る。閉じた血統は劣性ホモが溜まって死にやすくなる
    // （genetics.js の geneticLoad を参照）。表そのものを壊さないよう効きは 0.6 に抑えてある
    let p = monthlyDeathRate(y);
    const vit = A.vitality[i];
    if (vit < 1) p *= 1 + (1 - vit) * LOAD_MORTALITY;
    if (A.state[i] & ST_SICK) p *= 2.5;
    if (rng.next() < p) {
      // 5歳未満は原因を特定しない（#9-D の 7 乳幼児）。族を持たないので宗教の起源にならない。
      // ★ 乱数は1回も余分に引かない。名札を貼り替えるだけ
      const cause = y < INFANT_AGE ? DEATH_INFANT : DEATH_ILL;
      P.kill(i, tick, cause); died++; byCause[cause]++; dead.push(i);
      continue;
    }

    // 飢え。3ヶ月続けて食べられなかったら落ち始める
    if (A.state[i] & ST_HUNGRY) {
      if (A.hungerMonths[i] < 255) A.hungerMonths[i]++;
      if (A.hungerMonths[i] >= 3) {
        const q = 0.10 + 0.08 * (A.hungerMonths[i] - 3);
        if (rng.next() < Math.min(0.6, q)) {
          P.kill(i, tick, DEATH_HUNGER); died++; byCause[DEATH_HUNGER]++; dead.push(i);
          continue;
        }
      }
    } else if (A.hungerMonths[i] > 0) {
      A.hungerMonths[i]--;
    }
  }
  return { aged, died, byCause, dead };
}
