// オープニングの設問。MBTI的な問いの回答が、そのまま第1世代の心系遺伝子になる。
// 回答オブジェクトの形（sim との契約）：
//   answers = [{ id:'fear', choice:0, effects:{ 胆力:+0.22, 保身:-0.18 } }, ...]
// sim は effects を 0.5 を基準に加算して創世の二匹の素質を作る。

export const QUESTIONS = [
  {
    id: 'fear', text: '崖の上に道が一本ある。渡るか。',
    options: [
      { label: '渡る。落ちたら落ちたときだ', effects: { 胆力: +0.24, 保身: -0.20, 頑迷: +0.06 } },
      { label: '引き返す。命は一つしかない', effects: { 胆力: -0.22, 保身: +0.24, 柔軟: +0.06 } },
    ],
  },
  {
    id: 'blame', text: '作物が枯れた。誰のせいか。',
    options: [
      { label: '天のせいだ。人にはどうにもならない', effects: { 他責: +0.26, 自律: -0.16, 信仰性: +0.10 } },
      { label: '自分のせいだ。やり方が間違っていた', effects: { 他責: -0.24, 自律: +0.22, 勤勉: +0.10 } },
    ],
  },
  {
    id: 'ambition', text: '目の前に空いた席がある。誰も座っていない。',
    options: [
      { label: '座る。空いているなら自分のものだ', effects: { 野心: +0.26, 統率素質: +0.14, 従順: -0.20 } },
      { label: '座らない。誰かが決めるだろう', effects: { 野心: -0.22, 従順: +0.24, 保身: +0.08 } },
    ],
  },
  {
    id: 'crowd', text: '群れが一つの方向へ走り出した。理由は分からない。',
    options: [
      { label: '一緒に走る。皆が走るには訳がある', effects: { 感受性: +0.24, 団結傾向: +0.18, 懐疑: -0.18 } },
      { label: '立ち止まる。理由を確かめてからだ', effects: { 感受性: -0.20, 懐疑: +0.24, 知性: +0.10 } },
    ],
  },
  {
    id: 'pride', text: '頭を下げれば手に入るものがある。',
    options: [
      { label: '下げる。手に入るなら安いものだ', effects: { 誇り: -0.24, 柔軟: +0.22, 序列意識: +0.08 } },
      { label: '下げない。それだけは売らない', effects: { 誇り: +0.26, 頑迷: +0.16, 柔軟: -0.16 } },
    ],
  },
  {
    id: 'kin', text: '身内と、見知らぬ大勢。片方しか救えない。',
    options: [
      { label: '身内を取る', effects: { 情愛: +0.26, 世代間伝承意欲: +0.14, 非情: -0.20 } },
      { label: '数の多いほうを取る', effects: { 非情: +0.24, 情愛: -0.18, 共同作業適性: +0.10 } },
    ],
  },
  {
    id: 'faith', text: '誰も見ていない。それでも手を抜かないか。',
    options: [
      { label: '抜かない。見られていなくても同じだ', effects: { 勤勉: +0.24, 私欲: -0.20, 信仰性: +0.12 } },
      { label: '抜く。損をしない範囲でやる', effects: { 私欲: +0.26, 勤勉: -0.18, 保身: +0.10 } },
    ],
  },
];

/** 回答から素質のプレビューを作る（画面用。sim も同じ規則で作る想定） */
export function previewGenes(answers) {
  const g = {};
  for (const a of answers) {
    if (!a) continue;
    for (const k in a.effects) g[k] = (g[k] ?? 0.5) + a.effects[k];
  }
  for (const k in g) g[k] = Math.max(0.05, Math.min(0.95, g[k]));
  return g;
}

/** この質問群が触る遺伝子の一覧（表示順） */
export function touchedGenes() {
  const seen = [];
  for (const q of QUESTIONS) for (const o of q.options) for (const k in o.effects) if (!seen.includes(k)) seen.push(k);
  return seen;
}
