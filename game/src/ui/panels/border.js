// 画面10：国境。捕虜の階級（上位◯%）だけ見せて、受け入れ／誅殺／送還の3択。
// 外国人は総合値の階級しか見えない。国民力に忠誠は入っていないし、未発現の才能も入っていない。
// つまり国境の選別は無料だが盲目。

import { el, clear, modal, toast, mount } from '../dom.js';
import { portrait, swatchColor, strainName, lineageHue } from '../color.js';

export function openBorder(ctx, battle) {
  const { world, api, rng } = ctx;
  const body = el('div');
  let phase = battle.outcome === 'win' ? 'axis' : 'draw';
  let axis = null;
  const opt = api.captiveOptions(battle);

  const m = modal({ title: '国境', sub: `${battle.opponent.name} との戦のあと`, body, cls: 'wide', dismissable: false, footer: [] });

  function render() {
    clear(body);
    if (phase === 'axis') renderAxis();
    else if (phase === 'draw') renderDraw();
    else renderQueue();
  }

  // ---- 勝者は「どの軸の上位から引くか」を1つ選べる
  function renderAxis() {
    mount(body, 
      el('div', { class: 'card' },
        el('h4', {}, '勝った。相手の平均より上のプールから抽選する。'),
        el('p', {}, '指名はできない。引く軸を1本だけ選べる。当たり外れは残るが、方向は選べる。'),
      ),
      el('h3', { class: 'sec' }, 'どの軸の上位から引くか'),
    );
    const wrap = el('div', { class: 'seg' });
    for (const a of opt.axes) {
      wrap.appendChild(el('button', {
        class: axis === a.key ? 'on' : '', onclick: () => { axis = a.key; render(); },
      }, a.label));
    }
    body.appendChild(wrap);
    body.appendChild(el('p', { class: 'hint' },
      '自分と違う国から取るほど当たりが眠っている。その国の環境が開いた才能しか、数字には出ていない。'));
    body.appendChild(el('button', {
      class: 'btn primary block', style: { marginTop: '12px' }, disabled: !axis,
      onclick: () => { phase = 'draw'; render(); },
    }, axis
      ? `${opt.axes.find(a => a.key === axis).label} 上位から ${opt.countLabel || opt.count + ' 体'}を引く`
      : '軸を選ぶ'));
  }

  function renderDraw() {
    if (!battle.drawn) {
      battle.drawn = true;
      const got = api.takeCaptives(world, battle, axis, rng) || [];
      battle.tookAny = got.length > 0;
    }
    phase = 'queue';
    render();
  }

  // ---- 受け入れ／誅殺／送還
  function renderQueue() {
    const q = world.borderQueue;
    if (!q.length) {
      // 捕虜がゼロ（殲滅）でもここを通る。戦争の締めは必ず実行する。
      if (api.settleWar) api.settleWar(world, battle);
      mount(body, 
        el('div', { class: 'card' },
          el('h4', {}, q.length === 0 && !battle.tookAny ? '取り分がなかった' : '国境の処理が終わった'),
          el('p', {}, '戦争終了時に実施したので国民への通達はない。感情変数は動いていない。'
            + '一度国に入れたあとに殺せば、それは粛清として返ってくる。'),
        ),
        el('button', { class: 'btn primary block', onclick: () => { m.close(); ctx.afterBorder(); } }, '世界へ戻る'),
      );
      return;
    }

    mount(body, 
      el('p', { class: 'hint' },
        battle.outcome === 'win' ? opt.note : '負けたので相手の全プールからの抽選になった。'),
      el('div', { class: 'card', style: { borderColor: '#4a3c1c', background: '#171207' } },
        el('p', {}, '見えるのは相手国内での順位階級だけ。'
          + '弱小国の上位1%が、こちらでは平均以下ということが起きる。'
          + '忠誠も未発現の才能も、この数字には入っていない。'),
      ),
    );

    for (const c of [...q]) {
      const rank = api.publicRank(world, c);
      const card = el('div', { class: 'card' });
      mount(card, 
        el('div', { style: { display: 'flex', gap: '11px', alignItems: 'center' } },
          portrait(world, c, 40),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('h4', { style: { margin: 0 } }, c.name),
            el('p', {}, `${c.homeName} ・ ${c.age}歳`),
            el('div', { class: 'tagrow' },
              ...Object.keys(c.lineage || {}).map(k => el('span', {
                class: 'tag',
                style: { borderColor: swatchColor(world, k) },
              }, `${strainName(world, k)} ${Math.round(c.lineage[k] * 100)}%`)),
            ),
          ),
          el('div', { style: { textAlign: 'right' } },
            el('div', { class: 'mut', style: { fontSize: '10px' } }, '相手国内での階級'),
            el('div', { class: 'rank' }, rank.label)),
        ),
        el('div', { style: { display: 'flex', gap: '7px', marginTop: '10px' } },
          el('button', { class: 'btn primary', style: { flex: 1 }, onclick: () => decide(c, 'accept') }, '受け入れる'),
          el('button', { class: 'btn danger', style: { flex: 1 }, onclick: () => decide(c, 'execute') }, '誅殺する'),
          el('button', { class: 'btn', style: { flex: 1 }, onclick: () => decide(c, 'return') }, '送り返す'),
        ),
        el('div', { class: 'kv', style: { marginTop: '7px' } },
          el('div', { class: 'k' }, '受け入れる'), el('div', { class: 'v', style: { fontWeight: 400 } }, '体が増える。怨恨と異文化も入る。混ぜれば色が溶ける。'),
          el('div', { class: 'k' }, '誅殺する'), el('div', { class: 'v', style: { fontWeight: 400 } }, '無料。ただし遺伝子が世界から永久に消える。'),
          el('div', { class: 'k' }, '送り返す'), el('div', { class: 'v', style: { fontWeight: 400 } }, '得はない。世界の遺伝子プールだけが保存される。'),
        ),
      );
      body.appendChild(card);
    }
  }

  function decide(c, d) {
    api.borderDecision(world, c.id, d);
    toast(d === 'accept' ? `${c.name} を国に入れた`
      : d === 'execute' ? `${c.name} を誅殺した` : `${c.name} を送り返した`,
      d === 'execute' ? 'bad' : '');
    render();
  }

  render();
  return m;
}
