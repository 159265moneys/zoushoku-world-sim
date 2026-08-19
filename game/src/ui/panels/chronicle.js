// 画面8：年代記。事件の時系列。1件開くと上流／下流が展開される。
// ただし表示されるのはオーナーが知っている帰属であって、真の原因ではない。
// v2 には諜報局が無いので、原因系の事件は「局長が言っている帰属」で止まる。

import { el, clear, seg, toast, mount } from '../dom.js';

const KIND_GROUPS = [
  { label: 'すべて', kinds: null },
  { label: '生死', kinds: ['出生', '死亡', '成熟', '負傷', '発現'] },
  { label: '統治', kinds: ['配役', '移住', '任命', '具申可否', '正史'] },
  { label: '戦争', kinds: ['戦闘', '捕虜', '受入', '誅殺', '送還'] },
  { label: '原因不明', kinds: ['産出低下', '怨恨'] },
];

export function renderChronicle(ctx, node) {
  const { world, api, state } = ctx;
  clear(node);
  const s = state.chron ||= { group: 0, open: null };

  node.appendChild(seg(KIND_GROUPS.map((g, i) => ({ value: i, label: g.label })), s.group,
    (v) => { s.group = v; ctx.refresh(); }));

  node.appendChild(el('p', { class: 'hint' },
    world.intel >= 2 ? '諜報が真の原因を開示している。'
      : world.intel >= 1 ? '諜報が帰属に「疑わしい」の印を付けている。'
      : '諜報がない。局長が報告した帰属だけが並ぶ。嘘も含めてそのまま。'));

  const list = api.chronicle(world, { kinds: KIND_GROUPS[s.group].kinds, limit: 300 });
  if (!list.length) { node.appendChild(el('div', { class: 'empty' }, 'まだ何も起きていない。')); return; }

  let lastGen = null;
  for (const e of list) {
    if (e.gen !== lastGen) {
      lastGen = e.gen;
      node.appendChild(el('h3', { class: 'sec' }, `第 ${e.gen} 世代`));
    }
    const open = s.open === e.id;
    const card = el('div', { class: 'card click', onclick: (ev) => {
      if (ev.target.closest('button')) return;
      s.open = open ? null : e.id; ctx.refresh();
    } });
    mount(card, 
      el('div', { style: { display: 'flex', gap: '7px', alignItems: 'baseline' } },
        el('span', { class: 'tag' + (e.kind === '産出低下' ? ' bad' : e.kind === '正史' ? ' ac' : '') }, e.kind),
        el('span', { style: { flex: 1, fontSize: '11.5px' } }, e.text || ''),
      ),
      e.canon ? el('p', { class: 'hint', style: { color: '#5fe3c4' } }, `正史：${e.canon}`) : null,
    );
    if (open) card.appendChild(expand(ctx, e));
    node.appendChild(card);
  }
}

function expand(ctx, e) {
  const { world, api } = ctx;
  const box = el('div', { style: { marginTop: '8px', borderTop: '1px solid #1e2434', paddingTop: '8px' } });

  // ---- 上流
  box.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', letterSpacing: '.12em', marginBottom: '4px' } }, '上流（何が原因か）'));
  if (e.trueCause == null) {
    box.appendChild(el('p', { class: 'hint' }, 'この事件に上流はない。ここが始まり。'));
  } else if (e.revealed) {
    const up = api.traceUp(world, e.id) || [];
    if (!up.length) box.appendChild(el('p', { class: 'hint' }, '上流の記録が失われている。'));
    for (const u of up) box.appendChild(refRow(ctx, u, '←'));
  } else {
    box.appendChild(el('div', { class: 'card', style: { background: '#171207', borderColor: '#4a3c1c', margin: '0 0 6px' } },
      el('div', { class: 'tagrow', style: { marginTop: 0, marginBottom: '4px' } },
        el('span', { class: 'tag warn' }, '局長が言っている帰属'),
        world.intel >= 1 ? el('span', { class: 'tag bad' }, '疑わしい') : null),
      el('p', {}, e.claimed || '（説明がない）'),
      el('p', { class: 'hint' }, '諜報に投資していないので、これ以上は遡れない。数値は正確だが、なぜそうなったかは数字の中にない。'),
    ));
  }

  // ---- 下流
  box.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', letterSpacing: '.12em', margin: '9px 0 4px' } }, '下流（何を引き起こしたか）'));
  const down = (api.traceDown(world, e.id) || []).filter(d => d.revealed || d.kind === '正史');
  if (!down.length) box.appendChild(el('p', { class: 'hint' }, 'まだ何にも繋がっていない。3世代後に返ってくることもある。'));
  for (const d of down) box.appendChild(refRow(ctx, d, '→'));

  // ---- 影響
  if (e.effects && e.effects.length) {
    box.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', letterSpacing: '.12em', margin: '9px 0 4px' } }, '影響'));
    for (const f of e.effects) {
      box.appendChild(el('div', { class: 'row' },
        el('div', { class: 'k' }, f.field),
        el('div', { class: 'v' }, (f.delta > 0 ? '+' : '') + (+f.delta).toFixed(2))));
    }
  }

  // ---- 編む（正史の決定）
  if (api.canonize && !e.canon && (e.claimed || e.trueCause != null)) {
    box.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', letterSpacing: '.12em', margin: '11px 0 4px' } }, '編む：正史を決める'));
    box.appendChild(el('p', { class: 'hint' }, '嘘は安いが賭け。真実は高いが確定する。'));
    box.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      e.claimed ? el('button', {
        class: 'btn sm', onclick: () => {
          api.canonize(world, e.id, e.claimed, { truthful: false });
          toast('局長の言い分を正史とした。露見すれば怨恨が跳ね上がる。', 'warn');
          ctx.refresh();
        },
      }, '局長の言い分を正史とする') : null,
      el('button', {
        class: 'btn sm danger', onclick: () => {
          api.canonize(world, e.id, '調査の結果、責任は内側にあった', { truthful: true });
          toast('真実を正史とした。断罪が刻まれ、怨恨が生まれた。', 'bad');
          ctx.refresh();
        },
      }, '調べ直して真実を正史とする'),
    ));
  }
  return box;
}

function refRow(ctx, e, arrow) {
  return el('div', {
    class: 'row', style: { cursor: 'pointer' },
    onclick: (ev) => { ev.stopPropagation(); ctx.state.chron.open = e.id; ctx.refresh(); },
  },
    el('div', { class: 'k' }, `${arrow} 第${e.gen}世代 ${e.kind}`),
    el('div', { class: 'v', style: { fontWeight: 400, fontSize: '11px', textAlign: 'right', flex: 1 } }, e.text || ''),
  );
}
