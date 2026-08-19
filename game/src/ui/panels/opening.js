// 画面1：オープニング。性格診断ふうの数問。
// 回答するたびに右のバーが伸びる ＝ 回答がそのまま第1世代の遺伝子になるのが見える。

import { el, clear, bar, toast } from '../dom.js';
import { QUESTIONS, previewGenes, touchedGenes } from '../questions.js';
import { drawIndividual } from '../color.js';
import { makeIndividual } from '../../core/model.js';

export function openOpening(onDone) {
  const answers = new Array(QUESTIONS.length).fill(null);
  let qi = 0;

  const root = el('div', { id: 'opening' });
  const op = el('div', { class: 'op' });
  root.appendChild(op);
  document.body.appendChild(root);

  const title = el('div', { class: 'title' }, '増殖');
  const tagline = el('div', { class: 'tag' }, 'シャーレの中でカビを育てて、隣のシャーレとぶつける。');
  const qbox = el('div', { class: 'qbox' });
  const gpre = el('div', { class: 'gpre' });
  const wrap = el('div', { class: 'qwrap' }, qbox, gpre);
  const dots = el('div', { class: 'dots' });
  op.append(title, tagline, wrap, dots);

  function renderPreview() {
    clear(gpre);
    const g = previewGenes(answers.filter(Boolean));
    gpre.append(
      el('h4', {}, '創世の二匹の素質'),
      el('div', { class: 'note' }, '答えた分だけ心系の遺伝子が決まる。体系（代謝・頑健）は別枠で振られる。'),
      previewFace(g),
    );
    for (const k of touchedGenes()) {
      const has = g[k] != null;
      gpre.appendChild(bar(k, has ? g[k] : 0.5, { dim: !has }));
    }
  }

  function previewFace(g) {
    const c = document.createElement('canvas');
    const size = 78, dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    c.style.cssText = `width:${size}px;height:${size}px;display:block;margin:0 auto 10px`;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
    const ind = makeIndividual(0, 'x', { age: 4 });
    Object.assign(ind.genes, g);
    ind.lineage = { self: 1 };
    ind.skills['農技'] = 0.14;
    drawIndividual(ctx, null, ind, size / 2, size / 2, size * 0.36, { fear: 0 });
    return c;
  }

  function renderQ() {
    clear(qbox); clear(dots);
    QUESTIONS.forEach((_, i) => dots.appendChild(el('i', { class: i === qi ? 'on' : (answers[i] ? 'done' : '') })));

    if (qi >= QUESTIONS.length) {
      qbox.append(
        el('div', { class: 'qn' }, '準備完了'),
        el('div', { class: 'qt' }, '二匹を置く。'),
        el('p', { class: 'hint' }, '放っておくと勝手に増える。10体に達すると隣のシャーレが見つかる。'),
        el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
          el('button', { class: 'btn primary', onclick: () => finish(1) }, '世界を始める'),
          el('button', { class: 'btn', onclick: () => { qi = QUESTIONS.length - 1; renderQ(); } }, '前の問いに戻る'),
        ),
        el('div', { class: 'divider' }),
        el('p', { class: 'hint' }, '開発用：いきなり部族フェーズ（外来の血が入った状態）から始めて、斑→混色の見え方を確かめる。'),
        el('button', { class: 'btn sm', onclick: () => finish(2) }, 'デモ：部族フェーズから開始'),
      );
      return;
    }

    const q = QUESTIONS[qi];
    qbox.append(
      el('div', { class: 'qn' }, `問 ${qi + 1} / ${QUESTIONS.length}`),
      el('div', { class: 'qt' }, q.text),
    );
    q.options.forEach((o, oi) => {
      const chosen = answers[qi] && answers[qi].choice === oi;
      qbox.appendChild(el('button', {
        class: 'opt' + (chosen ? ' on' : ''),
        onclick: () => {
          answers[qi] = { id: q.id, choice: oi, effects: o.effects };
          renderPreview();
          setTimeout(() => { qi++; renderQ(); }, 160);
        },
      },
        el('div', { class: 'ol' }, o.label),
        el('div', { class: 'oe' }, Object.entries(o.effects)
          .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${Math.round(v * 100)}`).join('　')),
      ));
    });
    if (qi > 0) {
      qbox.appendChild(el('button', {
        class: 'btn sm ghost', style: { marginTop: '8px' },
        onclick: () => { qi--; renderQ(); },
      }, '← 戻る'));
    }
  }

  function finish(mode) {
    root.remove();
    onDone(answers.filter(Boolean), mode);
  }

  renderQ();
  renderPreview();
}
