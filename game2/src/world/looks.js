// 見た目。**ステではない。**機械的には何にも効かない、純粋な血統の指紋。
//
// キャラビジュアル.md より：
//   §2  色相は世界ローカル8枠。**色相を平均しない。血の割合を平均する**
//       描くのは上位2枠だけ。体＝1位／沈殿＝2位／沈殿の高さ＝2位の割合
//   §3  形＝角の数（0〜8・中間遺伝）／模様＝縦の線数×横の線数（各0〜5・中間遺伝）
//       星・ハート＝**潜性**。1本持つだけでは出ない。2本揃ったときだけ出る
//
// 掟：ここは104ステと混ぜない。`gene[]` に入れない。
//     「高いと悪い面」の掟の対象外（何にも効かないので）。

export const FOUNDER_COUNT = 10;      // 創世の十匹。血の枠もこの数

// ===========================================================================
// 種族（A-24・2026-08-21 オーナー指摘）
// ===========================================================================
// > **戦争して移民・捕虜入れない限り種族は全部同じだっての。**
//
// **創世の十匹は、開幕の診断で決まった1つの種族＝同じ民族。**
// よその血が入るのは**戦争の捕虜だけ**（開拓も移住も血を混ぜない・A-19b）。
//
// **血統 ≠ 種族。**`bloodMix` の10枠は「誰の子孫か」を数える指標で、これは残す
// （収束計の「血統の生き残り 10/10」がこれを読む）。**見た目は種族のほう。**
//
// 私の最初の実装は十匹に10色・6種類の形・9通りの模様を配っていた。
// **一つの民族が10色に分かれて立っていた。**しかも見た目5チャンネルが全部
// 「誰の子孫か」を言うので、**意味のある3つ（大きさ＝年齢／暗さ＝弱り／細胞＝熟練）が
// その中に埋もれていた。**
//
// 揃えると Phase 1 の盤面はほぼ単色になり、動くもの3つが読める。
// そして**戦争でよその血が入った瞬間、盤面が初めて色を持つ。**

/** この世界の種族。**いずれ開幕の診断（A-6-1）から決まる。**いまは固定 */
export const DEFAULT_RACE = {
  hue: 150,          // 種族の色
  corners: 6,        // 種族の形（六角）
  stripeV: 0,        // 種族の模様
  stripeH: 2,
};

/** 同じ種族の中の個体差。**狭い。**はっきり違う色と形は、よその血のために取っておく */
export const RACE_HUE_SPREAD = 8;      // 色相の幅（度）
const RACE_LOOK_SPREAD = 0.30;         // 形と模様のゆらぎ。丸めれば全員同じ値になる幅

/**
 * よその血と見なす色相の隔たり（度）。
 * **これより近い血は、同じ種族なので沈殿を描かない。**
 * 十匹は同じ帯にいるので、Phase 1 では誰にも沈殿が出ない——それが正しい。
 */
export const FOREIGN_MIN_DEGREES = 22;

/** 十匹の色相。**同じ種族なので狭い帯に収める**（旧実装は36度ずつ離した10色だった） */
export const FOUNDER_HUE = [];
for (let k = 0; k < FOUNDER_COUNT; k++) {
  const t = FOUNDER_COUNT === 1 ? 0 : (k / (FOUNDER_COUNT - 1)) * 2 - 1;   // -1〜1
  FOUNDER_HUE.push((DEFAULT_RACE.hue + t * RACE_HUE_SPREAD + 360) % 360);
}

/** 色相の隔たり（0〜180度）。色相環は循環しているので引き算では出ない */
export function hueGap(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return 180 - d;
}

// 見た目の座位（中間遺伝するもの）
export const LK_CORNERS = 0;          // 角の数 0〜8。0〜2は丸
export const LK_STRIPE_V = 1;         // 縦の線数 0〜5
export const LK_STRIPE_H = 2;         // 横の線数 0〜5
export const LOOK_COUNT = 3;
export const LOOK_MAX = [8, 5, 5];

// 潜性の対立遺伝子。2本揃って初めて出る
export const REC_STAR = 0, REC_HEART = 1;
export const REC_COUNT = 2;

export const SPECIAL_NONE = 0, SPECIAL_STAR = 1, SPECIAL_HEART = 2;

// 沈殿がこれ未満なら描かない（1px を割ると読めない）
export const SEDIMENT_MIN = 0.06;

// 中間遺伝のゆらぎ。**1.15 まで上げていたのを 0.18 に戻した。**
// 上げた理由は「10代で全員が同じ形になる」だったが、**A-24 でそれが正しいと分かった。**
// よその血が入らない限り種族は変わらない。**揃うのが正しい挙動だった。**
const JITTER = 0.18;
const MUT = 0.004;                    // 見た目の突然変異率。何百年かに一度、少しだけ動く

export const LOOK_SPEC = {
  bloodMix: `f32*${FOUNDER_COUNT}`,   // 十匹それぞれの血の割合。合計1。子は親の平均
  look: `f32*${LOOK_COUNT}`,          // 角の数・縦の線数・横の線数
  rec: `u8*${REC_COUNT * 2}`,         // 潜性の対立遺伝子。2本ずつ
};

const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

/** 創世の十匹。**それぞれ違う見た目にする。**ここが世界の血統の出発点になる */
export function foundLook(P, i, k, rng, race = DEFAULT_RACE) {
  const A = P.a;
  for (let f = 0; f < FOUNDER_COUNT; f++) A.bloodMix[f][i] = 0;
  A.bloodMix[k % FOUNDER_COUNT][i] = 1;                    // 1人1枠。まだ混ざっていない

  // **十匹は同じ種族**（A-24）。個体差は丸めれば消える狭いゆらぎだけ
  const wob = () => (rng.next() - 0.5) * 2 * RACE_LOOK_SPREAD;
  A.look[LK_CORNERS][i] = clamp(race.corners + wob(), LOOK_MAX[LK_CORNERS]);
  A.look[LK_STRIPE_V][i] = clamp(race.stripeV + wob(), LOOK_MAX[LK_STRIPE_V]);
  A.look[LK_STRIPE_H][i] = clamp(race.stripeH + wob(), LOOK_MAX[LK_STRIPE_H]);

  // 潜性は最初から潜らせておく。**出るのは何代もあと**
  for (let r = 0; r < REC_COUNT; r++) {
    A.rec[r * 2][i]     = rng.next() < 0.16 ? 1 : 0;
    A.rec[r * 2 + 1][i] = rng.next() < 0.16 ? 1 : 0;
  }
}

/** 子。血は割合を平均し、形と模様は中間遺伝、星とハートは片方ずつ受け取る */
export function breedLook(P, c, dad, mom, rng) {
  const A = P.a;

  // 血：**割合を平均する。**色相は平均しない（平均すると必ず濁って消える）
  for (let f = 0; f < FOUNDER_COUNT; f++) {
    A.bloodMix[f][c] = (A.bloodMix[f][dad] + A.bloodMix[f][mom]) * 0.5;
  }

  // 形と模様：中間遺伝＋ゆらぎ
  for (let k = 0; k < LOOK_COUNT; k++) {
    let v = (A.look[k][dad] + A.look[k][mom]) * 0.5 + (rng.next() - 0.5) * 2 * JITTER;
    if (rng.next() < MUT) v += (rng.next() - 0.5) * 1.2;
    A.look[k][c] = clamp(v, LOOK_MAX[k]);
  }

  // 潜性：親それぞれから1本ずつ
  for (let r = 0; r < REC_COUNT; r++) {
    A.rec[r * 2][c]     = A.rec[r * 2 + rng.int(2)][dad];
    A.rec[r * 2 + 1][c] = A.rec[r * 2 + rng.int(2)][mom];
  }
}

/** 見た目を読む。**丸めるのはここ1か所だけ**（描く側でばらばらに丸めない） */
export function lookOf(P, i) {
  const A = P.a;
  const raw = A.look[LK_CORNERS][i];
  const corners = raw < 2.5 ? 0 : Math.min(8, Math.round(raw));
  // 星が優先。両方揃っていたら星（尖りのほうが読める）
  const star = A.rec[REC_STAR * 2][i] === 1 && A.rec[REC_STAR * 2 + 1][i] === 1;
  const heart = A.rec[REC_HEART * 2][i] === 1 && A.rec[REC_HEART * 2 + 1][i] === 1;
  return {
    corners,
    stripeV: Math.round(A.look[LK_STRIPE_V][i]),
    stripeH: Math.round(A.look[LK_STRIPE_H][i]),
    special: star ? SPECIAL_STAR : heart ? SPECIAL_HEART : SPECIAL_NONE,
  };
}

/**
 * 血の上位2枠。**これが体の色と沈殿になる。**
 * 3位以下は描かない（個体票で全部言う）。
 */
export function bloodTop2(P, i, hueOf) {
  const A = P.a;
  let a = -1, av = 0, lines = 0;
  for (let f = 0; f < FOUNDER_COUNT; f++) {
    const v = A.bloodMix[f][i];
    if (v > 0.004) lines++;
    if (v > av) { a = f; av = v; }
  }
  if (a < 0) return { first: 0, secondHue: 0, sediment: 0, lines: 0, pure: 0 };

  // 沈殿＝**1位以外の合計**。2位だけにすると、十匹ぶんに混ざりきった個体
  // （全部0.1）が「1割しか混ざっていない」に見えてしまう。実際は9割よそ者。
  const rest = 1 - av;

  // 沈む色は「1位以外を全部まぜた色」。**ここでだけ色相を平均する。**
  // 混ざりきると濁った中間色になるが、それが言いたいことそのもの
  let x = 0, y = 0;
  for (let f = 0; f < FOUNDER_COUNT; f++) {
    if (f === a) continue;
    const v = A.bloodMix[f][i];
    if (v <= 0) continue;
    const rad = hueOf(f) * Math.PI / 180;
    x += Math.cos(rad) * v; y += Math.sin(rad) * v;
  }
  let h2 = Math.atan2(y, x) * 180 / Math.PI;
  if (h2 < 0) h2 += 360;

  // **同じ種族の血は沈殿させない**（A-24）。沈殿が言うのは「よその血」であって
  // 「誰の子孫か」ではない。十匹は同じ帯にいるので、Phase 1 では誰にも沈殿が出ない
  const h1 = hueOf(a);
  const foreign = rest > 0 && hueGap(h1, h2) >= FOREIGN_MIN_DEGREES;

  return {
    first: a,
    secondHue: foreign ? h2 : h1,
    // 半分で頭打ち。これ以上沈むと「体の色」と「沈殿」が入れ替わって読めなくなる
    sediment: (!foreign || rest < SEDIMENT_MIN) ? 0 : Math.min(0.5, rest),
    lines,
    pure: av,                          // 1位の割合。1なら純血
  };
}

/** 個体票用。全枠の割合を、多い順の一覧で返す */
export function bloodBreakdown(P, i) {
  const A = P.a;
  const out = [];
  for (let f = 0; f < FOUNDER_COUNT; f++) {
    const v = A.bloodMix[f][i];
    if (v > 0.004) out.push({ founder: f, share: v });
  }
  out.sort((x, y) => y.share - x.share);
  return out;
}
