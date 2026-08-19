// 判定結果を tools/report-search.md に書き出す。
// 図はASCII。数字は必ず「何で測ったか」と一緒に出す。

import { fmt, mean } from './stats.js';
import { CARD_IDS, CARD_RANGE } from './space.js';

const SHADE = '.:-=+*#%@';
const shade = (x) => SHADE[Math.max(0, Math.min(SHADE.length - 1, Math.round(x * (SHADE.length - 1))))];

function bar(v, max, width = 24, ch = '#') {
  const n = Math.max(0, Math.min(width, Math.round((v / (max || 1)) * width)));
  return ch.repeat(n) + '·'.repeat(width - n);
}
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);

const VERDICT_JA = {
  DOMINANT_STRICT: '**支配戦略あり（文字どおり全ブロックで勝ち）— 設計の敗北**',
  DOMINANT_TYPE: '**支配的な「型」あり（全相手で最上位ティア、しかも1つの塊）— 設計の敗北**',
  MULTI_UNIVERSAL: '全相手で通じる方針は複数あるが、それらは互いに離れた別の型',
  NONE: '支配戦略なし（全相手で最上位ティアに入る方針は1本も無い）',
  NO_SIGNAL: '**判定不能。方針の差そのものが測れていない**（最上位ティアがほぼ全員）',
  SAME_FOR_ALL: '**全相手で最良が同じ — 相手依存は成立していない**',
  OPPONENT_DEPENDENT: '相手ごとに最良が変わる（ノイズの床を超えている）',
  INDISTINGUISHABLE_FROM_NOISE: '**最良の入れ替わりは測定ノイズと区別がつかない**',
  CLEAR: '上手い下手ははっきり出る',
  WEAK: '差は出るが薄い',
  NOT_OBSERVABLE: '**差が観測できない — 上達を測る定規が無い**',
};

export function renderReport(ctx) {
  const { meta, t, q1, q2, q3, q4, sens, oat, robustness } = ctx;
  const L = [];
  const w = (s = '') => L.push(s);

  w('# 最適解探索 — 判定');
  w();
  if (meta.fake) {
    w('> ## ⚠ この報告はダミーデータで生成されている');
    w('>');
    w(`> **正解が既知の偽の世界 \`${meta.world}\` で判定器を回した結果**であり、実際の sim は一度も回していない。`);
    w('> ここに書かれた数字は「増殖」の性質を一切表さない。判定ロジックが動くことの証明にすぎない。');
    w();
    w('本番の判定に足りていないもの：');
    w();
    w('| | 状態 |');
    w('|---|---|');
    w(`| \`tools/eval.js\`（本物のsimを叩く評価器） | ${meta.hasEval ? '**あり**。契約どおりの入出力で疎通確認済み' : '**未実装**'} |`);
    w(`| \`${meta.bestPath}\`（探索担当の上位方針） | ${meta.hasBest ? '**あり**' : '**未着**。これが来れば本番の判定を出せる'} |`);
    w('| 判定ロジック | **完成**。3つのダミー世界で較正済み（末尾の付録） |');
    w();
    if (meta.fullCost) {
      w('**本番の判定にかかる時間（実測から）**');
      w();
      w(`本物の sim は \`gens=${meta.gens}\` で1行あたり約1.4秒（並列9・種ごとの10国ロスター構築を含む）。`);
      w(`既定の規模だと ${meta.fullCost.rows} 行 ＝ **約${(meta.fullCost.minutes / 60).toFixed(1)}時間**。`);
      w('うっかり数時間走らせないよう、見積りが30分を超えると `run.js` は止まる（`--yes` で続行）。');
      w('規模を落とすなら `--seeds` / `--random` / `--elite-cap`。ただし種は SEARCH.md の下限30を割らないこと。');
      w();
    }
    w('**探索担当への申し送り**');
    w();
    w('- 判定は種 **9001以降**を使う。探索側の 1..60 とは重ならないので、規約上の衝突は無い。');
    w('  判定器は毎回 `best.json` の `meta.search_seeds` と突き合わせて重なりを機械的に確認する。');
    w('- `best.json` は `finalize.py` が書く `policies` 配列をそのまま読める（`top` 形式も可）。');
    w('  **上位1本ではなく上位群を渡すこと。** 問2は上位群をクラスタリングして型を数えるので、1本だと答えが出ない。');
    w('- 探索の目的関数は `power`、判定の主指標は `winRate`（勝利条件が戦争なので）。');
    w('  ズレは承知の上で、判定側は3指標すべてで結論が変わらないかを毎回確認する。');
    w();
    w('準備ができたら `node tools/judge/run.js` を打ち直せば、この文書はそのまま上書きされる。');
    w();
  }

  // ----------------------------------------------------------- 測定条件
  w('## 測定条件');
  w();
  w('| | |');
  w('|---|---|');
  w(`| 評価器 | ${meta.fake ? `ダミー（\`${meta.world}\`）` : '`tools/eval.js`（本物のsim）'} |`);
  w(`| 方針の出どころ | ${meta.policySource} |`);
  w(`| 方針数 | ${t.ids.length}（探索由来 ${meta.nElite} / 判定器が独立に撒いた一様乱択 ${meta.nRandom}） |`);
  w(`| 相手 | ${t.opponents.length}国：${t.opponents.join(' / ')} |`);
  w(`| 種（ホールドアウト） | ${t.seeds.length}種 [${t.seeds[0]}..${t.seeds[t.seeds.length - 1]}] |`);
  w(`| 世代数 | ${meta.gens} |`);
  w(`| 総試行 | ${t.ids.length * t.opponents.length * t.seeds.length} 行（欠損 ${t.missing}） |`);
  w(`| 主指標 | \`${t.metric}\`${t.metric === 'winRate' ? '（絶滅=0、一度も戦わなかった国=0）' : ''} |`);
  w(`| 比較の単位 | (相手, 種) をブロックにした対応あり比較 |`);
  w(`| 生きているつまみ | ${meta.activeKnobs ?? '?'} / 16 |`);
  if (meta.sim) {
    w(`| 測定時の sim | \`${meta.sim.hash}\`${meta.sim.rev ? ` / git ${meta.sim.rev}` : ''}（src/sim 最終更新 ${meta.sim.mtime}） |`);
  }
  w();
  if (meta.sim) {
    w('sim の指紋を残してあるのは、**探索中に `src/sim/` が書き換わっていた**ため。');
    w('指紋が違う測定どうしで絶対値を比べてはいけない（創世の分散が 0.14→0.16 に変わる、といった変更が入る）。');
    w();
  }
  if (meta.inert && meta.inert.length) {
    w('### 死んだ次元');
    w();
    w(`評価器が \`meta.inertCards\` で自己申告した「動かしても何も起きないカード」：**${meta.inert.join(', ')}**`);
    w();
    w('これらは**距離計算とクラスタリングから除外してある**。除外しないと、挙動が完全に同じ方針が');
    w('パラメータ空間で離れて見え、クラスタが死にカードの上で割れて**勝ち筋の本数が水増しされる**。');
    w();
    if (meta.evMeta?.cardsWiredByOwner?.length) {
      w(`なお \`${meta.evMeta.cardsWiredByOwner.join(', ')}\` は sim が直接カードを読まないが、`);
      w('評価器のオーナー層が配線しているので効果はある。**死んでいるのは上の分だけ**で、');
      w('「simがcardOrで読んでいない5枚」を全部死んだ扱いにするのは誤り（判定側で実測確認済み）。');
      w();
    }
    w('問2のクラスタリングはもともと**挙動空間**（相手別の得意不得意）で行うので、');
    w('この失敗モードには構造的に強い。除外が効くのは距離行列と型の記述のほう。');
    w();
  }
  w('### ホールドアウトの検証');
  w();
  w('「分けたつもり」を信用せず、探索側が記録した種と突き合わせて確かめる。');
  w();
  const a = meta.audit || {};
  if (!a.known) {
    w('- 探索側のメタ情報（`best.json` の `meta.search_seeds`）が読めないので、**重なりを機械的に確認できていない**。');
    w(`- 判定に使ったのは種 ${t.seeds[0]}..${t.seeds[t.seeds.length - 1]}。取り決めでは探索は 1..8999 なので、規約上は重ならない。`);
  } else {
    w(`- 探索側が使った種：${a.searchSeedCount}本（探索＋探索側ホールドアウト）`);
    w(`- 判定に使った種：${t.seeds.length}本 [${t.seeds[0]}..${t.seeds[t.seeds.length - 1]}]`);
    w(a.overlap.length
      ? `- **重なり：${a.overlap.length}本（${a.overlap.slice(0, 10).join(',')}）。ホールドアウトは汚染されている。上位方針の成績はその分だけ過適合を含む。**`
      : '- **重なり：0本。** 以下の数字はすべて、方針を選ぶのに一度も使っていない種で測ったもの。');
  }
  if (a.searchOpps) {
    w(`- 探索が実際に相手にした国：${a.searchOpps.length}国（${a.searchOpps.join(', ')}）`);
    w(a.unseenOpps.length
      ? `- **判定はこれに加えて ${a.unseenOpps.length}国（${a.unseenOpps.join(', ')}）でも測る。** 探索が一度も見ていない相手なので、`
        + '\n  ここでの成績は「見たことのない思想への汎化」を測っていることになる。'
      : '- 判定と探索の相手集合は同じ。未知の相手への汎化は測れていない。');
  }
  w();

  // ------------------------------------------------- 測定の限界（先に読む）
  const lim = ctx.limits;
  if (lim) {
    w('---');
    w();
    w('## 先に：測定の天井と分解能');
    w();
    w('4つの答えより先にこれを見ないと、全部読み違える。');
    w();
    w('**天井** — この探索空間で到達できた成績');
    w();
    w('```');
    const pr = lim.parity;
    const lo = Math.min(lim.floor, pr ?? lim.floor), hi = Math.max(lim.ceiling, pr ?? lim.ceiling);
    const at = (x) => Math.round(((x - lo) / Math.max(1e-9, hi - lo)) * 40);
    const line = (label, x, ch) => {
      const s = new Array(41).fill('·'); s[Math.max(0, Math.min(40, at(x)))] = ch;
      return `${pad(label, 10)} ${padL(fmt(x), 8)}  ${s.join('')}`;
    };
    w(line('最悪', lim.floor, 'x'));
    w(line('中央', lim.medianRaw, 'o'));
    w(line('最良（天井）', lim.ceiling, '#'));
    if (pr != null) w(line('互角の線', pr, '|'));
    w('```');
    if (pr != null) {
      w();
      w(lim.atParity === false
        ? `**天井が互角の線 ${pr} に届いていない**（互角以上に立てた方針は全体の ${fmt(lim.aboveParityFrac * 100, 0)}%）。`
          + '\n\nこれは判定の読み方を変える。プレイヤーが敷けるのは12枚のカードと4つの選択だけで、'
          + '\n相手（rival profile）が持つ「粛清」「配る」「形質選好」に相当するレバーが無い。'
          + '\n**何を敷いても勝ち越せない空間で「支配戦略が無い」ことは、収束を防ぐ装置が効いている証拠にならない。**'
          + '\n手が足りないだけ、という説明が同じデータを説明してしまう。この2つは以下の数字では分離できない。'
        : `天井は互角の線 ${pr} を超えている（互角以上に立てた方針は全体の ${fmt(lim.aboveParityFrac * 100, 0)}%）。`
          + '\n「何をしても勝てないから最適解が決まらない」という対抗説明はここで消える。');
    }
    w();
    w('**分解能** — いまの種数で分離できる最小の差');
    w();
    w('| | |');
    w('|---|---|');
    w(`| ブロック数（相手×種） | ${lim.nBlocks} |`);
    w(`| 上位${lim.topK}本どうしの差のばらつき sd | ${fmt(lim.sdDiff)} |`);
    w(`| 総合での最小検出可能差（α=.05, 検出力.8） | **${fmt(lim.mddOverall)}** |`);
    w(`| 相手1国だけで見たときの最小検出可能差 | ${fmt(lim.mddPerOpp)} |`);
    w(`| 実際の上位${lim.topK}本の広がり | ${fmt(lim.topSpread)} |`);
    w();
    w(lim.topResolvable
      ? `→ 上位の広がり ${fmt(lim.topSpread)} > 最小検出可能差 ${fmt(lim.mddOverall)}。**上位どうしの順位は分離できている。**`
      : `→ 上位の広がり ${fmt(lim.topSpread)} ≦ 最小検出可能差 ${fmt(lim.mddOverall)}。`
        + '\n**上位どうしの順位は分離できていない。**「最良の方針」を1本名指しすることに意味は無く、'
        + '\n以下で「最良」と呼んでいるものは上位ティアの中の1本にすぎない。');
    w();
  }

  // ------------------------------------------------------------- 問1
  w('---');
  w();
  w('## 問1. 支配戦略はあるか');
  w();
  w(`### 答え：${VERDICT_JA[q1.verdict]}`);
  w();
  w('相手ごとの「最上位ティア」（その相手の最良と、対応あり並べ替え検定＋Holm補正で差がつかなかった方針の集合）。');
  w('ティアが薄いほど「その相手には答えが1つしかない」。');
  w();
  w('```');
  w(`相手          最上位ティアの人数 / ${t.ids.length}`);
  const maxTier = Math.max(...q1.tierSizes);
  q1.tierByOpp.forEach((x, i) => {
    w(`${pad(x.opponent, 10)} ${padL(q1.tierSizes[i], 3)}  ${bar(q1.tierSizes[i], maxTier, 30)}  最良=${x.best != null ? t.ids[x.best] : '-'}`);
  });
  w('```');
  w();
  w(`- ティアの平均サイズ ＝ 全 ${t.ids.length} 方針の **${fmt(q1.tierFrac * 100, 1)}%**`);
  w(`  （80%を超えたら「差が無い」ではなく**差が測れていない**と判定して、問1を判定不能にする）`);
  w(`- **全10相手で最上位ティアに入った方針：${q1.universal.length}本**`);
  if (q1.universal.length) {
    w(`  - ${q1.universalIds.slice(0, 12).join(', ')}${q1.universal.length > 12 ? ' …' : ''}`);
    w(`  - この集合の広がりを**2通りで測る**：`);
    w(`    - パラメータ空間の直径 ＝ ${fmt(q1.uDiameter)}（0＝同じカード設定、1＝真逆）`);
    w(`    - **かたち（相手別の得意不得意）の直径 ＝ ${fmt(q1.uShapeDiameter)}**、測定誤差の床 ${fmt(q1.noiseFloor)}`);
    w(`  - 判定に使うのは後者。死んでいるカードがあると、挙動が同一の方針でもパラメータ空間には散らばるため、`);
    w(`    パラメータの直径で判定すると支配戦略を見逃す（ダミー世界 \`dominant\` で実際に見逃した）。`);
    w(`  - かたちの直径 < 測定誤差の2倍（${fmt(2 * q1.noiseFloor)}）なら「全員が同じ型」→ ${q1.uShapeDiameter < 2 * q1.noiseFloor ? '**該当（支配的な型あり）**' : '該当せず（複数の型）'}`);
  }
  w(`- 総合1位 \`${q1.champId}\` が他方針をブロック単位で上回った割合の**最小値 ＝ ${fmt(q1.minBeat)}**`);
  w(`  （1.00 なら全種・全相手で全方針に勝っている＝文字どおりの支配戦略。0.50 は互角）`);
  w();

  // 感度
  w('### どのカードが効いているか');
  w();
  if (sens) {
    w(`空間全体（${sens.n}方針）で、成績を標準化リッジ回帰にかけた係数。`);
    w(`線形当てはまり **R² = ${fmt(sens.r2)}**${sens.r2 < 0.4 ? '（低い＝成績の大半は単独のカードでは説明できない。相互作用が本体）' : ''}`);
    w();
    w('```');
    const top = sens.terms.slice(0, 14);
    const mx = Math.max(...top.map((x) => Math.abs(x.beta)));
    for (const x of top) {
      const sign = x.beta >= 0 ? '+' : '-';
      w(`${pad(x.feature, 20)} ${sign}${fmt(Math.abs(x.beta))}  ${bar(Math.abs(x.beta), mx, 26, x.beta >= 0 ? '#' : 'x')}`);
    }
    w('```');
    const dead = sens.terms.filter((x) => Math.abs(x.beta) < 0.02).map((x) => x.feature);
    if (dead.length) {
      w();
      w(`係数がほぼ0（|β| < 0.02）＝**動かしても成績が変わらないつまみ：${dead.length}個**`);
      w(`　${dead.slice(0, 16).join(', ')}${dead.length > 16 ? ' …' : ''}`);
      w();
      w('死んでいるカードは「勝ち筋の多様性」を水増しする。クラスタが死にカードだけで割れていたら、');
      w('それは型の違いではない。問2の挙動検定はそこを見ている。');
    }
    w();
  }
  if (oat) {
    w(`総合1位 \`${oat.baseId}\` から、つまみを1つずつ範囲の±25%動かしたときの成績変化（OAT）。`);
    w();
    w('```');
    const mx = Math.max(...oat.byKnob.map((x) => Math.abs(x.effect)), 1e-9);
    for (const x of oat.byKnob) {
      w(`${pad(x.at, 22)} Δ=${x.effect >= 0 ? '+' : ''}${fmt(x.effect)}  p=${fmt(x.p)}  ${bar(Math.abs(x.effect), mx, 22, x.effect >= 0 ? '#' : 'x')}`);
    }
    w('```');
    w();
  } else if (!sens) {
    w('（感度分析は未実行）');
    w();
  }

  // ------------------------------------------------------------- 問2
  w('---');
  w();
  w('## 問2. 勝ち筋は何本あるか');
  w();
  w(`### 答え：型は **${q2.nTypes}本**（クラスタ ${q2.k}個 → 「同じ型」と判定したものを統合して ${q2.nTypes}）`);
  w();
  w('**まず「型」の定義**。ここを決めないと数は何とでも言える。');
  w();
  w('> 型 ＝ **相手ごとの得意不得意のパターン（かたち）**。');
  w('> 得意不得意が同じで強さだけ違うのは、別の型ではなく**同じ型の上手い下手**（それは問4で測る）。');
  w();
  w(`上位集合は ${q2.nTop} 方針（全 ${t.ids.length} 中）。`);
  w('内訳は「どれか1国に対して最上位ティアに入った方針」∪「総合上位15%」。');
  w('総合上位だけで切ると、特定の相手にだけ刺さる専門家が落ちて勝ち筋を数え落とす。');
  w();
  w('各方針を「相手別の成績プロファイルから自分の平均を引いた**かたち**」で表してクラスタリングする。');
  w('平均を引かないと、単に強い方針と弱い方針が別の島になって本数が水増しされる。');
  w('パラメータ空間で割らないのは、成績に効かない死にカードの違いが型の違いに化けるため。');
  w();
  w('**クラスタ数の決め方**：シルエット係数の最大。ギャップ統計量は帰無参照の作り方に強く依存して');
  w('k が上限に張り付くので、採用には使わず診断として併記する。');
  w();
  w('```');
  w('  k   シルエット   gap     s(k)');
  const silAt = new Map((q2.sils || []).map((s) => [s.k, s.sil]));
  for (const r of q2.gap.rows) {
    w(`  ${r.k}   ${padL(silAt.has(r.k) ? fmt(silAt.get(r.k), 3) : '  -', 7)}   ${padL(fmt(r.gap), 7)}  ${fmt(r.sk)}   ${r.k === q2.k ? '← 採用' : r.k === q2.gap.kStar ? '(gapの推し)' : ''}`);
  }
  w('```');
  w();
  w('**「本当に違う型か／同じ型のゆらぎか」の検定**');
  w();
  w('| 検定 | 数字 | 意味 |');
  w('|---|---|---|');
  w(`| 測定誤差の床（実測） | **${fmt(q2.noiseFloor)}** | 同じ方針を種の半分ずつで2回測って、かたちがどれだけブレるか。これ以下の差は差ではない |`);
  w(`| クラスタ間/内 距離比 | ${fmt(q2.wb.between)} / ${fmt(q2.wb.within)} = **${fmt(q2.wb.ratio)}** | 1.0 なら島は無い |`);
  w(`| ラベル並べ替え検定 | p = ${fmt(q2.perm.p)} | 0.05以上なら k=1（勝ち筋は1本）に落とす |`);
  w(`| シルエット係数 | ${fmt(q2.sil, 2)} | 0以下＝分かれていない |`);
  w(`| 一つ抜き識別率 | ${fmt(q2.ident.rate * 100, 1)}% | 偶然 ${fmt(q2.ident.chanceUniform * 100, 1)}% / 多数派 ${fmt(q2.ident.chanceMajority * 100, 1)}% |`);
  w(`| 同じラベルがパラメータでも分かれるか | 比 ${fmt(q2.paramWb.ratio)} / p = ${fmt(q2.paramPerm.p)} | かたちの型が別のカード設定として書けるか |`);
  w();
  if (q2.behavior.length) {
    w('**クラスタ対ごとの内訳**。「同じ型」と判定して統合する条件は4つ：');
    w();
    w('```');
    w('  S/N < 1.0      重心間の距離が測定誤差の床の内側（そもそも差ではない）');
    w('  p >= 0.05      ラベルの偶然で同じ距離が出る');
    w('  cos >= ' + fmt(q2.cosThreshold, 2) + '    得意不得意のかたちが同じで、強度だけ違う（＝同じ型の上手い下手）');
    w('  両方とも平坦    起伏が測定誤差以下。相手を選ばないので「かたち」を持たない');
    w('```');
    w();
    w('```');
    w('対      重心間距離  型内ばらつき   S/N     cos     p      判定');
    for (const pr of q2.behavior) {
      w(`${pr.a} vs ${pr.b}    ${padL(fmt(pr.sep), 7)}     ${padL(fmt(pr.wobble), 6)}  ${padL(fmt(pr.snr, 2), 6)}  ${padL(fmt(pr.cos, 2), 6)}  ${fmt(pr.p)}  ${pr.same ? `同じ型（${pr.same}）→統合` : '別の型'}`);
    }
    w('```');
    w();
  }
  w('**各型の中身**（代表方針のカード値。██ が範囲内の位置）');
  w();
  w('```');
  const keyCards = ['deploy_top', 'drill', 'hunt_ratio', 'stockpile', 'frontier', 'ration_equal', 'hereditary', 'mix_policy'];
  w(`ク 型  n   ${keyCards.map((c) => pad(c, 12)).join('')}  promote / border / 捕虜軸 / 好戦`);
  for (const c of q2.clusters) {
    const cells = keyCards.map((cid) => {
      const r = CARD_RANGE[cid];
      const x = (c.repPolicy.cards?.[cid] ?? r.def);
      const f = (x - r.min) / (r.max - r.min);
      return pad(`${padL(Math.round(x), 3)} ${'█'.repeat(Math.round(f * 6)).padEnd(6, '·')}`, 12);
    }).join('');
    w(`${padL(c.c, 2)}${padL(c.typeOf, 3)} ${padL(c.n, 3)}  ${cells}  ${c.repPolicy.promote} / ${c.repPolicy.border} / ${c.repPolicy.captiveAxis} / ${fmt(c.repPolicy.warAppetite, 2)}`);
  }
  w('```');
  w('ク=クラスタ番号 / 型=統合後の型番号（同じ番号は同じ型）');
  w();
  w('**クラスタ × 相手 の相性**（かたち＝自分の平均を引いた後の値。濃いほど得意）');
  w();
  w('```');
  w(`        ${t.opponents.map((o) => pad(o.slice(0, 4), 5)).join('')}`);
  const allZ = q2.clusters.flatMap((c) => c.shape);
  const lo = Math.min(...allZ), hi = Math.max(...allZ);
  for (const c of q2.clusters) {
    const cells = c.shape.map((z) => pad(shade((z - lo) / Math.max(1e-9, hi - lo)).repeat(3), 5)).join('');
    w(`ク${padL(c.c, 2)}型${padL(c.typeOf, 2)} ${cells}  起伏=${fmt(c.shapeAmp, 2)}${c.flat ? '(平坦)' : ''} 総合z=${fmt(c.overall, 2)}`);
  }
  w(`凡例 苦手[${SHADE.trim()}]得意   範囲 ${fmt(lo, 2)} … ${fmt(hi, 2)}   測定誤差の床 ${fmt(q2.noiseFloor)}`);
  w('```');
  w();

  // ------------------------------------------------------------- 問3
  w('---');
  w();
  w('## 問3. 最適は相手で変わるか');
  w();
  w(`### 答え：${VERDICT_JA[q3.verdict]}`);
  w();
  w(`10国それぞれの最良方針は **${q3.distinctBest}種類**（10国で全部違えば10、1本に収束すれば1）。`);
  w();
  w('**相手ごとの最良方針の距離行列**（0＝同じ方針、1＝16個のつまみが全部真逆）');
  w();
  w('```');
  w(`          ${t.opponents.map((o) => pad(o.slice(0, 4), 5)).join('')}`);
  t.opponents.forEach((o, i) => {
    w(`${pad(o, 9)} ${q3.D[i].map((d) => padL(fmt(d, 2), 5)).join('')}   最良=${q3.bestIds[i]}`);
  });
  w('```');
  w();
  w('**この行列が「相手の違い」なのか「測るたびのブレ」なのかの対照実験**');
  w();
  w('同じ相手のまま種を半分ずつに割って、それぞれの最良方針を出し、その距離を測る。');
  w('相手は同じなのだから、この距離はまるごとノイズの床。');
  w();
  w('```');
  w(`  相手をまたいだ最良の距離（平均） = ${fmt(q3.betweenMean)}   ${bar(q3.betweenMean, Math.max(q3.betweenMean, q3.withinMean), 30)}`);
  w(`  同じ相手・種を半分ずつの距離     = ${fmt(q3.withinMean)}   ${bar(q3.withinMean, Math.max(q3.betweenMean, q3.withinMean), 30, 'o')}`);
  w(`  比 = ${fmt(q3.ratio, 2)}   （1.0近辺なら、相手ごとの違いは全部ノイズ）`);
  w('```');
  w();
  w('**後悔行列**：相手 j の戦場に「相手 i 用の最良」を持ち込んだときの取りこぼし（その相手における方針間ばらつきのsd単位）。');
  w('0 に近ければ「1本で全部いける」＝コピー可能。');
  w();
  w('```');
  w(`持込\\戦場  ${t.opponents.map((o) => pad(o.slice(0, 4), 5)).join('')}`);
  t.opponents.forEach((o, i) => {
    w(`${pad(o, 9)} ${q3.R[i].map((r) => padL(fmt(r, 2), 5)).join('')}`);
  });
  w(`平均（対角を除く） = ${fmt(q3.offRegretMean)} sd   90%点 = ${fmt(q3.offRegretP90)} sd`);
  w('```');
  w();
  w(`**「1本で全相手を回る」最善手**：\`${q3.bestUniversalId}\`（全相手平均の取りこぼし ${fmt(q3.bestUniversalLoss)} sd）`);
  w(`　これが 0 に近ければ「統治の正解はコピーできる」＝設計の主張の否定。`);
  w();

  // ------------------------------------------------------------- 問4
  w('---');
  w();
  w('## 問4. 上手い下手の差は観測できるか');
  w();
  w(`### 答え：${VERDICT_JA[q4.verdict]}`);
  w();
  const mx4 = Math.max(...q4.ladder.map((r) => r.mean), q4.random.mean);
  w('```');
  w(`                ${t.metric}（平均）  95%CI`);
  for (const r of q4.ladder) {
    w(`${pad(r.name, 10)} ${padL(fmt(r.mean), 8)}  [${fmt(r.ci.lo)}, ${fmt(r.ci.hi)}]  ${bar(r.mean, mx4, 26)}`);
  }
  w(`${pad('ランダム', 10)} ${padL(fmt(q4.random.mean), 8)}  [${fmt(q4.random.ci.lo)}, ${fmt(q4.random.ci.hi)}]  ${bar(q4.random.mean, mx4, 26, 'o')}  (${q4.random.n}本を一様乱択)`);
  w('```');
  w();
  w('| | |');
  w('|---|---|');
  w(`| 最良 vs ランダム の効果量 (Cohen's d) | **${fmt(q4.d, 2)}** （0.2小 / 0.5中 / 0.8大） |`);
  w(`| 1戦だけで最良がランダムに勝つ確率 | **${fmt(q4.pSup * 100, 1)}%** （50%＝コイン投げと同じ） |`);
  w(`| 上手い下手を有意に分けるのに要る試合数 | **1人あたり ${Number.isFinite(q4.nNeeded) ? q4.nNeeded : '∞'} 戦** |`);
  w();
  w('ばらつきの出どころを3つに分ける（混ぜると信号/雑音が読めない）。');
  w();
  w('```');
  const mxv = Math.max(q4.seedNoise, q4.oppSpread, q4.policySpread);
  w(`  種（運）      ${padL(fmt(q4.seedNoise), 7)}  ${bar(q4.seedNoise, mxv, 22, 'o')}  方針も相手も固定して種だけ振ったブレ`);
  w(`  相手（相性）  ${padL(fmt(q4.oppSpread), 7)}  ${bar(q4.oppSpread, mxv, 22, '=')}  方針を固定して相手を変えたブレ`);
  w(`  方針（腕前）  ${padL(fmt(q4.policySpread), 7)}  ${bar(q4.policySpread, mxv, 22, '#')}  ← これが信号`);
  w(`  信号/雑音 = 方針 / 種 = ${fmt(q4.policySpread / Math.max(1e-9, q4.seedNoise), 2)}`);
  w('```');
  w();
  if (Number.isFinite(q4.nNeeded)) {
    w(q4.nNeeded > 20
      ? `→ ${q4.nNeeded}戦かからないと差が出ない。1ランが数分のゲームで、プレイヤーが自分の上達を実感できる長さではない。`
      : `→ ${q4.nNeeded}戦で差が出る。1セッションの中で上達が観測できる範囲。`);
    w();
  }

  // ------------------------------------------------------- 指標の頑健性
  if (robustness?.length) {
    w('---');
    w();
    w('## 指標を変えても結論は変わらないか');
    w();
    w('主指標の決め（絶滅=0、不戦=0 など）が結論を作っていないかの確認。');
    w();
    // 判定名の細かい違いではなく「結論として同じか」で比べる
    const cls1 = (v) => (v === 'DOMINANT_STRICT' || v === 'DOMINANT_TYPE' ? '支配戦略あり'
      : v === 'NO_SIGNAL' ? '判定不能' : '支配戦略なし');
    const cls3 = (v) => (v === 'OPPONENT_DEPENDENT' ? '相手依存あり' : '相手依存なし');
    w('| 指標 | 問1 | 問3 | 問4 (d) |');
    w('|---|---|---|---|');
    for (const r of robustness) {
      w(`| \`${r.metric}\`${r.metric === t.metric ? '（主）' : ''} | ${cls1(r.q1)} (${r.q1}) | ${cls3(r.q3)} (${r.q3}) | ${fmt(r.d, 2)} |`);
    }
    const agree = new Set(robustness.map((r) => cls1(r.q1))).size === 1
      && new Set(robustness.map((r) => cls3(r.q3))).size === 1;
    w();
    w(agree ? '→ 3指標で結論が一致。指標の決めが結論を作ってはいない。'
            : '→ **指標によって結論が変わる。** 主指標の決めが結論を作っている可能性がある。上の判定はその分だけ弱い。');
    w();
  }

  // --------------------------------------------------------- 総合判断
  w('---');
  w();
  w('## 設計は実装で成立しているか');
  w();
  if (meta.fake) {
    w('**現時点では答えられない。** 本番の評価器 `tools/eval.js` が未実装で、実際の sim を一度も回していない。');
    w(`以下はダミー世界 \`${meta.world}\` に対する判定例で、書式の見本にすぎない。`);
    w();
    w('<details><summary>判定例（クリックで展開）</summary>');
    w();
  }
  for (const line of ctx.verdictLines) w(line);
  w();
  if (meta.fake) { w('</details>'); w(); }
  if (meta.fake) {
    w('---');
    w();
    w(`（再掲）**上の判定はダミー世界 \`${meta.world}\` に対するもので、「増殖」に対するものではない。**`);
    w();
  }

  // ------------------------------------------------------- 判定器の自己検証
  if (ctx.selftest) {
    w('## 付録：判定器そのものの検証');
    w();
    w('本番で「支配戦略なし」と出たとき、それが**本当に無い**のか**判定器が見つけられないだけ**なのかを');
    w('区別する手段が他に無い。だから正解を仕込んだ3つの世界で先に較正してある（`node tools/judge/selftest.js`）。');
    w();
    w('```');
    for (const wd of ctx.selftest.worlds) {
      w(`世界 ${wd.world}`);
      for (const c of wd.checks) w(`  ${c.ok ? '✓' : '✗'} ${pad(c.name, 14)} 期待:${pad(c.want, 30)} 実際:${c.got}`);
    }
    w('```');
    w();
    w(ctx.selftest.pass
      ? '→ 12項目すべて一致。**支配戦略が有る世界では有ると答え、無い世界では無いと答え、測れない世界では判定不能と自己申告する**ことは確認済み。'
      : `→ **${ctx.selftest.fail}項目が不一致。判定器が較正できていない。本番の結果は信用できない。**`);
    w(`（検証日時 ${ctx.selftest.stamp}）`);
    w();
  }
  w();
  w('---');
  w();
  w(`_生成: \`node tools/judge/run.js${meta.argv.length ? ' ' + meta.argv.join(' ') : ''}\` / ${meta.stamp}_`);
  return L.join('\n');
}
