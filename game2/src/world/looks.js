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

const JITTER = 1.15;                  // 中間遺伝のゆらぎ。中間遺伝は分散が毎代半分になるので、
                                      // これが無いと10代で全員が同じ形になる（実際にそうなった）
const MUT = 0.02;                     // 見た目の突然変異率

export const LOOK_SPEC = {
  bloodMix: `f32*${FOUNDER_COUNT}`,   // 十匹それぞれの血の割合。合計1。子は親の平均
  look: `f32*${LOOK_COUNT}`,          // 角の数・縦の線数・横の線数
  rec: `u8*${REC_COUNT * 2}`,         // 潜性の対立遺伝子。2本ずつ
};

const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

/** 創世の十匹。**それぞれ違う見た目にする。**ここが世界の血統の出発点になる */
export function foundLook(P, i, k, rng) {
  const A = P.a;
  for (let f = 0; f < FOUNDER_COUNT; f++) A.bloodMix[f][i] = 0;
  A.bloodMix[k % FOUNDER_COUNT][i] = 1;                    // 1人1枠。まだ混ざっていない

  // 十匹の形を散らす。丸が多め（丸が最も原初的）
  const SHAPES = [0, 0, 3, 4, 5, 6, 0, 8, 4, 3];
  A.look[LK_CORNERS][i] = SHAPES[k % 10] + (rng.next() - 0.5) * 0.8;
  A.look[LK_STRIPE_V][i] = clamp(rng.int(6) + (rng.next() - 0.5) * 0.6, 5);
  A.look[LK_STRIPE_H][i] = clamp(rng.int(6) + (rng.next() - 0.5) * 0.6, 5);

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
    if (rng.next() < MUT) v += (rng.next() - 0.5) * 4;
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

  return {
    first: a,
    secondHue: rest > 0 ? h2 : hueOf(a),
    // 半分で頭打ち。これ以上沈むと「体の色」と「沈殿」が入れ替わって読めなくなる
    sediment: rest < SEDIMENT_MIN ? 0 : Math.min(0.5, rest),
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
