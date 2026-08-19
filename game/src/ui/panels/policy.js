// 「敷く」：方針カード。名前つきカード ＋ 数値 ＋ オン/オフ。
// 文字入力は一切なし。数値はステッパーとスライダーだけ。

import { el, clear, toggle, stepper } from '../dom.js';
import { CARDS } from '../cards.js';
import { BUREAU_LABEL } from '../../core/model.js';

export function renderPolicy(ctx, node) {
  const { world, api } = ctx;
  clear(node);

  node.appendChild(el('p', { class: 'hint' },
    'オーナーが決めるのはカードと数値まで。その先の運用は局長の人格を通ってから実際の動きになる。'));

  const list = (api.CARDS && Array.isArray(api.CARDS)) ? api.CARDS : CARDS;
  const groups = {};
  for (const c of list) (groups[c.bureau] ||= []).push(c);

  for (const key in groups) {
    node.appendChild(el('h3', { class: 'sec' }, BUREAU_LABEL[key] || key));
    for (const c of groups[key]) {
      const cur = world.cards?.[c.id] || { on: c.on, value: c.def };
      const card = el('div', { class: 'card' + (c.flagship ? ' flagship' : '') });
      if (c.flagship) card.style.borderColor = '#3aa88f';

      const head = el('div', { class: 'ctl', style: { justifyContent: 'space-between' } },
        el('h4', { style: { margin: '0', flex: '1' } }, c.name),
        toggle(cur.on, (on) => { api.setCard(world, c.id, on, world.cards[c.id]?.value ?? c.def); ctx.refresh(); }),
      );
      card.append(head, el('p', {}, c.desc));

      if (c.max > c.min) {
        const valLabel = el('span', { class: 'mono', style: { minWidth: '46px', textAlign: 'right' } },
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
        card.appendChild(el('div', { class: 'ctl', style: { marginTop: '7px' } },
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

  node.appendChild(el('h3', { class: 'sec' }, 'まだ手に入っていない動詞'));
  node.appendChild(el('div', { class: 'tagrow' },
    el('span', { class: 'tag' }, '配る（予算配分）'),
    el('span', { class: 'tag' }, '殺す（粛清）'),
    el('span', { class: 'tag' }, 'ぶつける（宣戦の常設化）'),
  ));
  node.appendChild(el('p', { class: 'hint' }, 'この3つはフェーズ3以降。いまは枠だけ。'));
}
