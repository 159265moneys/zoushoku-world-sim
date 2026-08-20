// 「仕事」（P1）／「長を選ぶ」（P2）。国ぜんたいにかかる画面。
// 一体の中身を見たいときは、円かチップを押すと**左の個体パネル**が開く。
// この画面自体は「誰をどこに置くか」だけを扱う。

import { el, clear, toast, mount } from '../dom.js';
import { ROLE, DISTRICT, PHASE, BUREAU, BUREAU_LABEL } from '../../core/model.js';
import { portrait, training } from '../color.js';

const SLOTS = [
  { role: ROLE.FARM, name: '畑', desc: '食べ物を作る。ここが薄いと飢える。' },
  { role: ROLE.HUNT, name: '狩り', desc: '食べ物を作りながら戦いの腕も伸びる。ケガをする。' },
  { role: ROLE.DRILL, name: '模擬戦', desc: '食べ物は作らないが、安全に戦いの腕が伸びる。' },
  { role: ROLE.IDLE, name: '無役', desc: '食べるだけで何も作らない。ここに置いたままにしない。' },
];

export function renderRoles(ctx, node) {
  const { world } = ctx;
  clear(node);
  if (world.phase === PHASE.VILLAGE) renderCasting(ctx, node);
  else renderAppointments(ctx, node);
}

// ------------------------------------------------------------------ P1：仕事
function renderCasting(ctx, node) {
  const { world, api, state } = ctx;

  const people = [...world.people.values()].filter(p => p.role !== ROLE.CHILD);
  const children = [...world.people.values()].filter(p => p.role === ROLE.CHILD);

  let picked = state.castPick ?? null;
  if (picked != null && !world.people.has(picked)) picked = state.castPick = null;
  const pickedInd = picked != null ? world.people.get(picked) : null;

  node.appendChild(el('div', { class: 'lead-note' },
    pickedInd
      ? `${pickedInd.name} を選んでいる。置きたい場所の「ここへ置く」を押す。`
      : '① 名前を押して選ぶ　→　② 置きたい場所の「ここへ置く」を押す'));

  for (const s of SLOTS) {
    const here = people.filter(p => p.role === s.role);
    const card = el('div', { class: 'card' });
    mount(card,
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        el('h4', { style: { margin: 0 } }, `${s.name}　${here.length}体`),
        pickedInd && pickedInd.role !== s.role
          ? el('button', {
              class: 'btn primary sm', onclick: () => {
                api.assignRole(world, picked, s.role);
                toast(`${world.people.get(picked).name} を ${s.name} へ`);
                ctx.refresh();
              },
            }, 'ここへ置く')
          : null,
      ),
      el('p', {}, s.desc),
    );
    for (const p of here) card.appendChild(chip(ctx, p, picked));
    if (!here.length) card.appendChild(el('div', { class: 'hint' }, 'いま誰もいない'));
    node.appendChild(card);
  }

  // 住む場所
  node.appendChild(el('h3', { class: 'sec' }, '住む場所', el('small', {}, '辺境のほうが腕が伸びる')));
  for (const d of [DISTRICT.CENTER, DISTRICT.FRONTIER]) {
    const here = people.concat(children).filter(p => p.district === d);
    node.appendChild(el('div', { class: 'card' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        el('h4', { style: { margin: 0 } }, `${d === DISTRICT.CENTER ? '中心' : '辺境'}　${here.length}体`),
        pickedInd && pickedInd.district !== d
          ? el('button', { class: 'btn sm', onclick: () => { api.setDistrict(world, picked, d); ctx.refresh(); } }, 'ここへ移す')
          : null,
      )));
  }

  if (children.length) {
    node.appendChild(el('h3', { class: 'sec' }, `子ども　${children.length}体`,
      el('small', {}, 'まだ置けない。育つと出てくる')));
    for (const p of children) node.appendChild(chip(ctx, p, picked));
  }
}

function chip(ctx, p, picked) {
  const { world, state } = ctx;
  return el('div', {
    class: 'chip' + (picked === p.id ? ' on' : ''),
    onclick: () => { state.castPick = (picked === p.id ? null : p.id); ctx.select(p.id); },
  },
    portrait(world, p, 26),
    el('div', { class: 'nm' }, p.name),
    el('div', { class: 'mt' }, `${p.age}歳 ・ 熟練${Math.round(training(p) * 100)}`),
  );
}

// ------------------------------------------------------------------ P2：長を選ぶ
function renderAppointments(ctx, node) {
  const { world, api, state } = ctx;

  node.appendChild(el('div', { class: 'lead-note' },
    '一体ずつ仕事を決めることはもう出来ない。あなたが決めるのは、3つの局の長だけ。'
    + '長がいない局からは、報告も願いも来ない。'));

  const cands = [...world.people.values()]
    .filter(p => p.role !== ROLE.CHILD && p.age >= 3)
    .sort((a, b) => (api.powerOf ? api.powerOf(b) - api.powerOf(a) : b.age - a.age));

  const WHAT = {
    military: '戦いの采配。誰を戦場に出すかを決める。',
    agri: '食べ物の采配。畑と狩りの割りふりを決める。',
    civil: '暮らしの采配。よそ者を混ぜるか隔てるかを決める。',
  };

  for (const key of [BUREAU.MILITARY, BUREAU.AGRI, BUREAU.CIVIL]) {
    const cur = world.bureaus[key] ? world.people.get(world.bureaus[key]) : null;
    const card = el('div', { class: 'card' });
    mount(card,
      el('h4', {}, BUREAU_LABEL[key], cur ? null : el('span', { class: 'tag bad', style: { marginLeft: '8px' } }, '空席')),
      el('p', {}, WHAT[key]));

    if (cur) {
      mount(card,
        el('div', { class: 'chip on', onclick: () => ctx.select(cur.id) },
          portrait(world, cur, 26), el('div', { class: 'nm' }, cur.name),
          el('div', { class: 'mt' }, `${cur.age}歳`)),
        el('p', { class: 'hint' }, riskLine(cur)),
      );
    }

    const open = state.openBureau === key;
    card.appendChild(el('button', {
      class: 'btn ' + (cur ? 'sm' : 'primary'), style: { marginTop: '8px' },
      onclick: () => { state.openBureau = open ? null : key; ctx.refresh(); },
    }, open ? '閉じる' : (cur ? '別の者に替える' : '長を選ぶ')));

    if (open) {
      const list = el('div', { style: { marginTop: '8px', maxHeight: '260px', overflowY: 'auto' } });
      list.appendChild(el('p', { class: 'hint' }, '強い順。野心が高い者ほど有能で、同時に危険。'));
      for (const p of cands.slice(0, 24)) {
        list.appendChild(el('div', {
          class: 'chip', onclick: () => {
            api.appointBureau(world, key, p.id);
            state.openBureau = null;
            toast(`${p.name} を ${BUREAU_LABEL[key]}長にした`);
            ctx.refresh();
          },
        }, portrait(world, p, 24), el('div', { class: 'nm' }, p.name),
          el('div', { class: 'mt' }, `野心${Math.round((p.genes.野心 ?? .5) * 100)}　知性${Math.round((p.genes.知性 ?? .5) * 100)}`)));
      }
      card.appendChild(list);
    }
    node.appendChild(card);
  }
}

function riskLine(c) {
  const a = c.genes.野心 ?? .5, i = c.genes.知性 ?? .5;
  if (a > 0.6 && i > 0.6) return '有能。そして危険。野心も頭も高いので、いずれ上を狙う。';
  if (a > 0.6) return '危険だが下手。野心はあるが頭が回らない。監視はしやすい。';
  if (i > 0.6) return '有能で忠実。理想的だが、めったにいない。';
  return '安全だが凡庸。間違えないが、伸びもしない。';
}
