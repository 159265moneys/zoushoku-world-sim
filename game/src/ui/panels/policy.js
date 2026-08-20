// 「きまり」（動詞：敷く）。国ぜんたいにかかる常設のルール。
// 文字入力は一切なし。数値はスライダーとステッパーだけ。
//
// 局の名前（軍務局／農業局／民生局）で括ると、局が1つも無い村フェーズで
// 「存在しないものの設定」に見える。何にかかるきまりなのかで括る。

import { el, clear, toggle, stepper, mount } from '../dom.js';
import { CARDS } from '../cards.js';
import { PHASE } from '../../core/model.js';

const GROUP = {
  military: { title: '戦いのきまり', note: '誰を戦場に出すか。降りるかどうか。' },
  agri: { title: '食べ物のきまり', note: '畑にどれだけ人を回すか。備蓄をどこで守るか。' },
  civil: { title: '暮らしのきまり', note: 'よそ者を混ぜるか隔てるか。子どもと傷病者をどう扱うか。' },
};

export function renderPolicy(ctx, node) {
  const { world, api } = ctx;
  clear(node);

  node.appendChild(el('div', { class: 'lead-note' },
    world.phase === PHASE.VILLAGE
      ? 'ここで決めたきまりは、ずっと効き続ける。いま村を動かしているのはあなた自身なので、効き目はそのまま出る。'
      : 'ここで決めたきまりは、ずっと効き続ける。ただし実際に動かすのは局の長なので、その人柄を通ってから効く。'));

  const list = (api.CARDS && Array.isArray(api.CARDS)) ? api.CARDS : CARDS;
  const groups = {};
  for (const c of list) (groups[c.bureau] ||= []).push(c);

  for (const key in groups) {
    const g = GROUP[key] || { title: key, note: '' };
    node.appendChild(el('h3', { class: 'sec' }, g.title, g.note ? el('small', {}, g.note) : null));

    for (const c of groups[key]) {
      const cur = world.cards?.[c.id] || { on: c.on, value: c.def };
      const card = el('div', { class: 'card' });
      if (c.flagship) card.style.borderColor = 'var(--ac2)';

      mount(card,
        el('div', { class: 'ctl', style: { justifyContent: 'space-between' } },
          el('h4', { style: { margin: '0', flex: '1' } }, c.name),
          toggle(cur.on, (on) => { api.setCard(world, c.id, on, world.cards[c.id]?.value ?? c.def); ctx.refresh(); }),
        ),
        el('p', {}, c.desc));

      if (c.max > c.min) {
        const valLabel = el('span', { class: 'mono', style: { minWidth: '58px', textAlign: 'right', fontWeight: '700', fontSize: '15px' } },
          `${cur.value}${c.unit}`);
        const range = el('input', {
          type: 'range', min: c.min, max: c.max, step: c.step, value: cur.value,
          disabled: !cur.on,
          oninput: (e) => {
            const v = +e.target.value;
            valLabel.textContent = `${v}${c.unit}`;
            api.setCard(world, c.id, world.cards[c.id]?.on ?? c.on, v);
          },
        });
        card.appendChild(el('div', { class: 'ctl', style: { marginTop: '9px' } },
          range,
          valLabel,
          stepper(cur.value, {
            min: c.min, max: c.max, step: c.step,
            fmt: (v) => `${v}${c.unit}`,
            onChange: (v) => {
              range.value = v; valLabel.textContent = `${v}${c.unit}`;
              api.setCard(world, c.id, world.cards[c.id]?.on ?? c.on, v);
            },
          }),
        ));
      }
      node.appendChild(card);
    }
  }

  // v2 では枠だけ。押せないものを押せそうな見た目で並べない（カードにしない）。
  node.appendChild(el('h3', { class: 'sec' }, 'まだ使えない手', el('small', {}, '先のフェーズで開く')));
  node.appendChild(el('div', { class: 'tagrow' },
    el('span', { class: 'tag' }, '配る（予算をふり分ける）'),
    el('span', { class: 'tag' }, '殺す（粛清する）'),
    el('span', { class: 'tag' }, 'ぶつける（戦を常設にする）'),
  ));
}
