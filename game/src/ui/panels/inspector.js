// 「この一体だけ」の画面。左のオーバーレイに出る（右のドック＝国ぜんたい とは別の場所）。
//
// 【並び順】染色体順をやめ、**効き目の強い順**にする（R-979）。
//   よく効く → 効く → 腕 → 長にしたときだけ効く → いまの版では効かない（畳む）
//   「代謝17だったらなんなん」への最短の答えは、この並びと、行の右端の1文字の印。
//
// 【?? の方針】
//   sim が伏せているのは **6つの才能だけ**（derive.js の SEGMENT_OF）。
//     戦の才能  : 攻撃素質 / 胆力 / 統率素質   … 子どものうちに戦か狩りに置かれると開く
//     作る才能  : 器用 / 技術習得 / 共同作業適性 … 子どものうちに畑か狩りに置かれると開く
//   残り27座位は全個体が共通して持つ基準の値で、常に確定値が読める。
//
//   以前はここが `ind.expressed[遺伝子名]` を見ていた。sim の expressed は
//   **局面キー（'war' / 'prod'）** で立つので、遺伝子名で引くと常に undefined になり、
//   **33座位すべてが `??`** で表示されていた。配役の判断材料が丸ごと消えていた原因。
//
// 【書かないこと】
//   実装に無い効果を書かない。「感応＝気配に気づく力」は2か所にあった嘘で、両方消した。
//   説明の文言はこのファイルに書かない。**全部 glossary.js が持つ。**

import { el, clear, bar, tile, clamp, seg, mount } from '../dom.js';
import { GENES, GENE_NAMES } from '../../core/genes.js';
import { SKILLS, ROLE, DISTRICT, PHASE } from '../../core/model.js';
import { portrait, training, strainName, swatchColor } from '../color.js';
import {
  label as G, term, groupOf, GROUP_ORDER, GROUP_TITLE, GROUP_SUB,
  SKILL_LEAD, MIND_LEAD, scale01,
} from '../glossary.js';

// sim が伏せている6つ。api 経由で引けなかったときの保険としてここにも持つ。
const FALLBACK_SEGMENT_OF = {
  攻撃素質: 'war', 胆力: 'war', 統率素質: 'war',
  器用: 'prod', 技術習得: 'prod', 共同作業適性: 'prod',
};
const SEG_OPEN_WHERE = { war: '戦か狩りに置くと開く', prod: '畑か狩りに置くと開く' };

// group ごとの座位。まとまりは glossary.js が持っているので、ここに名前を並べない。
// 辞書の group を変えれば並びもついてくる（二重管理をしない）。
function genesOf(group) {
  return GENE_NAMES.filter(g => groupOf(g) === group);
}

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
        `${ind.age}歳 ・ `, word('role.' + ind.role), ' ・ ', word('dist.' + ind.district), 'に住む'),
      el('div', { class: 'tagrow' },
        ind.bureau ? el('span', { class: 'tag ac', 'data-term': 'bureau.' + ind.bureau },
          G('bureau.' + ind.bureau) + 'の長') : null,
        ind.foreign ? el('span', { class: 'tag warn' }, 'よそから来た人 ・ ' + (ind.homeName || '')) : null,
        ind.wounded ? el('span', { class: 'tag bad' }, 'ケガ') : null,
        !ind.alive ? el('span', { class: 'tag bad' }, `第${ind.deathGen}世代に死んだ（${ind.deathCause}）`) : null,
      ),
    ),
  ));

  // ---------------------------------------------------------------- 一言
  node.appendChild(el('div', { class: 'lead-note' }, summarize(ind, isOpen)));

  // ---------------------------------------------------------------- いまの力（4タイル）
  // 名前は5-3の表で1語に決めてある。「強さ」「熟練」はもう使わない。
  const tiles = el('div', { class: 'tiles' });
  const fat = ind.fatigue || 0;
  const un = ind.unmet || 0;
  mount(tiles,
    tile('citizenPower', rank.value != null ? String(Math.round(rank.value)) : '—', rankWord(rank)),
    tile('training', scale01(training(ind)), '使った仕事だけ伸びる'),
    tile('fatigue', scale01(fat), fat > 0.6 ? '休ませたい' : '', { cls: fat > 0.6 ? 'alarm' : '' }),
    tile('unmet', scale01(un), un > 0.6 ? '不満が大きい' : '', { cls: un > 0.6 ? 'alarm' : '' }),
  );
  node.appendChild(tiles);

  // ---------------------------------------------------------------- 置く（村のあいだだけ）
  if (world.phase === PHASE.VILLAGE && ind.alive && ind.role !== ROLE.CHILD) {
    node.appendChild(el('h3', { class: 'sec' }, 'この一体をどこに置くか'));
    node.appendChild(el('p', { class: 'hint' }, advice(ind, isOpen)));
    node.appendChild(seg(
      [ROLE.FARM, ROLE.HUNT, ROLE.DRILL, ROLE.IDLE].map(r => ({ value: r, label: G('role.' + r) })),
      ind.role, (r) => { api.assignRole(world, ind.id, r); ctx.refresh(); },
    ));
    node.appendChild(el('p', { class: 'hint' }, oneLiners(['role.farm', 'role.hunt', 'role.drill', 'role.idle'])));
    node.appendChild(el('div', { style: { height: '9px' } }));
    node.appendChild(seg(
      [DISTRICT.CENTER, DISTRICT.FRONTIER].map(d => ({ value: d, label: G('dist.' + d) })),
      ind.district, (d) => { api.setDistrict(world, ind.id, d); ctx.refresh(); },
    ));
    node.appendChild(el('p', { class: 'hint' }, oneLiners(['dist.center', 'dist.frontier'])));
  }

  // ---------------------------------------------------------------- まだ分かっていない力
  const closed = Object.keys(segOf).filter(g => !isOpen(g));
  if (closed.length) {
    node.appendChild(el('h3', { class: 'sec' }, word('expressed'), el('small', {}, `${closed.length} つ`)));
    // 手段が画面に無い局面で「置くと開く」と書かない。置けるのは村のあいだだけ。
    node.appendChild(el('p', { class: 'hint' },
      world.phase === PHASE.VILLAGE
        ? 'この6つは、子どものうちにその場に置かれないと分からないまま。?? は推定の幅。'
        : 'この6つは、子どものうちにその場に置かれなかったので分からないまま。'
          + '部族では一体ずつ置けないので、もう開かない。'));
    for (const g of closed) {
      const v = ind.genes?.[g] ?? 0.5;
      node.appendChild(bar(g, v, { range: [clamp(v - 0.1), clamp(v + 0.1)], dim: true }));
      if (world.phase === PHASE.VILLAGE) {
        node.appendChild(el('p', { class: 'hint', style: { margin: '0 0 6px 4px' } },
          SEG_OPEN_WHERE[segOf[g]] || ''));
      }
    }
  }

  // ---------------------------------------------------------------- 生まれつき・腕（group 順）
  node.appendChild(el('h3', { class: 'sec' }, '生まれつき', el('small', {}, '一生変わらない')));
  node.appendChild(el('p', { class: 'hint', style: { margin: '0 0 6px' } }, MIND_LEAD));

  for (const grp of GROUP_ORDER) {
    if (grp === 'skill') { renderSkills(node, ind); continue; }
    const list = genesOf(grp).filter(g => GENES[g]);
    if (!list.length) continue;
    if (grp === 'dead') { renderDead(node, ind, list, isOpen); continue; }
    node.appendChild(groupHead(grp));
    for (const g of list) node.appendChild(geneBar(ind, g, isOpen));
  }

  // ---------------------------------------------------------------- 血すじ
  const L = ind.lineage || { self: 1 };
  const keys = Object.keys(L).sort((a, b) => L[b] - L[a]);
  if (keys.length > 1 || keys[0] !== 'self') {
    node.appendChild(el('h3', { class: 'sec' }, word('lineage'), el('small', {}, 'この一体の色のもと')));
    for (const k of keys) {
      node.appendChild(el('div', { class: 'bar' },
        el('div', { class: 'nm', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('i', { style: { width: '10px', height: '10px', borderRadius: '50%', background: swatchColor(world, k), display: 'inline-block', flex: '0 0 auto' } }),
          el('span', {}, strainName(world, k))),
        el('div', { class: 'tr' }, el('div', { class: 'fl', style: { width: clamp(L[k]) * 100 + '%', background: swatchColor(world, k) } })),
        el('div', { class: 'nu' }, Math.round(L[k] * 100) + '%'),
      ));
    }
  }

  // ---------------------------------------------------------------- 家族
  node.appendChild(el('h3', { class: 'sec' }, '家族'));
  const look = (i) => (i == null ? null : world.people.get(i) || world.dead.get(i));
  const link = (p, lbl) => p
    ? el('div', { class: 'chip', onclick: () => ctx.select(p.id) }, portrait(world, p, 22),
        el('div', { class: 'nm' }, `${lbl} ${p.name}`), el('div', { class: 'mt' }, `${p.age}歳`))
    : el('div', { class: 'row' }, el('div', { class: 'k' }, lbl), el('div', { class: 'v mut' }, 'いない'));
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
        el('div', { class: 'v', style: { fontWeight: '400', textAlign: 'left', flex: '1' } },
          el('span', { class: 'tag', 'data-term': 'evt.' + e.kind, style: { marginRight: '6px' } },
            G('evt.' + e.kind)),
          e.text || ''),
      ));
    }
  }

  // ほうびはある時だけ出す。無い個体に「まだ無い」と書く価値はない
  if (ind.titles?.length || ind.deeds?.length) {
    node.appendChild(el('h3', { class: 'sec' }, 'ほうび'));
    node.appendChild(el('div', { class: 'tagrow' },
      ...(ind.titles || []).map(t => el('span', { class: 'tag ac' }, t)),
      ...(ind.deeds || []).map(d => el('span', { class: 'tag' }, typeof d === 'string' ? d : d.text || '')),
    ));
  }
}

// ---------------------------------------------------------------- 部品

/** 辞書の語を、点線の下線付きで1語だけ置く */
function word(key) {
  return el('span', { 'data-term': key }, el('span', { class: 'u' }, G(key)));
}

/** 「畑＝食べものを作る。　狩り＝…」の1行。文面は全部辞書から取る */
function oneLiners(keys) {
  return keys.map(k => `${G(k)}＝${term(k) ? term(k).one : ''}`).join('　');
}

function groupHead(grp) {
  return el('div', { class: 'grph' },
    el('span', {}, GROUP_TITLE[grp]),
    GROUP_SUB[grp] ? el('small', {}, GROUP_SUB[grp]) : null);
}

function renderSkills(node, ind) {
  node.appendChild(el('h3', { class: 'sec' }, GROUP_TITLE.skill, el('small', {}, GROUP_SUB.skill)));
  node.appendChild(el('p', { class: 'hint', style: { margin: '0 0 6px' } }, SKILL_LEAD));
  for (const s of SKILLS) node.appendChild(bar(s, ind.skills?.[s] || 0));
}

/**
 * いまの版で何にも効かない4つ。**消さずに、正直に畳んでおく。**
 * 33本を同じ顔で並べておいて、そのうち4本が何にもつながっていないほうが嘘に近い。
 */
function renderDead(node, ind, list, isOpen) {
  const box = el('details', { class: 'deadbox' });
  box.appendChild(el('summary', {}, `${GROUP_TITLE.dead}　${list.length}つ`));
  box.appendChild(el('p', { class: 'hint' },
    'ここに並ぶ数字は、いまの版ではどこにもつながっていない。'
    + '60問の診断が使う軸なので、数字だけは残してある。'));
  for (const g of list) box.appendChild(geneBar(ind, g, isOpen));
  node.appendChild(box);
}

/** 生まれつきの1行。伏せるのは SEGMENT_OF の6つだけ。 */
function geneBar(ind, g, isOpen) {
  if (!GENES[g]) return el('span');
  const v = ind.genes?.[g] ?? 0.5;
  if (!isOpen(g)) return bar(g, v, { range: [clamp(v - 0.1), clamp(v + 0.1)], dim: true });
  return bar(g, v, { dim: groupOf(g) === 'dead' });
}

/** 順位の一言。人口が小さいときに「上位1%」と書かない（N-7） */
function rankWord(rank) {
  if (rank.of != null && rank.at != null && rank.of < 20) return `${rank.of}体中 ${rank.at}番目`;
  return rank.label || '';
}

/**
 * その一体を一言で。数字を読む前に「どういう子か」が分かるように。
 * **効かない座位はここに出さない。**「よく気づく（＝感応）」は2か所目の嘘だった。
 */
function summarize(ind, isOpen) {
  const V = (k) => ind.genes?.[k] ?? 0.5;
  const cand = [
    ['丈夫', '頑健'], ['長生き', '寿命'], ['頭がいい', '知性'],
    ['子だくさん', '繁殖性'], ['よく食べる', '代謝'],
    ['野心が強い', '野心'], ['素直', '従順'], ['誇りが高い', '誇り'],
    ['情に厚い', '情愛'], ['よく働く', '勤勉'],
    ['心が振れやすい', '感受性'], ['人のせいにする', '他責'], ['取り分にこだわる', '私欲'],
    ['頑固', '頑迷'], ['信じやすい', '信仰性'], ['逃げぐせがある', '保身'],
    ['群れたがる', '団結傾向'], ['上下を気にする', '序列意識'],
  ].filter(([, k]) => groupOf(k) !== 'dead');
  if (isOpen('攻撃素質')) cand.push(['戦いの才がある', '攻撃素質']);
  if (isOpen('統率素質')) cand.push(['人をまとめる才がある', '統率素質']);
  if (isOpen('器用')) cand.push(['手先が器用', '器用']);
  if (isOpen('胆力')) cand.push(['度胸がある', '胆力']);
  const sorted = cand.map(([t, k]) => [t, V(k)]).sort((a, b) => b[1] - a[1]);
  const strong = sorted.slice(0, 3).filter(([, v]) => v > 0.58).map(([t]) => t);
  if (!strong.length) return 'これといった尖りがない。平凡な一体。';
  return strong.join('。') + '。';
}

/** どこに置くべきかの助言。村のあいだの主な操作なので、ここで迷わせない。 */
function advice(ind, isOpen) {
  const V = (k) => ind.genes?.[k] ?? 0.5;
  const farm = V('勤勉') * 0.6 + V('繁殖性') * 0.2 + (isOpen('器用') ? V('器用') : 0.5) * 0.2;
  const war = (isOpen('攻撃素質') ? V('攻撃素質') : 0.5) * 0.6 + (isOpen('胆力') ? V('胆力') : 0.5) * 0.4;
  if (war > farm + 0.08) return '戦い向き。狩りに置くと食べものも作れて、戦いの腕も伸びる。';
  if (farm > war + 0.08) return '畑向き。よく働くので、畑に置くと取れ高が伸びる。';
  return 'どちらでも大差ない。足りていないほうに置く。';
}
