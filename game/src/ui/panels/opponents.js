// 画面11：対戦相手の選択。
// 通常は国力しか見せない。構成・人口・思想は伏せる。
// 濁った数字ひとつで相手を選び、実際の勝負は中身で決まる。
// 開発用のデバッグトグルを付けてあり、オンにすると思想名・人口・血統の色・内訳が見える。

import { el, clear, modal, num } from '../dom.js';
import { lineageHue, swatchColor, strainName } from '../color.js';

export function openOpponents(ctx, onPick) {
  const { world, api, state } = ctx;
  const body = el('div');
  const dbg = () => !!state.rosterDebug;

  const mine = api.nationPower ? api.nationPower(world) : 0;
  const list = api.listOpponents ? api.listOpponents(state.roster) : [];

  const render = () => {
    clear(body);

    body.appendChild(el('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      dot(world.strains.self.hue, 22),
      el('div', { style: { flex: 1 } },
        el('h4', { style: { margin: 0 } }, world.name),
        el('p', {}, `第 ${world.gen} 世代 ・ ${world.people.size} 体`)),
      el('div', { style: { textAlign: 'right' } },
        el('div', { class: 'mut', style: { fontSize: '10px' } }, '国力'),
        el('div', { class: 'big' }, mine)),
    ));

    body.appendChild(el('div', { class: 'ctl', style: { justifyContent: 'space-between', margin: '10px 0 6px' } },
      el('div', { class: 'mut', style: { fontSize: '10.5px' } },
        dbg() ? '開発用デバッグ：内訳を開示している' : '相手について見えるのは国力だけ。構成も人口も思想も伏せられている。'),
      el('button', {
        class: 'btn sm' + (dbg() ? ' primary' : ''),
        onclick: () => { state.rosterDebug = !dbg(); render(); },
      }, dbg() ? 'デバッグ表示 ON' : 'デバッグ表示 OFF'),
    ));

    if (!list.length) {
      body.appendChild(el('div', { class: 'empty' }, 'ロスターが無い。ゴースト（乱数生成の相手）と戦う。'));
      body.appendChild(el('button', {
        class: 'btn primary block', onclick: () => { m.close(); onPick(null); },
      }, 'ゴーストに宣戦布告する'));
      return;
    }

    for (const o of list) {
      const gap = mine ? o.power / mine : 1;
      const label = gap > 1.35 ? '格上' : gap > 1.08 ? 'やや格上' : gap > 0.92 ? '互角' : gap > 0.7 ? 'やや格下' : '格下';
      const cls = gap > 1.08 ? 'bad' : gap > 0.92 ? 'warn' : 'ac';

      const card = el('div', { class: 'card' });
      card.append(el('div', { style: { display: 'flex', alignItems: 'center', gap: '11px' } },
        dot(o.hue, 20),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('h4', { style: { margin: 0 } }, o.name),
          el('p', {}, dbg()
            ? `${o.profileName}　${o.profileDesc}`
            : '思想・人口・構成は不明。'),
        ),
        el('div', { style: { textAlign: 'right', minWidth: '84px' } },
          el('div', { class: 'mut', style: { fontSize: '10px' } }, '国力'),
          el('div', { class: 'rank' }, o.power),
          el('span', { class: 'tag ' + cls }, label)),
        el('button', { class: 'btn', onclick: () => { m.close(); onPick(o); } }, '宣戦布告'),
      ));

      // 混ざるとどうなるかを色で見せる
      card.appendChild(el('div', { class: 'ctl', style: { marginTop: '7px', gap: '9px' } },
        el('span', { class: 'mut', style: { fontSize: '10px' } }, '混ざると'),
        dot(world.strains.self.hue, 13), el('span', { class: 'mut' }, '＋'), dot(o.hue, 13),
        el('span', { class: 'mut' }, '→'), dot(blend(world.strains.self.hue, o.hue), 15),
        el('span', { class: 'mut' }, '→'), dot(blend(world.strains.self.hue, blend(world.strains.self.hue, o.hue)), 13),
        el('span', { class: 'mut', style: { fontSize: '10px' } }, '（世代が進むほど中間色が増える）'),
      ));

      if (dbg()) {
        const w2 = api.peek ? api.peek(state.roster, o.id) : o.world;
        if (w2) {
          const mix = strainMix(w2);
          card.appendChild(el('div', { class: 'kv', style: { marginTop: '7px' } },
            el('div', { class: 'k' }, '人口'), el('div', { class: 'v' }, w2.people.size),
            el('div', { class: 'k' }, '世代'), el('div', { class: 'v' }, w2.gen),
            el('div', { class: 'k' }, '備蓄'), el('div', { class: 'v' }, num(w2.food, 1)),
            el('div', { class: 'k' }, '民心'), el('div', { class: 'v' }, num(w2.morale, 2)),
            el('div', { class: 'k' }, '産出/消費'), el('div', { class: 'v' }, num(w2.consumption ? w2.yieldRate / w2.consumption : 1, 2)),
            el('div', { class: 'k' }, '体制怨恨'), el('div', { class: 'v' }, num(w2.regimeGrudge, 2)),
          ));
          const bar = el('div', { style: { display: 'flex', height: '9px', borderRadius: '5px', overflow: 'hidden', marginTop: '6px' } });
          for (const [k, v] of mix) {
            bar.appendChild(el('div', { style: { width: (v * 100) + '%', background: swatchColor(w2, k) } }));
          }
          card.append(bar, el('div', { class: 'mut', style: { fontSize: '10px', marginTop: '3px' } },
            mix.map(([k, v]) => `${strainName(w2, k)} ${Math.round(v * 100)}%`).join(' / ')));
          // 実際の個体の色を並べる
          const strip = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '6px' } });
          for (const p of [...w2.people.values()].slice(0, 40)) {
            strip.appendChild(dot(lineageHue(w2, p.lineage), 11));
          }
          card.appendChild(strip);
        }
      }
      body.appendChild(card);
    }

    body.appendChild(el('p', { class: 'hint' },
      '国力はマッチングの目安であって、戦闘の入力ではない。国力が上でも、編成と派遣を間違えれば負ける。'));
  };

  const m = modal({ title: '隣のシャーレ', sub: '相手を選ぶ', body, cls: 'wide' });
  render();
  return m;
}

function dot(hue, size) {
  return el('i', {
    style: {
      width: size + 'px', height: size + 'px', borderRadius: '50%', display: 'inline-block',
      background: `hsl(${hue} 70% 52%)`, flex: '0 0 auto',
      boxShadow: '0 0 0 1px rgba(255,255,255,.12)',
    },
  });
}

function blend(a, b) {
  const ra = a * Math.PI / 180, rb = b * Math.PI / 180;
  let d = Math.atan2(Math.sin(ra) + Math.sin(rb), Math.cos(ra) + Math.cos(rb)) * 180 / Math.PI;
  return d < 0 ? d + 360 : d;
}

function strainMix(w) {
  const acc = {};
  let n = 0;
  for (const p of w.people.values()) {
    const L = p.lineage || { self: 1 };
    for (const k in L) acc[k] = (acc[k] || 0) + L[k];
    n++;
  }
  return Object.entries(acc).map(([k, v]) => [k, v / (n || 1)]).sort((a, b) => b[1] - a[1]);
}
