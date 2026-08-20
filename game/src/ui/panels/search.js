// 「名簿」。国ぜんたいの住人の一覧。行を押すと**左の個体パネル**が開く。
//
// 1画面に1つの用件。既定は「全員を強い順に並べただけ」で、
// 絞りこみの操作は畳んでおく。開いていないフィルタは、無いのと同じ静けさになる。

import { el, clear, seg, stepper, mount } from '../dom.js';
import { ROLE, DISTRICT } from '../../core/model.js';
import { GENE_NAMES } from '../../core/genes.js';
import { portrait, training, strainName, swatchColor } from '../color.js';

const ROLE_LABEL = { idle: '無役', farm: '畑', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '子ども' };
const QUICK_GENES = ['攻撃素質', '知性', '器用', '繁殖性', '統率素質', '野心', '感受性', '従順', '頑健', '勤勉'];

export function renderSearch(ctx, node) {
  const { world, api, state } = ctx;
  clear(node);
  const f = state.search ||= {
    role: null, district: null, ageMin: 0, ageMax: 40,
    gene: null, geneMin: 60, strain: null, sort: 'power', desc: true, includeDead: false,
    open: false,
  };
  const re = () => ctx.refresh();

  // ---- 既定の1用件：並べ替え
  node.appendChild(el('h3', { class: 'sec' }, '並べ替え'));
  node.appendChild(seg([
    { value: 'power', label: '強い順' },
    { value: 'training', label: '熟練の順' },
    { value: 'age', label: '若い順' },
    { value: 'name', label: '名前の順' },
    ...(f.gene ? [{ value: f.gene, label: f.gene + 'の順' }] : []),
  ], f.sort, (v) => { f.sort = v; re(); }));

  // ---- 絞りこみは畳んでおく
  node.appendChild(el('button', {
    class: 'btn sm block', style: { marginTop: '10px' },
    onclick: () => { f.open = !f.open; re(); },
  }, f.open ? '絞りこみを閉じる' : '絞りこむ（仕事・住む場所・年齢・素質・血すじ）'));

  if (f.open) {
    const box = el('div', { style: { marginTop: '10px' } });

    box.appendChild(el('h3', { class: 'sec' }, '仕事'));
    box.appendChild(seg(
      [{ value: null, label: 'すべて' },
       ...[ROLE.IDLE, ROLE.FARM, ROLE.HUNT, ROLE.DRILL, ROLE.CHILD].map(r => ({ value: r, label: ROLE_LABEL[r] }))],
      f.role, (v) => { f.role = v; re(); }));

    box.appendChild(el('h3', { class: 'sec' }, '住む場所'));
    box.appendChild(seg(
      [{ value: null, label: 'すべて' }, { value: DISTRICT.CENTER, label: '中心' }, { value: DISTRICT.FRONTIER, label: '辺境' }],
      f.district, (v) => { f.district = v; re(); }));

    const strains = Object.keys(world.strains || { self: 1 });
    if (strains.length > 1) {
      box.appendChild(el('h3', { class: 'sec' }, '血すじ'));
      const wrap = el('div', { class: 'seg' });
      wrap.appendChild(el('button', { class: f.strain == null ? 'on' : '', onclick: () => { f.strain = null; re(); } }, 'すべて'));
      for (const k of strains) {
        wrap.appendChild(el('button', {
          class: f.strain === k ? 'on' : '', onclick: () => { f.strain = k; re(); },
          style: { display: 'flex', alignItems: 'center', gap: '6px' },
        },
          el('i', { style: { width: '10px', height: '10px', borderRadius: '50%', background: swatchColor(world, k), display: 'inline-block' } }),
          strainName(world, k)));
      }
      box.appendChild(wrap);
    }

    box.appendChild(el('h3', { class: 'sec' }, '年齢'));
    box.appendChild(el('div', { class: 'ctl' },
      stepper(f.ageMin, { min: 0, max: 40, step: 1, fmt: v => `${v}歳から`, onChange: v => { f.ageMin = v; re(); } }),
      stepper(f.ageMax, { min: 0, max: 60, step: 1, fmt: v => `${v}歳まで`, onChange: v => { f.ageMax = v; re(); } }),
    ));

    box.appendChild(el('h3', { class: 'sec' }, '素質のしきい値'));
    const gwrap = el('div', { class: 'seg' });
    gwrap.appendChild(el('button', { class: f.gene == null ? 'on' : '', onclick: () => { f.gene = null; re(); } }, '指定なし'));
    for (const g of QUICK_GENES) {
      gwrap.appendChild(el('button', { class: f.gene === g ? 'on' : '', onclick: () => { f.gene = g; re(); } }, g));
    }
    box.appendChild(gwrap);
    if (f.gene) {
      box.appendChild(el('div', { class: 'ctl', style: { marginTop: '8px' } },
        el('input', {
          type: 'range', min: 0, max: 100, step: 5, value: f.geneMin,
          oninput: (e) => { f.geneMin = +e.target.value; re(); },
        }),
        el('span', { class: 'mono', style: { minWidth: '48px', textAlign: 'right', fontWeight: '700' } }, `${f.geneMin}以上`),
      ));
    }

    box.appendChild(el('div', { class: 'ctl', style: { marginTop: '12px' } },
      el('button', { class: 'btn sm', onclick: () => { f.desc = !f.desc; re(); } }, f.desc ? '大きい順 ▼' : '小さい順 ▲'),
      el('button', { class: 'btn sm', onclick: () => { f.includeDead = !f.includeDead; re(); } },
        f.includeDead ? '死んだ者も出す' : '生きている者だけ'),
    ));
    node.appendChild(box);
  }

  // ---- 結果
  const res = api.search(world, { ...f, geneMin: f.geneMin / 100 });
  node.appendChild(el('h3', { class: 'sec' }, `名簿　${res.length}体`,
    el('small', {}, '押すと左にその一体が出る')));
  for (const p of res.slice(0, 150)) {
    const val = f.sort === 'training' ? `熟練${Math.round(training(p) * 100)}`
      : f.sort === 'age' ? `${p.age}歳`
      : GENE_NAMES.includes(f.sort) ? `${f.sort}${Math.round((p.genes[f.sort] ?? 0) * 100)}`
      : (api.powerOf ? `強さ${Math.round(api.powerOf(p) * 100)}` : '');
    node.appendChild(el('div', {
      class: 'chip' + (state.selected === p.id ? ' on' : ''),
      onclick: () => ctx.select(p.id),
    },
      portrait(world, p, 26),
      el('div', { class: 'nm' }, p.name, !p.alive ? el('span', { class: 'mut' }, '（故）') : null),
      el('div', { class: 'mt' }, `${p.age}歳 ・ ${ROLE_LABEL[p.role] || p.role} ・ ${val}`),
    ));
  }
  if (!res.length) node.appendChild(el('div', { class: 'empty' }, '当てはまる者はいない。'));
}
