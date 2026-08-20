// 画面1：開幕の性格診断。**作るのは個体ではなく種族。**
//
// 1文＋7段階を60問。タップで即座に次へ（確定ボタンは無い）。
// 速さのために、問い文の高さと7つの点の位置は**画面上で固定**してある。
// 1問ごとに点の位置が動くと、そのたびに狙い直しが要る。60回それをやると遅い。
//
// 最後に、回答から出た種族（コード・名前・6軸・危うさ）と、
// その重心から引かれた2匹（アダム／イザナミ）のばらけ方を見せる。

import { el, clear, mount, DEV } from '../dom.js';
import {
  STATEMENTS, ORDER, SCALE, AXES,
  centroidFrom, speciesOf, axisScores, answersForSim, answeredRatio, OFF_AXIS_GENES,
} from '../questions.js';
import { drawIndividual } from '../color.js';
import { saveSpecies, loadSpecies, savedAgo } from '../save.js';



/**
 * @param build (answers, opts) -> world   回答から世界を作る（まだ始めない）
 * @param start ()              -> void    「この二匹を置く」で本編へ
 */
export function openOpening({ build, start }) {
  const answers = {};        // id -> 0..1
  let qi = 0;


  const root = el('div', { id: 'opening' });
  document.body.appendChild(root);

  // ------------------------------------------------------------ 表紙
  //
  // 保存された種族があれば、**60問をやり直さずに始められる**ことを最初に出す。
  // テストのたびに60問答え直すのは、それだけで遊ぶ気が失せる。
  function renderCover() {
    clear(root);
    const saved = loadSpecies();
    const box = el('div', { class: 'op cover' },
      el('div', { class: 'title' }, '増 殖'),
      el('div', { class: 'tag' }, 'シャーレの中でカビを育てて、隣のシャーレとぶつける。'),
    );
    root.appendChild(box);

    if (saved) {
      mount(box,
        el('div', { class: 'resume' },
          el('div', { class: 'resume-lab' }, '前回きめた種族'),
          el('div', { class: 'resume-name' }, saved.name || '—'),
          el('div', { class: 'resume-code' }, saved.code || ''),
          el('div', { class: 'resume-ago' }, savedAgo(saved) ? `${savedAgo(saved)}に決めた` : ''),
        ),
        el('button', {
          class: 'btn primary lead', onclick: () => resume(saved),
        }, 'この種族で始める'),
        el('div', { class: 'orline' }, 'または'),
        el('button', {
          class: 'btn lead', onclick: () => { qi = 0; renderQ(); },
        }, `作り直す（${STATEMENTS.length}問・3〜5分）`),
      );
    } else {
      mount(box,
        el('div', { class: 'card wide-card' },
          el('h4', {}, 'これから作るのは、1匹ではなく種族です'),
          el('p', {}, `${STATEMENTS.length}問の答えが、この世界に置かれる生き物の「重心」になります。`
            + '最初の2匹は、その重心から引かれたサンプルです。答えどおりには生まれません。'),
          el('div', { class: 'kv', style: { marginTop: '10px' } },
            el('div', { class: 'k' }, '所要'), el('div', { class: 'v' }, `${STATEMENTS.length}問・3〜5分`),
            el('div', { class: 'k' }, '答え方'), el('div', { class: 'v' }, '1文を読んで、強く同意〜強く反対の7段階のどこかを押すだけ。押した瞬間に次へ進みます'),
            el('div', { class: 'k' }, '次回から'), el('div', { class: 'v' }, 'この種族は保存されます。もう60問に答える必要はありません'),
          ),
        ),
        el('button', { class: 'btn primary lead', onclick: () => { qi = 0; renderQ(); } }, '種族を決める'),
      );
    }

    // 開発用の入口は ?dev=1 のときだけ出す。本番の画面に並べない。
    if (DEV) {
      mount(box,
        el('div', { class: 'divider' }),
        el('button', { class: 'btn sm', onclick: () => finish(2) }, '開発用：部族フェーズから開始'),
      );
    }
  }

  /** 保存された種族で、60問を飛ばして本編へ。 */
  function resume(saved) {
    const centroid = saved.centroid;
    const sp = speciesOf(centroid);
    cleanup();
    build(answersForSim(centroid), { centroid, species: sp, responses: saved.responses || null });
    start();
  }

  // ------------------------------------------------------------ 設問
  const qNum = el('div', { class: 'qn' });
  const qText = el('div', { class: 'qt' });
  const bar = el('i');
  const backBtn = el('button', {
    class: 'btn sm ghost', onclick: () => { if (qi > 0) { qi--; renderQ(); } },
  }, '← 戻る');
  const spine = el('div', { class: 'spine' });
  const scaleRow = el('div', { class: 'scale' });

  function buildScale() {
    clear(scaleRow);
    scaleRow.appendChild(el('div', { class: 'end agree' }, '強く同意'));
    SCALE.forEach((s, i) => {
      // 当たり判定は見た目の丸ではなく、44px の升のほう。
      // 「どちらでもない」の丸は 11px しかないので、丸で受けると押し損ねる。
      scaleRow.appendChild(el('button', {
        class: 'cell', title: s.label, onclick: () => answer(s.v),
      }, el('i', {
        class: 'dot ' + (i < 3 ? 'a' : i > 3 ? 'b' : 'mid'),
        style: { width: s.size + 'px', height: s.size + 'px' },
      })));
    });
    scaleRow.appendChild(el('div', { class: 'end oppose' }, '強く反対'));
  }

  function paintSpine() {
    const c = centroidFrom(answers);
    const sc = axisScores(c);
    clear(spine);
    for (const a of sc) {
      const p = Math.abs(a.score);
      spine.appendChild(el('div', { class: 'ax' },
        el('div', { class: 'lab' }, a.weak ? '—' : a.letter),
        // 1文字だけでは何の軸か読めない。いま寄っている側の言葉を必ず添える。
        el('div', { class: 'axname' }, a.weak ? 'まだ中央' : (a.side === 0 ? a.aLabel : a.bLabel)),
        el('div', { class: 'tr' },
          el('i', {
            class: a.score >= 0 ? 'a' : 'b',
            style: { width: (p * 50) + '%', [a.score >= 0 ? 'right' : 'left']: '50%' },
          })),
      ));
    }
  }

  function renderQ() {
    if (qi >= ORDER.length) { renderResult(); return; }
    if (!root.querySelector('.quiz')) {
      clear(root);
      buildScale();
      root.appendChild(el('div', { class: 'op quiz' },
        el('div', { class: 'qhead' },
          el('div', { class: 'pbar' }, bar),
          el('div', { class: 'qmeta' }, backBtn, qNum),
        ),
        el('div', { class: 'qbody' }, qText),
        scaleRow,
        el('div', { class: 'sfoot' },
          el('div', { class: 'sfoot-lab' }, '答えるほど、6つの軸が片側へ寄っていく'),
          spine),
      ));
    }
    const q = ORDER[qi];
    qNum.textContent = `${qi + 1} / ${ORDER.length}`;
    qText.textContent = q.text;
    bar.style.width = (answeredRatio(answers) * 100) + '%';
    backBtn.style.visibility = qi > 0 ? 'visible' : 'hidden';
    // すでに答えた問いに戻ってきたときは、その答えを光らせる
    const prev = answers[q.id];
    [...scaleRow.querySelectorAll('.cell')].forEach((c, i) => {
      c.classList.toggle('on', prev != null && Math.abs(SCALE[i].v - prev) < 0.01);
    });
    qText.classList.remove('in'); void qText.offsetWidth; qText.classList.add('in');
    paintSpine();
  }

  /**
   * 押した瞬間に次へ。**タイマーを挟まない。**
   *
   * 最初はフェード用に setTimeout(100ms) を噛ませて、その間 locked で入力を止めていた。
   * これが実機で問題になった：ブラウザは裏に回ったタブのタイマーを1秒〜1分に絞るので、
   * locked が解けるまでの間に押した分が**黙って消える**（60問のうち半分が入らなかった）。
   * 見た目の遷移は CSS のキーフレームだけで足りる。状態は同期で進める。
   */
  function answer(v) {
    if (qi >= ORDER.length) return;
    answers[ORDER[qi].id] = v;
    qi++;
    renderQ();
  }

  // 押しやすさの補助。文字入力ではないので「クリックだけ」の原則は崩していない。
  function onKey(e) {
    if (!root.querySelector('.quiz')) return;
    const n = '1234567'.indexOf(e.key);
    if (n >= 0) { answer(SCALE[n].v); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft' && qi > 0) { qi--; renderQ(); }
  }
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------ 結果：種族
  function renderResult() {
    const asked = centroidFrom(answers);
    const sp = speciesOf(asked);
    const world = build(answersForSim(asked), { centroid: asked, species: sp, responses: { ...answers } });
    const founders = world ? [...world.people.values()].filter(p => p.founder || p.age <= 3).slice(0, 2) : [];

    // **要求値ではなく成立値を出す。**
    // 対抗アームの予算（mean(A)+mean(B)=1）は構造的な制約なので、要求がそのまま
    // 通るとは限らない。要求値を見せると「答えたとおりになっていない」と読めてしまう。
    // sim が world.spec.centroid に正規化後の値を入れてくれている。
    const centroid = (world && world.spec && world.spec.centroid) || asked;

    // ここで保存する。次回起動時は表紙に「この種族で始める」が出て、60問は要らない。
    // 保存するのは種族だけ。世界の途中経過は保存しない。
    saveSpecies({
      centroid: asked,
      code: sp.code,
      name: sp.name,
      spread: (world && world.spec && world.spec.spread) ?? null,
      responses: { ...answers },
    });

    clear(root);
    const box = el('div', { class: 'op result' });
    root.appendChild(box);

    // ---- 種族コードと名前
    mount(box,
      el('div', { class: 'mut', style: { letterSpacing: '.2em', fontSize: '13px' } }, 'あなたの種族'),
      el('div', { class: 'code' }, ...sp.axes.map(a => el('span', { class: a.weak ? 'weak' : '' },
        el('b', {}, a.letter),
        el('u', {}, a.side === 0 ? a.aLabel : a.bLabel)))),
      el('div', { class: 'sname' }, sp.name),
      el('p', { class: 'sline' }, sp.line, ' ', sp.temperLine),
      el('div', { class: 'card danger-card' },
        el('h4', {}, 'この種族が抱えている危うさ'),
        el('p', {}, sp.danger)),
    );

    if (sp.axes.every(a => a.weak)) {
      box.appendChild(el('p', { class: 'hint' },
        '6軸すべてが中央付近にある。偏りのない種族は、どの方向にも強くないということでもある。'));
    }

    // ---- 6軸
    box.appendChild(el('h3', { class: 'sec' }, '6つの軸', el('small', {}, '片側に寄るほど、反対側を捨てている')));
    for (const a of sp.axes) {
      const p = Math.abs(a.score) * 50;
      box.appendChild(el('div', { class: 'axrow' + (a.weak ? ' weak' : '') },
        el('div', { class: 'l' + (a.side === 0 ? ' on' : '') }, a.aLabel),
        el('div', { class: 'tr' },
          el('i', { class: a.score >= 0 ? 'a' : 'b', style: { width: p + '%', [a.score >= 0 ? 'right' : 'left']: '50%' } }),
          el('span', { class: 'mid' })),
        el('div', { class: 'r' + (a.side === 1 ? ' on' : '') }, a.bLabel),
        el('div', { class: 'pc' }, a.weak ? '中央' : a.strength + '%'),
      ));
      box.appendChild(el('p', { class: 'axdesc' }, `${a.ch}番　${a.side === 0 ? a.aDesc : a.bDesc}`));
    }

    // ---- 二匹
    if (founders.length === 2) {
      box.appendChild(el('h3', { class: 'sec' }, '最初の二匹',
        el('small', {}, '同じ種族から引いても、同じ個体は出てこない')));
      const cols = el('div', { class: 'founders' });
      for (const f of founders) cols.appendChild(founderCard(world, f, centroid, sp));
      box.appendChild(cols);
    }

    // ---- 中身の全部。既定では畳んでおく。
    // ここを最初から開いていたせいで、結果画面が22本のバーの壁になっていた。
    const detail = el('div', { hidden: true });
    const toggle = el('button', {
      class: 'btn sm block', style: { marginTop: '14px' },
      onclick: () => {
        detail.hidden = !detail.hidden;
        toggle.textContent = detail.hidden ? '種族の中身を見る（22の数値）' : '中身を閉じる';
      },
    }, '種族の中身を見る（22の数値）');
    box.appendChild(toggle);
    box.appendChild(detail);
    for (const ax of AXES) {
      if (!ax.b.length && ax.a.length === 1 && ax.key === 'blame') {
        detail.appendChild(geneGroup('振れた力の向き', ax.a, centroid, founders));
        continue;
      }
      if (!ax.b.length) { detail.appendChild(geneGroup('心の振れ幅', ax.a, centroid, founders)); continue; }
      detail.appendChild(geneGroup(`${ax.aLabel} ↔ ${ax.bLabel}`, [...ax.a, ...ax.b], centroid, founders));
    }
    detail.appendChild(geneGroup('その他', OFF_AXIS_GENES, centroid, founders));
    if (founders.length === 2) {
      detail.insertBefore(el('p', { class: 'hint', style: { margin: '0 0 8px' } },
        `横棒＝この種族の平均。縦の印は ${founders[0].name}（緑）と ${founders[1].name}（黄）の実際の値。`
        + '平均から離れているほど、その座位でばらけている。'), detail.firstChild);
    }
    detail.appendChild(el('p', { class: 'hint' },
      '体の大きさや丈夫さは種族には入らない。個体ごとに振られる。'));

    box.appendChild(el('button', {
      class: 'btn primary lead block', style: { marginTop: '18px' },
      onclick: () => { cleanup(); start(); },
    }, 'この二匹を置く'));
    box.appendChild(el('button', {
      class: 'btn sm ghost block', style: { marginTop: '8px' },
      onclick: () => { qi = ORDER.length - 1; renderQ(); },
    }, '答えを直す'));
  }

  function finish(mode) {
    // デモ経路：診断を飛ばす
    cleanup();
    build([], { demo: true });
    start(mode);
  }

  function cleanup() {
    window.removeEventListener('keydown', onKey);
    root.remove();
  }

  renderCover();
}

// ---------------------------------------------------------------- 部品

function geneGroup(title, genes, centroid, founders) {
  const box = el('div', { class: 'ggroup' });
  box.appendChild(el('div', { class: 'gtitle' }, title));
  for (const g of genes) {
    const v = centroid[g] ?? 0.5;
    const row = el('div', { class: 'grow' },
      el('div', { class: 'nm' }, g),
      el('div', { class: 'tr' },
        el('i', { style: { width: (v * 100) + '%' } }),
        ...founders.map((f, i) => el('u', {
          class: 'f' + i,
          style: { left: ((f.genes?.[g] ?? 0.5) * 100) + '%' },
          title: `${f.name} ${Math.round((f.genes?.[g] ?? 0.5) * 100)}`,
        })),
      ),
      el('div', { class: 'nu' }, Math.round(v * 100)),
    );
    box.appendChild(row);
  }
  return box;
}

function founderCard(world, f, centroid, sp) {
  const c = document.createElement('canvas');
  const size = 64, dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = size * dpr; c.height = size * dpr;
  c.style.cssText = `width:${size}px;height:${size}px;display:block`;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  drawIndividual(ctx, world, f, size / 2, size / 2, size * 0.38, { fear: 0 });

  // この個体だけで軸を取ると、種族と違う型が出ることがある。そこが要点
  const own = axisScores(f.genes || {});
  const ownCode = own.map(a => a.letter).join('');

  const dev = Object.keys(centroid)
    .map(g => ({ g, d: (f.genes?.[g] ?? 0.5) - centroid[g] }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 4);

  return el('div', { class: 'fcard' },
    el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
      c,
      el('div', {},
        el('div', { class: 'fname' }, f.name),
        el('div', { class: 'fcode' + (ownCode === sp.code ? '' : ' diff') }, ownCode),
        el('div', { class: 'mut', style: { fontSize: '13px' } },
          ownCode === sp.code ? '種族と同じ型' : '種族の型からずれた個体'),
      )),
    el('div', { class: 'fdev' },
      ...dev.map(d => el('span', { class: d.d >= 0 ? 'up' : 'down' },
        `${d.g} ${d.d >= 0 ? '+' : ''}${Math.round(d.d * 100)}`)),
    ),
  );
}

