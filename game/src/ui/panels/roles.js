// 画面4：配役（P1のみ）。ドラッグ不要、クリックだけ。
// フェーズ2に入ると「自分で配役する」ボタンは消え、人事（局長の任命）に置き換わる。
// これは解禁ではなく喪失。

import { el, clear, toast, num } from '../dom.js';
import { ROLE, DISTRICT, PHASE, BUREAU, BUREAU_LABEL } from '../../core/model.js';
import { portrait, training } from '../color.js';

const SLOTS = [
  { role: ROLE.HUNT,  name: '狩り',   desc: '産出しつつ武力の練度が伸びる。傷を負うことがある。' },
  { role: ROLE.FARM,  name: '畑',     desc: '産出の本体。器用と勤勉が効く。' },
  { role: ROLE.DRILL, name: '模擬戦', desc: '産出しないが安全に練度が伸びる。' },
  { role: ROLE.IDLE,  name: '無役',   desc: '消費するが産出しない。私欲と怠惰が育つ。' },
];

export function renderRoles(ctx, node) {
  const { world } = ctx;
  clear(node);
  if (world.phase === PHASE.VILLAGE) renderCasting(ctx, node);
  else renderAppointments(ctx, node);
}

// ------------------------------------------------------------------ P1：配役
function renderCasting(ctx, node) {
  const { world, api, state } = ctx;
  node.appendChild(el('p', { class: 'hint' },
    '一体を選んでから置き場所を押す。10体を超えると、この画面は消える。'));

  const people = [...world.people.values()].filter(p => p.role !== ROLE.CHILD);
  const children = [...world.people.values()].filter(p => p.role === ROLE.CHILD);

  let picked = state.castPick ?? null;
  if (picked != null && !world.people.has(picked)) picked = state.castPick = null;

  const chip = (p) => el('div', {
    class: 'chip' + (picked === p.id ? ' on' : ''),
    onclick: () => { state.castPick = (picked === p.id ? null : p.id); ctx.select(p.id, false); ctx.refresh(); },
  },
    portrait(world, p, 22),
    el('div', { class: 'nm' }, p.name),
    el('div', { class: 'mt' }, `${p.age}歳 練${Math.round(training(p) * 100)}`),
  );

  for (const s of SLOTS) {
    const here = people.filter(p => p.role === s.role);
    const card = el('div', { class: 'card' });
    card.append(
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        el('h4', {}, `${s.name}　${here.length}`),
        picked != null && world.people.get(picked)?.role !== s.role
          ? el('button', {
              class: 'btn sm', onclick: () => {
                api.assignRole(world, picked, s.role);
                toast(`${world.people.get(picked).name} を ${s.name} へ`);
                ctx.refresh();
              },
            }, 'ここへ置く')
          : null,
      ),
      el('p', {}, s.desc),
    );
    for (const p of here) card.appendChild(chip(p));
    if (!here.length) card.appendChild(el('div', { class: 'hint' }, '誰もいない'));
    node.appendChild(card);
  }

  // 居住区
  node.appendChild(el('h3', { class: 'sec' }, '居住区（環境係数）'));
  node.appendChild(el('p', { class: 'hint' }, '辺境は練度の伸びがよい。才能の産地は辺境と貧民街。'));
  for (const d of [DISTRICT.CENTER, DISTRICT.FRONTIER]) {
    const here = people.concat(children).filter(p => p.district === d);
    const card = el('div', { class: 'card' });
    card.append(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      el('h4', {}, `${d === DISTRICT.CENTER ? '中心' : '辺境'}　${here.length}`),
      picked != null && world.people.get(picked)?.district !== d
        ? el('button', { class: 'btn sm', onclick: () => { api.setDistrict(world, picked, d); ctx.refresh(); } }, 'ここへ移す')
        : null,
    ));
    node.appendChild(card);
  }

  if (children.length) {
    node.appendChild(el('h3', { class: 'sec' }, `幼体　${children.length}`));
    node.appendChild(el('p', { class: 'hint' }, '発現ウィンドウの中にいる。まだ置けない。'));
    for (const p of children) node.appendChild(chip(p));
  }
}

// ------------------------------------------------------------------ P2：人事
function renderAppointments(ctx, node) {
  const { world, api, state } = ctx;

  node.appendChild(el('div', { class: 'card', style: { borderColor: '#4a3c1c', background: '#1a1508' } },
    el('h4', {}, '配役の画面は消えた'),
    el('p', {}, '100体は手で置けない。誰を局長に据えるかだけが、あなたの手に残っている。'
      + '能力で決まる大量配役は局長がやる。忠誠が能力より重い人事だけをあなたがやる。'),
  ));

  const cands = [...world.people.values()]
    .filter(p => p.role !== ROLE.CHILD && p.age >= 3)
    .sort((a, b) => (api.powerOf ? api.powerOf(b) - api.powerOf(a) : b.age - a.age));

  for (const key of [BUREAU.MILITARY, BUREAU.AGRI, BUREAU.CIVIL]) {
    const cur = world.bureaus[key] ? world.people.get(world.bureaus[key]) : null;
    const card = el('div', { class: 'card' });
    card.append(el('h4', {}, BUREAU_LABEL[key]));
    if (cur) {
      card.append(
        el('div', { class: 'chip on', onclick: () => ctx.select(cur.id) },
          portrait(world, cur, 22), el('div', { class: 'nm' }, cur.name),
          el('div', { class: 'mt' }, `${cur.age}歳`)),
        el('div', { class: 'kv', style: { marginTop: '5px' } },
          el('div', { class: 'k' }, '野心'), el('div', { class: 'v' }, Math.round((cur.genes.野心 ?? .5) * 100)),
          el('div', { class: 'k' }, '知性'), el('div', { class: 'v' }, Math.round((cur.genes.知性 ?? .5) * 100)),
          el('div', { class: 'k' }, '保身'), el('div', { class: 'v' }, Math.round((cur.genes.保身 ?? .5) * 100)),
          el('div', { class: 'k' }, '誇り'), el('div', { class: 'v' }, Math.round((cur.genes.誇り ?? .5) * 100)),
          el('div', { class: 'k' }, '個人怨恨'), el('div', { class: 'v' }, num(cur.grudges?.[-1] || 0, 2)),
        ),
        el('p', { class: 'hint' }, riskLine(cur)),
      );
    } else {
      card.append(el('p', {}, '空位。誰も報告してこない。'));
    }
    const open = state.openBureau === key;
    card.appendChild(el('button', {
      class: 'btn sm', style: { marginTop: '6px' },
      onclick: () => { state.openBureau = open ? null : key; ctx.refresh(); },
    }, open ? '閉じる' : (cur ? '据え替える' : '任命する')));
    if (open) {
      const list = el('div', { style: { marginTop: '6px', maxHeight: '210px', overflowY: 'auto' } });
      for (const p of cands.slice(0, 24)) {
        list.appendChild(el('div', {
          class: 'chip', onclick: () => {
            api.appointBureau(world, key, p.id);
            state.openBureau = null;
            toast(`${p.name} を ${BUREAU_LABEL[key]}長に据えた`);
            ctx.refresh();
          },
        }, portrait(world, p, 20), el('div', { class: 'nm' }, p.name),
          el('div', { class: 'mt' }, `野心${Math.round((p.genes.野心 ?? .5) * 100)} 知性${Math.round((p.genes.知性 ?? .5) * 100)}`)));
      }
      card.appendChild(list);
    }
    node.appendChild(card);
  }

  node.appendChild(el('p', { class: 'hint' },
    '賢い部下は有能で危険。愚かな部下は安全で無能。任命は神の実在を教えることでもある。'));
}

function riskLine(c) {
  const a = c.genes.野心 ?? .5, i = c.genes.知性 ?? .5;
  if (a > 0.6 && i > 0.6) return '最強かつ最悪。見えていても、代わりがいないなら選ばざるを得ない。';
  if (a > 0.6) return '危険だが下手。管理はできる。';
  if (i > 0.6) return '有能で忠実。理想だが希少。';
  return '安全だが凡庸。正確だが遅い。';
}
