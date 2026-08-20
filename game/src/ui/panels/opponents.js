// 画面11：対戦相手の選択。
//
// 相手を並べるのは進行層（flow/war.js の listTargets）。画面はそれを描くだけ（R-951）。
//   初戦     … 「隣の村」が3つ。**国力の数字を出さない。**出すのは色と一言だけ（R-958 / R-959）
//   それ以降 … ロスターの10国。国力は見せるが、構成・人口・思想は伏せる（R-206）
// 開発用のデバッグトグルを付けてあり、オンにすると思想名・人口・血統の色・内訳が見える。

import { el, clear, modal, num, mount, DEV } from '../dom.js';
import { lineageHue, swatchColor, strainName, homeHue } from '../color.js';
import * as war from '../../flow/war.js';

export function openOpponents(ctx, onPick, onCancel) {
  const { world, api, run, state } = ctx;
  const body = el('div');
  const dbg = () => !!state.rosterDebug;
  let picked = false;
  const pick = (t) => { picked = true; m.close(); onPick(t); };

  const mine = api.nationPower ? api.nationPower(world) : 0;
  // 相手候補。初戦かどうかも、人口8未満の国を外すのも、規模が釣り合わない国を外すのも
  // 進行層の判断（R-958 / R-963）。画面はここで一切えらばない。
  const list = war.listTargets(run) || [];
  const firstWar = war.warReason(run).firstWar;

  const render = () => {
    clear(body);

    body.appendChild(el('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      dot(homeHue(world), 22),
      el('div', { style: { flex: 1 } },
        el('h4', { style: { margin: 0 } }, world.name),
        el('p', {}, `第 ${world.gen} 世代 ・ ${world.people.size} 体`)),
      // 初戦の画面には強さの数字を1つも出さない（R-959）。自分のぶんも出さない。
      firstWar ? null : el('div', { style: { textAlign: 'right' } },
        el('div', { class: 'mut', style: { fontSize: '13px' } }, '国力'),
        el('div', { class: 'big' }, mine)),
    ));

    // 相手について何が見えないのかは、プレイヤー向けの説明。
    // 開発用のトグルはここに混ぜない（同じ行に並ぶと同じ種類のものだと読まれる）。
    body.appendChild(el('div', { class: 'lead-note' },
      dbg()
        ? '開発用の表示がオンになっている。本来は見えない中身が出ている。'
        : firstWar
          ? '隣にあるのは国ではない。あなたの村と同じくらいの村が3つあるだけ。'
          : '相手について分かるのは強さの数字ひとつだけ。人数も、どんな国かも見えない。'));

    if (!list.length) {
      // 進行層が「いま釣り合う相手がいない」と言っている。仮の相手を勝手に作らない。
      const why = war.warReason(run);
      body.appendChild(el('div', { class: 'empty' }, why.reason || 'いま戦える相手がいない。'));
      body.appendChild(el('button', { class: 'btn block', onclick: () => m.close() }, '戻る'));
      return;
    }

    // 「全員格上、では何を見て選ぶのか」に答える。
    // 初戦は進行層が同数・同格に揃えるので、そこだけは別の言い方をする。
    body.appendChild(el('div', { class: 'lead-note' },
      firstWar
        ? 'どれを選んでも 5対5 です。ちがうのは血の色だけ。'
        : '迷ったら、いちばん上（＝強さの数字がいちばん小さい相手）を選ぶ。'
          + '色が自分と遠い相手ほど、連れ帰った血が効く。'));

    let first = true;
    for (const o of list) {
      const hue = api.targetHue ? api.targetHue(o) : ((o.hue ?? 0) * 360);
      const power = Math.round(o.powerIndex ?? o.power ?? 0);
      const gap = mine ? power / mine : 1;
      const label = gap > 1.35 ? '格上' : gap > 1.08 ? 'やや格上' : gap > 0.92 ? '互角' : gap > 0.7 ? 'やや格下' : '格下';
      const cls = gap > 1.08 ? 'bad' : gap > 0.92 ? 'warn' : 'ac';

      const card = el('div', { class: 'card' });
      mount(card, el('div', { style: { display: 'flex', alignItems: 'center', gap: '11px' } },
        dot(hue, 20),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('h4', { style: { margin: 0 } }, o.name),
          el('p', {}, dbg() && o.profileName
            ? `${o.profileName}　${o.profileDesc || ''}`
            : (o.hint || 'どんな国かは分からない。')),
        ),
        // 初戦のカードに数字は無い。色と一言だけ（R-959）
        o.showPower === false ? null : el('div', { style: { textAlign: 'right', minWidth: '84px' } },
          el('div', { class: 'mut', style: { fontSize: '13px' } }, '国の強さ'),
          el('div', { class: 'rank' }, power),
          el('span', { class: 'tag ' + cls }, label)),
        el('button', { class: 'btn war', onclick: () => pick(o) },
          firstWar ? 'この村と戦う' : 'この国と戦う'),
      ));
      if (first && list.length > 1 && !firstWar) {
        card.insertBefore(el('div', { class: 'tag ac', style: { display: 'inline-block', marginBottom: '6px' } },
          'この中ではいちばん弱い'), card.firstChild);
      }
      first = false;

      // 混ざるとどうなるかを色で見せる
      card.appendChild(el('div', { class: 'ctl', style: { marginTop: '7px', gap: '9px' } },
        el('span', { class: 'mut', style: { fontSize: '13px' } }, '血が混ざると'),
        dot(homeHue(world), 13), el('span', { class: 'mut' }, '＋'), dot(hue, 13),
        el('span', { class: 'mut' }, '→'), dot(blend(homeHue(world), hue), 15),
        el('span', { class: 'mut' }, '→'), dot(blend(homeHue(world), blend(homeHue(world), hue)), 13),
        el('span', { class: 'mut', style: { fontSize: '13px' } }, '（世代が進むほど中間の色が増える）'),
      ));

      if (dbg()) {
        const w2 = o._world || o.world || null;
        if (w2 && w2.people) {
          const mix = strainMix(w2);
          card.appendChild(el('div', { class: 'kv', style: { marginTop: '7px' } },
            el('div', { class: 'k' }, '人口'), el('div', { class: 'v' }, w2.people.size),
            el('div', { class: 'k' }, '世代'), el('div', { class: 'v' }, w2.gen),
            el('div', { class: 'k' }, '戦場に出せる体'), el('div', { class: 'v' }, o.people ? o.people.length : '—'),
            el('div', { class: 'k' }, '備蓄'), el('div', { class: 'v' }, num(w2.food, 1)),
            el('div', { class: 'k' }, '民心'), el('div', { class: 'v' }, num(w2.morale, 2)),
            el('div', { class: 'k' }, '産出/消費'), el('div', { class: 'v' }, num(w2.consumption ? w2.yieldRate / w2.consumption : 1, 2)),
            el('div', { class: 'k' }, '国への恨み'), el('div', { class: 'v' }, num(w2.regimeGrudge, 2)),
          ));
          const bar = el('div', { style: { display: 'flex', height: '9px', borderRadius: '5px', overflow: 'hidden', marginTop: '6px' } });
          for (const [k, v] of mix) {
            bar.appendChild(el('div', { style: { width: (v * 100) + '%', background: swatchColor(w2, k) } }));
          }
          mount(card, bar, el('div', { class: 'mut', style: { fontSize: '13px', marginTop: '3px' } },
            mix.map(([k, v]) => `${strainName(w2, k)} ${Math.round(v * 100)}%`).join(' / ')));
          // 実際の個体の色を並べる
          const strip = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '6px' } });
          for (const p of [...w2.people.values()].slice(0, 40)) {
            strip.appendChild(dot(lineageHue(w2, p.lineage), 11));
          }
          card.appendChild(strip);
        } else if (o.people) {
          // 隣村ゴーストには世界が無い（走っている国ではないので当然）。顔ぶれだけ出す。
          const strip = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '6px' } });
          for (let i = 0; i < o.people.length; i++) strip.appendChild(dot(hue, 11));
          mount(card, el('div', { class: 'mut', style: { fontSize: '13px', marginTop: '6px' } },
            `出てくるのは ${o.people.length} 体・国力 ${Math.round(o.powerIndex ?? 0)}`), strip);
        }
      }
      body.appendChild(card);
    }

    body.appendChild(el('p', { class: 'hint' },
      firstWar
        ? '勝っても負けても、相手から1体を連れ帰る。その1体がよそ者の血を持ちこむ。'
        : '強さの数字は相手選びの目安でしかない。数字が上でも、出す顔ぶれを間違えれば負ける。'));

    // 開発用。?dev=1 のときだけ、いちばん下に分けて置く。
    if (DEV) {
      body.appendChild(el('div', { class: 'divider' }));
      body.appendChild(el('button', {
        class: 'btn sm' + (dbg() ? ' primary' : ''),
        onclick: () => { state.rosterDebug = !dbg(); render(); },
      }, dbg() ? '開発用：中身の開示 ON' : '開発用：中身の開示 OFF'));
    }
  };

  const m = modal({
    title: firstWar ? '隣の村' : '隣のシャーレ', sub: '相手を選ぶ', body, cls: 'wide',
    // 選ばずに閉じた場合だけ呼ぶ。呼び出し側は止めた時計をここで戻す。
    onClose: () => { if (!picked && onCancel) onCancel(); },
  });
  render();
  return m;
}

function dot(hue, size) {
  return el('i', {
    style: {
      width: size + 'px', height: size + 'px', borderRadius: '50%', display: 'inline-block',
      background: `hsl(${hue} 70% 52%)`, flex: '0 0 auto',
      boxShadow: '0 0 0 1px rgba(255,255,255,.12)',
    },
  });
}

function blend(a, b) {
  const ra = a * Math.PI / 180, rb = b * Math.PI / 180;
  let d = Math.atan2(Math.sin(ra) + Math.sin(rb), Math.cos(ra) + Math.cos(rb)) * 180 / Math.PI;
  return d < 0 ? d + 360 : d;
}

function strainMix(w) {
  const acc = {};
  let n = 0;
  for (const p of w.people.values()) {
    const L = p.lineage || { self: 1 };
    for (const k in L) acc[k] = (acc[k] || 0) + L[k];
    n++;
  }
  return Object.entries(acc).map(([k, v]) => [k, v / (n || 1)]).sort((a, b) => b[1] - a[1]);
}
