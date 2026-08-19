// 画面3：個体パネル。全ステータス・家系・所属・履歴・実績。
// 事実は常に正確に見せる。未発現の素質だけがレンジ表示になる。

import { el, clear, bar, num, pct, clamp, seg, mount } from '../dom.js';
import { CHROMOSOMES, GENES, GENE_NAMES } from '../../core/genes.js';
import { SKILLS, ROLE, DISTRICT, PHASE, BUREAU_LABEL } from '../../core/model.js';
import { portrait, training, strainName, swatchColor, lineageHue } from '../color.js';

const CH_TITLE = {
  1: '1番　速さ ↔ 耐久',
  2: '2番　殴る ↔ 見る・考える',
  3: '3番　量・群 ↔ 質・個',
  4: '4番　上昇 ↔ 安定',
  5: '5番　個 ↔ 群',
  6: '6番　身内 ↔ 全体',
  7: '7番　信 ↔ 疑',
  8: '8番　振れ幅と向き',
  0: '独立　交叉率',
};

const ROLE_LABEL = { idle: '無役', farm: '畑', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '幼体' };

export function renderInspector(ctx, node) {
  const { world, api, state } = ctx;
  clear(node);
  const id = state.selected;
  const ind = id != null ? (world.people.get(id) || world.dead.get(id)) : null;

  if (!ind) {
    node.appendChild(el('div', { class: 'empty' },
      'シャーレの住人をクリックすると、その一体の全部が見える。', el('br'),
      el('span', { class: 'mut' }, '色相＝血統／彩度＝練度／明度＝年齢。'),
    ));
    return;
  }

  const rank = api.publicRank ? api.publicRank(world, ind) : { pct: 50, label: '—' };

  // ---- 見出し
  node.appendChild(el('div', { style: { display: 'flex', gap: '11px', alignItems: 'center', marginBottom: '10px' } },
    portrait(world, ind, 46),
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { style: { fontSize: '17px', fontWeight: '700' } }, ind.name),
      el('div', { class: 'mut', style: { fontSize: '11px' } },
        `${ind.age}歳 ・ ${ROLE_LABEL[ind.role] || ind.role} ・ ${ind.district === DISTRICT.FRONTIER ? '辺境' : '中心'}`
        + (ind.alive ? '' : ` ・ 第${ind.deathGen}世代に死亡（${ind.deathCause}）`)),
      el('div', { class: 'tagrow' },
        ind.bureau ? el('span', { class: 'tag ac' }, BUREAU_LABEL[ind.bureau] + '長') : null,
        ind.foreign ? el('span', { class: 'tag warn' }, '外来 ・ ' + (ind.homeName || '')) : null,
        ind.wounded ? el('span', { class: 'tag bad' }, '傷病') : null,
        !ind.alive ? el('span', { class: 'tag bad' }, '故人') : null,
      ),
    ),
  ));

  // ---- 事実（常に正確）
  node.appendChild(el('h3', { class: 'sec' }, '実効値'));
  const kv = el('div', { class: 'kv' });
  const add = (k, v) => { mount(kv, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)); };
  add('国民力', rank.value != null ? String(rank.value) : '—');
  add('国内順位', rank.label);
  add('練度（平均）', pct(training(ind)));
  add('疲労', pct(ind.fatigue || 0));
  add('未充足の欲', pct(ind.unmet || 0));
  // sim が持っているのは regimeGrudge（体制怨恨。家系に継承され、本人の死では消えない）。
  add('体制への怨恨', num(ind.regimeGrudge || 0, 2));
  node.appendChild(kv);
  node.appendChild(el('p', { class: 'hint' }, '国民力に忠誠は含まれない。武力が高く叛意も高い個体は上位に見える。'));

  // ---- 血統
  node.appendChild(el('h3', { class: 'sec' }, '血統の混合比（＝この個体の色相）'));
  const L = ind.lineage || { self: 1 };
  const keys = Object.keys(L).sort((a, b) => L[b] - L[a]);
  for (const k of keys) {
    node.appendChild(el('div', { class: 'bar' },
      el('div', { class: 'nm', style: { display: 'flex', alignItems: 'center', gap: '5px' } },
        el('i', { style: { width: '8px', height: '8px', borderRadius: '50%', background: swatchColor(world, k), display: 'inline-block', flex: '0 0 auto' } }),
        el('span', {}, strainName(world, k))),
      el('div', { class: 'tr' }, el('div', { class: 'fl', style: { width: clamp(L[k]) * 100 + '%', background: swatchColor(world, k) } })),
      el('div', { class: 'nu' }, Math.round(L[k] * 100)),
    ));
  }
  node.appendChild(el('p', { class: 'hint' }, `色相 ${Math.round(lineageHue(world, L))}°`));

  // ---- 練度
  node.appendChild(el('h3', { class: 'sec' }, '練度（遺伝しない。使った軸だけ伸びる）'));
  for (const s of SKILLS) node.appendChild(bar(s, ind.skills?.[s] || 0));

  // ---- 素質
  node.appendChild(el('h3', { class: 'sec' }, '素質（33座位／8染色体・生涯不変）'));
  node.appendChild(el('p', { class: 'hint' },
    '一度も試されていない素質は確定値が出ない。推定幅で表示される。'));
  const chs = Object.keys(CHROMOSOMES).sort((a, b) => (a === '0' ? 1 : b === '0' ? -1 : a - b));
  for (const ch of chs) {
    const grp = CHROMOSOMES[ch];
    node.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', margin: '9px 0 3px' } }, CH_TITLE[ch] || `${ch}番`));
    for (const arm of ['A', 'B']) {
      for (const g of grp[arm]) {
        const v = ind.genes?.[g] ?? 0.5;
        const open = !!(ind.expressed && ind.expressed[g]);
        const label = (arm === 'B' ? '· ' : '') + g;
        node.appendChild(open
          ? bar(label, v, { color: GENES[g].kind === 'mind' ? '#7f8ce0' : '#3aa88f' })
          : bar(label, v, { range: [clamp(v - 0.1), clamp(v + 0.1)], dim: true }));
      }
    }
  }

  // ---- 家系
  node.appendChild(el('h3', { class: 'sec' }, '家系'));
  const fam = el('div');
  const look = (i) => (i == null ? null : world.people.get(i) || world.dead.get(i));
  const link = (p, label) => p
    ? el('div', { class: 'chip', onclick: () => ctx.select(p.id) }, portrait(world, p, 18),
        el('div', { class: 'nm' }, `${label}　${p.name}`), el('div', { class: 'mt' }, `${p.age}歳`))
    : el('div', { class: 'row' }, el('div', { class: 'k' }, label), el('div', { class: 'v mut' }, '—'));
  mount(fam, link(look(ind.fatherId), '父'), link(look(ind.motherId), '母'));
  const kids = [...world.people.values(), ...world.dead.values()].filter(p => p.fatherId === ind.id || p.motherId === ind.id);
  if (kids.length) {
    fam.appendChild(el('div', { class: 'mut', style: { fontSize: '10px', margin: '6px 0 2px' } }, `子 ${kids.length}体`));
    for (const k of kids.slice(0, 12)) fam.appendChild(link(k, '　'));
  }
  node.appendChild(fam);

  // ---- 実績と称号
  node.appendChild(el('h3', { class: 'sec' }, '実績・叙勲'));
  if (!ind.deeds?.length && !ind.titles?.length) {
    node.appendChild(el('p', { class: 'hint' }, '機会を与えないと実績は発生しない。実績のない者は出自でしか測れない。'));
  } else {
    node.appendChild(el('div', { class: 'tagrow' },
      ...(ind.titles || []).map(t => el('span', { class: 'tag ac' }, t)),
      ...(ind.deeds || []).map(d => el('span', { class: 'tag' }, typeof d === 'string' ? d : d.text || '')),
    ));
  }

  // ---- 履歴
  node.appendChild(el('h3', { class: 'sec' }, '履歴'));
  const hist = api.chronicle ? api.chronicle(world, { actor: ind.id, limit: 40 }) : [];
  if (!hist.length) node.appendChild(el('p', { class: 'hint' }, 'まだ何も起きていない。'));
  for (const e of hist.slice(0, 30)) {
    node.appendChild(el('div', { class: 'row' },
      el('div', { class: 'k' }, `第${e.gen}世代　${e.kind}`),
      el('div', { class: 'v', style: { fontWeight: '400', fontSize: '11px', textAlign: 'right', flex: '1' } }, e.text || ''),
    ));
  }

  // ---- 操作（P1のみ：置く）
  if (world.phase === PHASE.VILLAGE && ind.alive) {
    node.appendChild(el('h3', { class: 'sec' }, '置く'));
    node.appendChild(seg(
      [ROLE.IDLE, ROLE.FARM, ROLE.HUNT, ROLE.DRILL].map(r => ({ value: r, label: ROLE_LABEL[r] })),
      ind.role, (r) => { api.assignRole(world, ind.id, r); ctx.refresh(); },
    ));
    node.appendChild(el('div', { style: { height: '6px' } }));
    node.appendChild(seg(
      [{ value: DISTRICT.CENTER, label: '中心' }, { value: DISTRICT.FRONTIER, label: '辺境（練度が伸びる）' }],
      ind.district, (d) => { api.setDistrict(world, ind.id, d); ctx.refresh(); },
    ));
  }
}
