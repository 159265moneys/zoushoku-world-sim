// 遺伝子層：33座位を8本の染色体に配置する。
// 設計文書「遺伝システム」に対応。
//   心系 = 離散の優性/劣性（潜伏して数世代後に発現する）
//   体系 = 中間遺伝（親の平均にゆらぎ）
//   可塑 = 独立座位。減数分裂の交叉率そのものを決めるメタ遺伝子。

export const KIND = { BODY: 'body', MIND: 'mind' };

// arm: 'A' / 'B' が染色体の対抗クラスタ。同じ染色体の反対アームは連鎖で打ち消し合う。
export const GENES = {
  // 1番：速さ ↔ 耐久
  代謝:           { ch: 1, arm: 'A', kind: KIND.BODY },
  生育速度:       { ch: 1, arm: 'A', kind: KIND.BODY },
  頑健:           { ch: 1, arm: 'B', kind: KIND.BODY },
  寿命:           { ch: 1, arm: 'B', kind: KIND.BODY },

  // 2番：殴る ↔ 見る・考える
  攻撃素質:       { ch: 2, arm: 'A', kind: KIND.BODY },
  胆力:           { ch: 2, arm: 'A', kind: KIND.MIND },
  感応:           { ch: 2, arm: 'B', kind: KIND.BODY },
  好奇心:         { ch: 2, arm: 'B', kind: KIND.MIND },
  知性:           { ch: 2, arm: 'B', kind: KIND.BODY },

  // 3番：量・群 ↔ 質・個
  繁殖性:         { ch: 3, arm: 'A', kind: KIND.BODY },
  共同作業適性:   { ch: 3, arm: 'A', kind: KIND.MIND },
  器用:           { ch: 3, arm: 'B', kind: KIND.BODY },
  技術習得:       { ch: 3, arm: 'B', kind: KIND.BODY },
  私欲:           { ch: 3, arm: 'B', kind: KIND.MIND },

  // 4番：上昇 ↔ 安定（有能ほど不忠になる本命の連鎖）
  野心:           { ch: 4, arm: 'A', kind: KIND.MIND },
  統率素質:       { ch: 4, arm: 'A', kind: KIND.MIND },
  従順:           { ch: 4, arm: 'B', kind: KIND.MIND },
  保身:           { ch: 4, arm: 'B', kind: KIND.MIND },

  // 5番：個 ↔ 群
  誇り:           { ch: 5, arm: 'A', kind: KIND.MIND },
  頑迷:           { ch: 5, arm: 'A', kind: KIND.MIND },
  序列意識:       { ch: 5, arm: 'B', kind: KIND.MIND },
  柔軟:           { ch: 5, arm: 'B', kind: KIND.MIND },

  // 6番：身内 ↔ 全体
  情愛:           { ch: 6, arm: 'A', kind: KIND.MIND },
  世代間伝承意欲: { ch: 6, arm: 'A', kind: KIND.MIND },
  非情:           { ch: 6, arm: 'B', kind: KIND.MIND },
  勤勉:           { ch: 6, arm: 'B', kind: KIND.MIND },

  // 7番：信 ↔ 疑
  信仰性:         { ch: 7, arm: 'A', kind: KIND.MIND },
  団結傾向:       { ch: 7, arm: 'A', kind: KIND.MIND },
  懐疑:           { ch: 7, arm: 'B', kind: KIND.MIND },
  自律:           { ch: 7, arm: 'B', kind: KIND.MIND },

  // 8番：振れ幅と向き。感受性はほぼ全ての欲の乗数になる。
  感受性:         { ch: 8, arm: 'A', kind: KIND.MIND },
  他責:           { ch: 8, arm: 'B', kind: KIND.MIND }, // 低いほど自責寄り

  // 独立：交叉率メタ遺伝子
  可塑:           { ch: 0, arm: 'A', kind: KIND.BODY },
};

export const GENE_NAMES = Object.keys(GENES);
export const MIND_GENES = GENE_NAMES.filter(g => GENES[g].kind === KIND.MIND);
export const BODY_GENES = GENE_NAMES.filter(g => GENES[g].kind === KIND.BODY);

export const CHROMOSOMES = (() => {
  const m = {};
  for (const g of GENE_NAMES) {
    const { ch, arm } = GENES[g];
    (m[ch] ||= { A: [], B: [] })[arm].push(g);
  }
  return m;
})();

// 対抗アームの合計に上限を掛けるための正規化係数。
// 片側を強く受け継げば反対側が弱くなる、を構造で保証する。
export const ARM_BUDGET = 1.0;
