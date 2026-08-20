// 画面9：戦闘。5対5が見える。逃げる／固まる／死ぬが分かる。
// 降伏ボタンは常に1つだけ画面にある（戦闘中の唯一の判断）。

import { el, clear, modal, num, pct, toast } from '../dom.js';
import { drawIndividual } from '../color.js';
import { openBorder } from './border.js';

const STEP_MS = 230;

export function openBattle(ctx, opponent) {
  const { world, api, rng } = ctx;
  const battle = api.startWar(world, rng, opponent);
  ctx.state.battle = battle;

  const canvas = el('canvas', { id: 'battlefield' });
  // どちらが自分かを色に頼らせない。自国の色は血すじで決まるので、
  // 相手より「弱そうな色」になることがある（実測：自分=赤・相手=緑で勝っているのに負けて見えた）。
  const cohA = cohesionRow(`あなた（${battle.a.name}）`, battle.a.hue);
  const cohB = cohesionRow(`相手（${battle.b.name}）`, battle.b.hue);
  const logBox = el('div', { id: 'blog' });
  const status = el('div', { class: 'mut', style: { fontSize: '13.5px' } }, '交戦中');
  const roster = el('div', { class: 'cols', style: { marginTop: '10px', gap: '14px' } });

  const surrenderBtn = el('button', { class: 'btn danger', onclick: doSurrender }, '降伏する');
  const nextBtn = el('button', { class: 'btn primary big', onclick: goNext, hidden: true }, '戦のあとを決める');

  const body = el('div', {},
    el('div', { class: 'lead-note' },
      'ここで出来ることは「降伏する」だけ。勝負は皆殺しではなく、'
      + '先に団結が 0 になったほうが崩れて終わる。'
      + '早く降りれば安く済み、粘るほど代償は大きくなる。'),
    canvas, cohA.row, cohB.row, logBox, roster,
  );

  const m = modal({
    title: `${battle.a.name} 対 ${battle.b.name}`,
    sub: `第 ${battle.gen} 世代`,
    body, cls: 'wide', dismissable: false,
    footer: [status, el('div', { style: { flex: 1 } }), surrenderBtn, nextBtn],
  });

  const ctx2 = canvas.getContext('2d');
  const foeWorld = { strains: battle.opponent.strains || { self: { hue: battle.b.hue } } };
  let acc = 0, last = performance.now(), raf = 0, logCount = 0, finished = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    canvas._w = r.width; canvas._h = r.height; canvas._dpr = dpr;
  }

  function draw() {
    if (!canvas._w) resize();
    const W = canvas._w, H = canvas._h;
    ctx2.setTransform(canvas._dpr, 0, 0, canvas._dpr, 0, 0);
    ctx2.clearRect(0, 0, W, H);

    // 中央線
    ctx2.strokeStyle = 'rgba(120,140,180,0.12)';
    ctx2.setLineDash([2, 7]); ctx2.beginPath();
    ctx2.moveTo(W / 2, 8); ctx2.lineTo(W / 2, H - 8); ctx2.stroke(); ctx2.setLineDash([]);

    for (const side of ['a', 'b']) {
      const s = battle[side];
      const wref = side === 'a' ? world : foeWorld;
      for (const f of s.fighters) {
        const x = f.x * W, y = f.y * H;
        const r = 15;
        if (f.state === 'dead') {
          ctx2.globalAlpha = 0.28;
          drawIndividual(ctx2, wref, f.ind, x, y, r * 0.8, { dead: true, fear: 1 });
          ctx2.globalAlpha = 1;
          ctx2.strokeStyle = 'rgba(226,96,74,0.7)'; ctx2.lineWidth = 1.4;
          ctx2.beginPath();
          ctx2.moveTo(x - 6, y - 6); ctx2.lineTo(x + 6, y + 6);
          ctx2.moveTo(x + 6, y - 6); ctx2.lineTo(x - 6, y + 6);
          ctx2.stroke();
          continue;
        }
        drawIndividual(ctx2, wref, f.ind, x, y, r, {
          fear: f.fear,
          ring: f.state === 'flee' ? 'rgba(232,178,74,0.95)' : (f.state === 'freeze' ? 'rgba(180,190,220,0.7)' : null),
        });
        // 体力
        ctx2.fillStyle = 'rgba(20,26,38,0.9)';
        ctx2.fillRect(x - 14, y + r + 4, 28, 3);
        ctx2.fillStyle = f.hp > 0.5 ? '#5fe3c4' : '#e2604a';
        ctx2.fillRect(x - 14, y + r + 4, 28 * Math.max(0, f.hp), 3);
        // 状態は円の横に出す。上に置くと隣の行の名前と重なって読めなくなる。
        if (f.state !== 'fight') {
          ctx2.font = '9px -apple-system, sans-serif';
          ctx2.fillStyle = f.state === 'flee' ? '#e8b24a' : '#b4becc';
          const t = f.state === 'flee' ? '逃走' : '硬直';
          ctx2.fillText(t, x + r + 5, y + 3.5);
        }
        ctx2.font = '9.5px -apple-system, sans-serif';
        ctx2.fillStyle = 'rgba(160,172,196,0.85)';
        const nm = f.name.length > 8 ? f.name.slice(0, 8) : f.name;
        ctx2.fillText(nm, x - ctx2.measureText(nm).width / 2, y + r + 16);
      }
    }
  }

  function syncLog() {
    while (logCount < battle.log.length) {
      const l = battle.log[logCount++];
      logBox.appendChild(el('div', { class: l.cls }, l.text));
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function syncRoster() {
    clear(roster);
    for (const side of ['a', 'b']) {
      const s = battle[side];
      const col = el('div');
      col.appendChild(el('div', { style: { fontSize: '14px', fontWeight: '700', marginBottom: '5px' } },
        side === 'a' ? `あなたの兵（${s.name}）` : `相手の兵（${s.name}）`));
      for (const f of s.fighters) {
        col.appendChild(el('div', { class: 'row' },
          el('div', { class: 'k' }, f.name),
          el('div', { class: 'v', style: { fontSize: '13px' } },
            f.state === 'dead' ? el('span', { class: 'tag bad' }, '戦死')
              : f.state === 'flee' ? el('span', { class: 'tag warn' }, '逃走')
              : f.state === 'freeze' ? el('span', { class: 'tag' }, '固まった')
              : el('span', { class: 'tag ac' }, '交戦'),
            el('span', { class: 'mut', style: { marginLeft: '6px' } }, `恐怖 ${Math.round(f.fear * 100)}`)),
        ));
      }
      roster.appendChild(col);
    }
  }

  function syncBars() {
    cohA.set(battle.a.cohesion);
    cohB.set(battle.b.cohesion);
  }

  function loop() {
    const now = performance.now();
    const dt = Math.min(160, now - last); last = now;
    if (!battle.over) {
      acc += dt;
      if (acc >= STEP_MS) { acc = 0; api.stepBattle(battle, rng); syncLog(); syncBars(); syncRoster(); }
    }
    draw();
    if (battle.over && !finished) finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    // 決着時は必ず最終状態を流し込む。ログ・団結・名簿が途中で止まって見えるのを防ぐ。
    syncLog(); syncBars(); syncRoster();
    nextBtn.hidden = false;
    surrenderBtn.disabled = true;
    const dead = battle.deaths.a.length;
    status.textContent = battle.outcome === 'win' ? `勝った。戦死 ${dead} 体。`
      : battle.outcome === 'surrender' ? `降伏した。戦死 ${dead} 体で止めた。`
      : `負けた。戦死 ${dead} 体。`;
    status.style.color = battle.outcome === 'lose' ? '#f0907c' : '#5fe3c4';
  }

  function doSurrender() {
    if (battle.over) return;
    const terms = api.surrender(battle);
    syncLog(); syncBars();
    if (!terms.accepted) {
      toast('降伏は拒否された。追撃が来る。', 'bad');
      return;
    }
    world.food = Math.max(0, world.food - terms.food);
    toast(`降伏。賠償：食料 ${terms.food} / 人 ${terms.captives}`, 'warn');
    finish();
  }

  function goNext() {
    clearInterval(raf);
    m.close();
    openBorder(ctx, battle);
  }

  resize();
  new ResizeObserver(resize).observe(canvas);
  syncLog(); syncBars(); syncRoster();
  // rAF ではなくタイマー。裏タブで戦闘が止まらないように。
  raf = setInterval(loop, 33);
  return m;
}

function cohesionRow(name, hue) {
  const fl = el('div', { class: 'fl', style: { width: '100%', background: `hsl(${hue} 62% 48%)` } });
  const nu = el('div', { class: 'nu' }, '100');
  const row = el('div', { class: 'cohes' },
    el('div', { class: 'lbl' }, `団結　${name}`),
    el('div', { class: 'tr' }, fl), nu);
  return {
    row,
    set(v) {
      fl.style.width = Math.max(0, Math.min(1, v)) * 100 + '%';
      nu.textContent = Math.round(v * 100);
      fl.style.background = v <= 0.34 ? '#e2604a' : `hsl(${hue} 62% 48%)`;
    },
  };
}
