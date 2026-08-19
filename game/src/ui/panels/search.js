// 画面7：検索。素質・年齢・役割・居住区でフィルタ。ソート。結果クリックで個体パネル。
// 「欠けているのはアクセスではなく、注意と統合」——検索UIは本物の技能。
// 文字入力は無し。すべてクリックとスライダー。

import { el, clear, seg, stepper } from '../dom.js';
import { ROLE, DISTRICT, SKILLS } from '../../core/model.js';
import { GENE_NAMES } from '../../core/genes.js';
import { portrait, training, strainName, swatchColor } from '../color.js';

const ROLE_LABEL = { idle: '無役', farm: '畑', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '幼体' };
const QUICK_GENES = ['攻撃素質', '知性', '器用', '繁殖性', '統率素質', '野心', '感受性', '従順', '頑健', '勤勉'];

export function renderSearch(ctx, node) {
  const { world, api, state } = ctx;
  clear(node);
  const f = state.search ||= {
    role: null, district: null, ageMin: 0, ageMax: 40,
    gene: null, geneMin: 60, strain: null, sort: 'power', desc: true, includeDead: false,
  };
  const re = () => ctx.refresh();

  node.appendChild(el('h3', { class: 'sec' }, '役割'));
  node.appendChild(seg(
    [{ value: null, label: 'すべて' },
     ...[ROLE.IDLE, ROLE.FARM, ROLE.HUNT, ROLE.DRILL, ROLE.CHILD].map(r => ({ value: r, label: ROLE_LABEL[r] }))],
    f.role, (v) => { f.role = v; re(); }));

  node.appendChild(el('h3', { class: 'sec' }, '居住区'));
  node.appendChild(seg(
    [{ value: null, label: 'すべて' }, { value: DISTRICT.CENTER, label: '中心' }, { value: DISTRICT.FRONTIER, label: '辺境' }],
    f.district, (v) => { f.district = v; re(); }));

  const strains = Object.keys(world.strains || { self: 1 });
  if (strains.length > 1) {
    node.appendChild(el('h3', { class: 'sec' }, '血統（主たる出自）'));
    const wrap = el('div', { class: 'seg' });
    wrap.appendChild(el('button', { class: f.strain == null ? 'on' : '', onclick: () => { f.strain = null; re(); } }, 'すべて'));
    for (const k of strains) {
      wrap.appendChild(el('button', {
        class: f.strain === k ? 'on' : '', onclick: () => { f.strain = k; re(); },
        style: { display: 'flex', alignItems: 'center', gap: '5px' },
      },
        el('i', { style: { width: '8px', height: '8px', borderRadius: '50%', background: swatchColor(world, k), display: 'inline-block' } }),
        strainName(world, k)));
    }
    node.appendChild(wrap);
  }

  node.appendChild(el('h3', { class: 'sec' }, '年齢'));
  node.appendChild(el('div', { class: 'ctl' },
    stepper(f.ageMin, { min: 0, max: 40, step: 1, fmt: v => `${v}歳〜`, onChange: v => { f.ageMin = v; re(); } }),
    stepper(f.ageMax, { min: 0, max: 60, step: 1, fmt: v => `〜${v}歳`, onChange: v => { f.ageMax = v; re(); } }),
  ));

  node.appendChild(el('h3', { class: 'sec' }, '素質のしきい値'));
  const gwrap = el('div', { class: 'seg' });
  gwrap.appendChild(el('button', { class: f.gene == null ? 'on' : '', onclick: () => { f.gene = null; re(); } }, '指定なし'));
  for (const g of QUICK_GENES) {
    gwrap.appendChild(el('button', { class: f.gene === g ? 'on' : '', onclick: () => { f.gene = g; re(); } }, g));
  }
  node.appendChild(gwrap);
  if (f.gene) {
    node.appendChild(el('div', { class: 'ctl', style: { marginTop: '6px' } },
      el('input', {
        type: 'range', min: 0, max: 100, step: 5, value: f.geneMin,
        oninput: (e) => { f.geneMin = +e.target.value; re(); },
      }),
      el('span', { class: 'mono', style: { minWidth: '38px', textAlign: 'right' } }, `${f.geneMin}+`),
    ));
  }

  node.appendChild(el('h3', { class: 'sec' }, '並べ替え'));
  node.appendChild(seg([
    { value: 'power', label: '国民力' },
    { value: 'training', label: '練度' },
    { value: 'age', label: '年齢' },
    { value: 'name', label: '名前' },
    ...(f.gene ? [{ value: f.gene, label: f.gene }] : []),
  ], f.sort, (v) => { f.sort = v; re(); }));
  node.appendChild(el('div', { class: 'ctl', style: { marginTop: '6px' } },
    el('button', { class: 'btn sm', onclick: () => { f.desc = !f.desc; re(); } }, f.desc ? '降順 ▼' : '昇順 ▲'),
    el('button', { class: 'btn sm', onclick: () => { f.includeDead = !f.includeDead; re(); } },
      f.includeDead ? '故人を含む' : '生存のみ'),
  ));

  node.appendChild(el('p', { class: 'hint' },
    '国民力に忠誠は入っていない。この順に並べて上から取ると、危険な天才が先に来る。'));

  const res = api.search(world, { ...f, geneMin: f.geneMin / 100 });
  node.appendChild(el('h3', { class: 'sec' }, `結果　${res.length}体`));
  for (const p of res.slice(0, 150)) {
    const val = f.sort === 'training' ? Math.round(training(p) * 100)
      : f.sort === 'age' ? p.age
      : GENE_NAMES.includes(f.sort) ? Math.round((p.genes[f.sort] ?? 0) * 100)
      : (api.powerOf ? Math.round(api.powerOf(p)) : '');
    node.appendChild(el('div', {
      class: 'chip' + (state.selected === p.id ? ' on' : ''),
      onclick: () => ctx.select(p.id),
    },
      portrait(world, p, 22),
      el('div', { class: 'nm' }, p.name, !p.alive ? el('span', { class: 'mut' }, '（故）') : null),
      el('div', { class: 'mt' }, `${p.age}歳 · ${ROLE_LABEL[p.role] || p.role} · ${val}`),
    ));
  }
  if (!res.length) node.appendChild(el('div', { class: 'empty' }, '該当なし。'));
}
