// 「この一体だけ」の画面。左のオーバーレイに出る（右のドック＝国ぜんたい とは別の場所）。
//
// 【?? の方針】
//   sim が伏せているのは **6つの才能だけ**（derive.js の SEGMENT_OF）。
//     戦の才能  : 攻撃素質 / 胆力 / 統率素質   … 幼少期に戦の側に置かれると開く
//     作る才能  : 器用 / 技術習得 / 共同作業適性 … 幼少期に作る側に置かれると開く
//   残り27座位は全個体が共通して持つ基準のステータスで、常に確定値が読める。
//
//   以前はここが `ind.expressed[遺伝子名]` を見ていた。sim の expressed は
//   **局面キー（'war' / 'prod'）** で立つので、遺伝子名で引くと常に undefined になり、
//   **33座位すべてが `??`** で表示されていた。配役の判断材料が丸ごと消えていた原因。

import { el, clear, bar, num, pct, clamp, seg, mount } from '../dom.js';
import { GENES } from '../../core/genes.js';
import { SKILLS, ROLE, DISTRICT, PHASE, BUREAU_LABEL } from '../../core/model.js';
import { portrait, training, strainName, swatchColor } from '../color.js';

const ROLE_LABEL = { idle: '無役', farm: '畑', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '幼体' };
const DIST_LABEL = { center: '中心', frontier: '辺境' };

// sim が伏せている6つ。api 経由で引けなかったときの保険としてここにも持つ。
const FALLBACK_SEGMENT_OF = {
  攻撃素質: 'war', 胆力: 'war', 統率素質: 'war',
  器用: 'prod', 技術習得: 'prod', 共同作業適性: 'prod',
};
const SEG_LABEL = { war: '戦', prod: '作る' };

// 読めない語は、バーの中に詰めこまず、グループの見出しの下で1行だけ説明する。
// 各行に注釈を足すと文字幅が足りなくなって、結局どちらも読めなくなる。
const BODY_NOTE = '代謝＝燃費　感応＝気配に気づく力　可塑＝この子の血が次の代に混ざりやすいか';
const MIND_NOTE = '他責＝うまくいかない原因を外に置く　私欲＝自分の取り分への執着　感受性＝心の振れ幅';

// 染色体番号ではなく「からだ」「こころ」で分ける。1番・2番という並びは素人には読めない。
const BODY_ORDER = ['頑健', '寿命', '代謝', '生育速度', '繁殖性', '感応', '知性', '可塑'];
const MIND_ORDER = [
  '野心', '統率素質', '従順', '保身',
  '誇り', '頑迷', '序列意識', '柔軟',
  '情愛', '世代間伝承意欲', '非情', '勤勉',
  '信仰性', '団結傾向', '懐疑', '自律',
  '感受性', '他責', '好奇心', '私欲',
];

export function renderInspector(ctx, node) {
  const { world, api, state } = ctx;
  clear(node);
  const id = state.selected;
  const ind = id != null ? (world.people.get(id) || world.dead.get(id)) : null;
  if (!ind) return;

  const segOf = (api.SEGMENT_OF && typeof api.SEGMENT_OF === 'object') ? api.SEGMENT_OF : FALLBACK_SEGMENT_OF;
  const isOpen = (g) => { const s = segOf[g]; return !s || !!(ind.expressed && ind.expressed[s]); };
  const rank = api.publicRank ? api.publicRank(world, ind) : { pct: 50, label: '—' };

  // ---------------------------------------------------------------- 見出し
  node.appendChild(el('div', { style: { display: 'flex', gap: '13px', alignItems: 'center', marginBottom: '12px' } },
    portrait(world, ind, 56),
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { style: { fontSize: '22px', fontWeight: '700', lineHeight: '1.25' } }, ind.name),
      el('div', { style: { fontSize: '14px', color: 'var(--tx2)' } },
        `${ind.age}歳 ・ ${ROLE_LABEL[ind.role] || ind.role} ・ ${DIST_LABEL[ind.district] || ''}に住む`),
      el('div', { class: 'tagrow' },
        ind.bureau ? el('span', { class: 'tag ac' }, BUREAU_LABEL[ind.bureau] + '長') : null,
        ind.foreign ? el('span', { class: 'tag warn' }, 'よそ者 ・ ' + (ind.homeName || '')) : null,
        ind.wounded ? el('span', { class: 'tag bad' }, 'ケガ') : null,
        !ind.alive ? el('span', { class: 'tag bad' }, `第${ind.deathGen}世代に死亡（${ind.deathCause}）`) : null,
      ),
    ),
  ));

  // ---------------------------------------------------------------- 一言
  node.appendChild(el('div', { class: 'lead-note' }, summarize(ind, isOpen)));

  // ---------------------------------------------------------------- いまの力
  const tiles = el('div', { class: 'tiles' });
  mount(tiles,
    tile('強さ', rank.value != null ? String(Math.round(rank.value)) : '—', rank.label),
    tile('熟練', pct(training(ind)), '使った仕事だけ伸びる'),
    tile('疲れ', pct(ind.fatigue || 0), (ind.fatigue || 0) > 0.6 ? '休ませたい' : ''),
    tile('不満', pct(ind.unmet || 0), (ind.unmet || 0) > 0.6 ? '危ない' : ''),
  );
  node.appendChild(tiles);

  // ---------------------------------------------------------------- 置く（P1）
  if (world.phase === PHASE.VILLAGE && ind.alive && ind.role !== ROLE.CHILD) {
    node.appendChild(el('h3', { class: 'sec' }, 'この一体をどこに置くか'));
    node.appendChild(el('p', { class: 'hint' }, advice(ind, isOpen)));
    node.appendChild(seg(
      [{ value: ROLE.FARM, label: '畑（食べ物を作る）' },
       { value: ROLE.HUNT, label: '狩り（作る＋戦が伸びる）' },
       { value: ROLE.DRILL, label: '模擬戦（安全に戦が伸びる）' },
       { value: ROLE.IDLE, label: '無役（何もしない）' }],
      ind.role, (r) => { api.assignRole(world, ind.id, r); ctx.refresh(); },
    ));
    node.appendChild(el('div', { style: { height: '9px' } }));
    node.appendChild(seg(
      [{ value: DISTRICT.CENTER, label: '中心に住む' },
       { value: DISTRICT.FRONTIER, label: '辺境に住む（伸びやすい）' }],
      ind.district, (d) => { api.setDistrict(world, ind.id, d); ctx.refresh(); },
    ));
  }

  // ---------------------------------------------------------------- まだ開いていない才能
  const closed = Object.keys(segOf).filter(g => !isOpen(g));
  if (closed.length) {
    node.appendChild(el('h3', { class: 'sec' }, 'まだ開いていない才能',
      el('small', {}, `${closed.length} つ`)));
    node.appendChild(el('p', { class: 'hint' },
      'この6つだけは、子どものうちにその場に置かれないと開かない。開くまで正確な値は分からない（?? は推定の幅）。'
      + '辺境で育てるか、狩り・模擬戦・畑に置くと開く。'));
    for (const g of closed) {
      const v = ind.genes?.[g] ?? 0.5;
      node.appendChild(bar(`${g}（${SEG_LABEL[segOf[g]]}）`, v,
        { range: [clamp(v - 0.1), clamp(v + 0.1)], dim: true }));
    }
  }

  // ---------------------------------------------------------------- 生まれつき
  node.appendChild(el('h3', { class: 'sec' }, '生まれつき', el('small', {}, '一生変わらない')));

  node.appendChild(el('div', { style: { fontSize: '13.5px', fontWeight: '700', margin: '6px 0 2px' } }, 'からだ'));
  node.appendChild(el('p', { class: 'hint', style: { margin: '0 0 5px' } }, BODY_NOTE));
  for (const g of BODY_ORDER) node.appendChild(geneBar(ind, g, isOpen, '#3fa2c9'));
  for (const g of ['攻撃素質', '器用', '技術習得']) {
    if (isOpen(g)) node.appendChild(geneBar(ind, g, isOpen, '#3fa2c9'));
  }

  node.appendChild(el('div', { style: { fontSize: '13.5px', fontWeight: '700', margin: '14px 0 2px' } }, 'こころ'));
  node.appendChild(el('p', { class: 'hint', style: { margin: '0 0 5px' } }, MIND_NOTE));
  for (const g of MIND_ORDER) node.appendChild(geneBar(ind, g, isOpen, '#8f9ce8'));
  for (const g of ['胆力', '統率素質', '共同作業適性']) {
    if (isOpen(g)) node.appendChild(geneBar(ind, g, isOpen, '#8f9ce8'));
  }

  // ---------------------------------------------------------------- 熟練
  node.appendChild(el('h3', { class: 'sec' }, '熟練', el('small', {}, '子には受け継がれない')));
  for (const s of SKILLS) node.appendChild(bar(s, ind.skills?.[s] || 0));

  // ---------------------------------------------------------------- 血すじ
  const L = ind.lineage || { self: 1 };
  const keys = Object.keys(L).sort((a, b) => L[b] - L[a]);
  if (keys.length > 1 || keys[0] !== 'self') {
    node.appendChild(el('h3', { class: 'sec' }, '血すじ', el('small', {}, 'この一体の色のもと')));
    for (const k of keys) {
      node.appendChild(el('div', { class: 'bar' },
        el('div', { class: 'nm', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('i', { style: { width: '10px', height: '10px', borderRadius: '50%', background: swatchColor(world, k), display: 'inline-block', flex: '0 0 auto' } }),
          el('span', {}, strainName(world, k))),
        el('div', { class: 'tr' }, el('div', { class: 'fl', style: { width: clamp(L[k]) * 100 + '%', background: swatchColor(world, k) } })),
        el('div', { class: 'nu' }, Math.round(L[k] * 100)),
      ));
    }
  }

  // ---------------------------------------------------------------- 家族
  node.appendChild(el('h3', { class: 'sec' }, '家族'));
  const look = (i) => (i == null ? null : world.people.get(i) || world.dead.get(i));
  const link = (p, label) => p
    ? el('div', { class: 'chip', onclick: () => ctx.select(p.id) }, portrait(world, p, 22),
        el('div', { class: 'nm' }, `${label} ${p.name}`), el('div', { class: 'mt' }, `${p.age}歳`))
    : el('div', { class: 'row' }, el('div', { class: 'k' }, label), el('div', { class: 'v mut' }, 'いない'));
  const fam = el('div');
  mount(fam, link(look(ind.fatherId), '父'), link(look(ind.motherId), '母'));
  const kids = [...world.people.values(), ...world.dead.values()].filter(p => p.fatherId === ind.id || p.motherId === ind.id);
  if (kids.length) {
    fam.appendChild(el('div', { class: 'mut', style: { fontSize: '13px', margin: '8px 0 3px' } }, `子 ${kids.length}体`));
    for (const k of kids.slice(0, 12)) fam.appendChild(link(k, '　'));
  }
  node.appendChild(fam);

  // ---------------------------------------------------------------- できごと
  const hist = api.chronicle ? api.chronicle(world, { actor: ind.id, limit: 40 }) : [];
  if (hist.length) {
    node.appendChild(el('h3', { class: 'sec' }, 'この一体に起きたこと'));
    for (const e of hist.slice(0, 20)) {
      node.appendChild(el('div', { class: 'row' },
        el('div', { class: 'k', style: { flex: '0 0 76px' } }, `第${e.gen}世代`),
        el('div', { class: 'v', style: { fontWeight: '400', textAlign: 'left', flex: '1' } }, e.text || e.kind),
      ));
    }
  }

  // 称号・実績はある時だけ出す。無い個体に「まだ無い」と書く価値はない
  if (ind.titles?.length || ind.deeds?.length) {
    node.appendChild(el('h3', { class: 'sec' }, '手柄・称号'));
    node.appendChild(el('div', { class: 'tagrow' },
      ...(ind.titles || []).map(t => el('span', { class: 'tag ac' }, t)),
      ...(ind.deeds || []).map(d => el('span', { class: 'tag' }, typeof d === 'string' ? d : d.text || '')),
    ));
  }
}

// ---------------------------------------------------------------- 部品

function tile(k, v, s) {
  return el('div', { class: 'tile' },
    el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), s ? el('div', { class: 's' }, s) : null);
}

/**
 * 生まれつきの1行。
 * **基準のステータスは常に数字で見せる。** 伏せるのは SEGMENT_OF の6つだけ。
 */
function geneBar(ind, g, isOpen, color) {
  if (!GENES[g]) return el('span');
  const v = ind.genes?.[g] ?? 0.5;
  if (!isOpen(g)) return bar(g, v, { range: [clamp(v - 0.1), clamp(v + 0.1)], dim: true });
  return bar(g, v, { color });
}

/** その一体を一言で。数字を読む前に「どういう子か」が分かるように。 */
function summarize(ind, isOpen) {
  const G = (k) => ind.genes?.[k] ?? 0.5;
  const strong = [];
  const cand = [
    ['丈夫', G('頑健')], ['長生き', G('寿命')], ['頭がいい', G('知性')],
    ['子だくさん', G('繁殖性')], ['よく気づく', G('感応')],
    ['野心が強い', G('野心')], ['素直', G('従順')], ['誇りが高い', G('誇り')],
    ['情に厚い', G('情愛')], ['よく働く', G('勤勉')], ['疑い深い', G('懐疑')],
    ['心が振れやすい', G('感受性')], ['人のせいにする', G('他責')], ['欲が深い', G('私欲')],
    ['頑固', G('頑迷')], ['信じやすい', G('信仰性')],
  ];
  if (isOpen('攻撃素質')) cand.push(['戦いの才がある', G('攻撃素質')]);
  if (isOpen('統率素質')) cand.push(['人を率いる才がある', G('統率素質')]);
  if (isOpen('器用')) cand.push(['手先が器用', G('器用')]);
  cand.sort((a, b) => b[1] - a[1]);
  for (const [t, v] of cand.slice(0, 3)) if (v > 0.58) strong.push(t);
  if (!strong.length) return 'これといった尖りがない。平凡な一体。';
  return strong.join('。') + '。';
}

/** どこに置くべきかの助言。P1の主活動なので、ここで迷わせない。 */
function advice(ind, isOpen) {
  const G = (k) => ind.genes?.[k] ?? 0.5;
  const farm = G('勤勉') * 0.6 + G('繁殖性') * 0.2 + (isOpen('器用') ? G('器用') : 0.5) * 0.2;
  const war = (isOpen('攻撃素質') ? G('攻撃素質') : 0.5) * 0.6 + (isOpen('胆力') ? G('胆力') : 0.5) * 0.4;
  if (war > farm + 0.08) return `戦い向き。狩りに置くと食べ物も作れて、戦いの腕も伸びる。`;
  if (farm > war + 0.08) return `畑向き。よく働くので、畑に置くと産出が伸びる。`;
  return 'どちらでも大差ない。足りていないほうに置く。';
}
