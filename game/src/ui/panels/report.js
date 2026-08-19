// 画面5：帰還報告。各局1行 × 3局 ＋ 重大イベント ＋ 推移グラフ3本 ＋ 裁可待ち。
// 見せるのは個体のステータスではない。局の報告。
// フェーズ1には報告が存在しない（全個体が画面にいるので自分で見ている）。

import { el, modal, sparkline, num, pct } from '../dom.js';
import { PHASE, BUREAU_LABEL } from '../../core/model.js';
import { renderPetitions } from './petitions.js';
import { portrait } from '../color.js';

// sim が record() で書いている kind そのもの。推測で書くと静かに空になる。
const BIG_KINDS = ['開戦', '戦終', '捕虜', '誅殺', '送還', '帰化', '任命', '裁定',
  '粛清', '一揆', 'フェーズ移行', '初戦の予兆', '発現', '潜伏形質の発現', '移住'];

export function openReport(ctx, { onClose } = {}) {
  const { world, api } = ctx;
  const body = el('div');

  // ---- 各局からの1行報告
  body.appendChild(el('h3', { class: 'sec' }, '各局からの報告'));
  if (world.phase === PHASE.VILLAGE) {
    body.appendChild(el('div', { class: 'card' },
      el('h4', {}, 'まだ報告は存在しない'),
      el('p', {}, '10体の村では全員が目の前にいる。誰かに読んでもらう必要がない。'
        + '部族になると、世界はあなたの目から離れて局長の言葉になる。'),
    ));
  } else {
    for (const key of ['military', 'agri', 'civil']) {
      const chief = world.bureaus[key] ? world.people.get(world.bureaus[key]) : null;
      body.appendChild(el('div', { class: 'card' },
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          chief ? portrait(world, chief, 22) : null,
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('h4', { style: { margin: 0 } }, BUREAU_LABEL[key], chief ? el('span', { class: 'mut', style: { fontWeight: 400, marginLeft: '7px', fontSize: '11px' } }, chief.name) : null),
            el('p', {}, chief ? bureauLine(world, key, chief) : '空位。誰も報告してこない。'),
          ),
        ),
      ));
    }
    body.appendChild(el('p', { class: 'hint' },
      '局長は数値を隠せない。歪められるのは解釈・帰属・進言だけ。'));
  }

  // ---- 推移グラフ3本
  body.appendChild(el('h3', { class: 'sec' }, '推移'));
  const h = world.history || [];
  const graphs = el('div', { class: 'cols3' },
    sparkline('人口', h.map(x => x.pop), { color: '#5fe3c4', min: 0 }),
    sparkline('産出率 / 消費', h.map(x => (x.consumption ? x.yieldRate / x.consumption : 1)), { color: '#e8b24a', min: 0 }),
    sparkline('民心', h.map(x => x.morale), { color: '#7f8ce0', min: 0, max: 1 }),
  );
  body.appendChild(graphs);
  if (world.collapsing) {
    body.appendChild(el('div', { class: 'card', style: { borderColor: '#5a2a22', background: '#1c0d0b' } },
      el('h4', { style: { color: '#f0907c' } }, '産出率が消費を下回っている'),
      el('p', {}, '唯一の崩壊条件はこれ。ゲームは負けを宣言しない。'),
    ));
  }

  // ---- 重大イベント
  body.appendChild(el('h3', { class: 'sec' }, `第 ${world.gen} 世代に起きたこと`));
  const evs = api.chronicle(world, { genMin: world.gen, kinds: BIG_KINDS, limit: 40 });
  const births = api.chronicle(world, { genMin: world.gen, kinds: ['誕生'], limit: 99 }).length;
  const deaths = api.chronicle(world, { genMin: world.gen, kinds: ['死亡'], limit: 99 }).length;
  body.appendChild(el('div', { class: 'kv', style: { marginBottom: '8px' } },
    el('div', { class: 'k' }, '生まれた'), el('div', { class: 'v' }, `${births} 体`),
    el('div', { class: 'k' }, '死んだ'), el('div', { class: 'v' }, `${deaths} 体`),
    el('div', { class: 'k' }, '人口'), el('div', { class: 'v' }, `${world.people.size} 体`),
    el('div', { class: 'k' }, '備蓄'), el('div', { class: 'v' }, num(world.food, 1)),
    el('div', { class: 'k' }, '体制怨恨'), el('div', { class: 'v' }, num(world.regimeGrudge, 2)),
  ));
  if (!evs.length) body.appendChild(el('p', { class: 'hint' }, '特筆すべきことは起きていない。「静かだった」は安全の証拠ではない。'));
  for (const e of evs.slice(0, 14)) {
    body.appendChild(el('div', { class: 'row' },
      el('div', { class: 'k' }, e.kind),
      el('div', { class: 'v', style: { fontWeight: 400, fontSize: '11.5px', textAlign: 'right', flex: 1 } }, e.text || ''),
    ));
  }

  // ---- 裁可待ち
  body.appendChild(el('h3', { class: 'sec' }, '裁可待ち'));
  const pbox = el('div');
  renderPetitions(ctx, pbox, { compact: true });
  body.appendChild(pbox);

  const m = modal({
    title: `帰還報告　第 ${world.gen} 世代`,
    sub: world.phase === PHASE.VILLAGE ? '村' : '部族',
    body,
    cls: 'wide',
    footer: [
      el('button', { class: 'btn ghost', onclick: () => m.close() }, '閉じる'),
      el('button', { class: 'btn primary', onclick: () => m.close() }, '世界を回す'),
    ],
    onClose,
  });
  ctx.reportModal = m;
  return m;
}

function bureauLine(w, key, c) {
  const G = (k) => c.genes?.[k] ?? 0.5;
  const ratio = w.consumption ? w.yieldRate / w.consumption : 1;
  const tone = G('保身') > 0.6 ? 'safe' : G('野心') > 0.6 ? 'amb' : G('誇り') > 0.65 ? 'pride' : 'plain';
  if (key === 'agri') {
    if (ratio < 0.95) return {
      safe: '「産出が落ちていますが、天候のせいです。人にはどうにもなりません。」',
      amb: '「産出が落ちています。軍務局が人を取りすぎたせいです。」',
      pride: '「問題ありません。じきに戻ります。」',
      plain: `「産出 ${num(w.yieldRate, 2)}、消費 ${num(w.consumption, 2)}。土地が痩せています。」`,
    }[tone];
    return `「畑は回っています。産出 ${num(w.yieldRate, 2)}／消費 ${num(w.consumption, 2)}。」`;
  }
  if (key === 'military') {
    const drill = w.cards?.drill?.value ?? 0;   // カードidは sim の 'drill'
    if (tone === 'amb') return `「兵の練度が足りません。模擬戦を ${drill}% では話になりません。増やさせてください。」`;
    if (tone === 'pride') return '「軍務に問題はありません。」';
    return `「模擬戦 ${drill}%。戦えるのは ${[...w.people.values()].filter(p => p.role === 'drill' || p.role === 'hunt').length} 体です。」`;
  }
  const foreign = [...w.people.values()].filter(p => p.immigrant || p.foreign).length;
  if (w.regimeGrudge > 3) return `「民心 ${pct(w.morale)}。不満を口にする者が増えています。」`;
  // 「量」ではなく混血度で言う。隔離していると外来が何体いても混ざらない。
  const mix = w.mixState ? w.mixState.admixture : 0;
  return `「民心 ${pct(w.morale)}。外来 ${foreign} 体、混血度 ${num(mix, 2)}。`
    + `混ぜるか隔てるか、そろそろ決めてください。」`;
}
