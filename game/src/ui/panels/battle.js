// 画面9：戦闘。5対5が見える。逃げる／固まる／死ぬが分かる。
// 降伏ボタンは常に1つだけ画面にある（戦闘中の唯一の判断）。
//
// 【呼び口はここに1つも無い】
//   開戦（S0）・1ラウンド（S1）・降伏（S2）・締め（S3〜S5）は全部 `flow/war.js`。
//   この画面は「進行層に頼む → 返ってきた battle を絵に写す」だけをする（R-951）。
//   **締め（settle）が返るまでこのモーダルを閉じない**。戦死の85%は決着のあと、
//   敗走の追い討ちで出るので、先に閉じると「戦死0体」と言ってから3体が無言で消える
//   （R-952 S3→S5）。

import { el, clear, modal, num, pct, toast, clamp } from '../dom.js';
import { drawIndividual } from '../color.js';
import { openBorder } from './border.js';
import * as war from '../../flow/war.js';

const STEP_MS = 230;

export function openBattle(ctx, target) {
  const { world, api, run } = ctx;

  // S0：開戦。断られたら理由をそのまま出す（人口0・不応期・国境が残っている等）
  const sb = war.beginWar(run, target);
  if (!sb) {
    const why = run.refusal;
    toast(why && why.reason ? why.reason : '戦いに行けなかった。', 'bad');
    ctx.state.paused = false;
    ctx.refresh();
    return null;
  }
  const battle = api.viewBattle(sb, world, target);
  ctx.state.battle = battle;
  let priceIndex = 0;        // 降伏したときに選んだ代価（R-962）
  let awaitingPrice = false; // 3択に答えるまでは締めない

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
      // 円の大きさは**行の間隔から出す**。半径を 15 に固定すると、8行を詰めこんだとき
      // 行間（縦 288px なら 30px）より「半径＋名前の高さ」のほうが大きくなり、
      // 名前が次の行の円に重なって、名前も顔も読めなくなる。
      const rows = Math.max(1, s.rows || Math.min(s.fighters.length, 6));
      const gap = rows > 1 ? (0.74 * H) / (rows - 1) : H * 0.5;
      const r = clamp(gap * 0.33, 5.5, 15);
      const nameGap = Math.min(13, gap * 0.30);
      const nameSize = clamp(gap * 0.24, 8, 9.5);
      for (const f of s.fighters) {
        const x = f.x * W, y = f.y * H;
        if (f.state === 'dead') {
          ctx2.globalAlpha = 0.28;
          drawIndividual(ctx2, wref, f.ind, x, y, r * 0.8, { dead: true, fear: 1 });
          ctx2.globalAlpha = 1;
          ctx2.strokeStyle = 'rgba(226,96,74,0.7)'; ctx2.lineWidth = 1.4;
          const k = r * 0.4;
          ctx2.beginPath();
          ctx2.moveTo(x - k, y - k); ctx2.lineTo(x + k, y + k);
          ctx2.moveTo(x + k, y - k); ctx2.lineTo(x - k, y + k);
          ctx2.stroke();
          continue;
        }
        drawIndividual(ctx2, wref, f.ind, x, y, r, {
          fear: f.fear,
          ring: f.state === 'flee' ? 'rgba(232,178,74,0.95)' : (f.state === 'freeze' ? 'rgba(180,190,220,0.7)' : null),
        });
        // 体力
        const bw = r * 1.9;
        ctx2.fillStyle = 'rgba(20,26,38,0.9)';
        ctx2.fillRect(x - bw / 2, y + r + 3, bw, 3);
        ctx2.fillStyle = f.hp > 0.5 ? '#5fe3c4' : '#e2604a';
        ctx2.fillRect(x - bw / 2, y + r + 3, bw * Math.max(0, f.hp), 3);
        // 状態は円の横に出す。上に置くと隣の行の名前と重なって読めなくなる。
        if (f.state !== 'fight') {
          ctx2.font = `${nameSize.toFixed(1)}px -apple-system, sans-serif`;
          ctx2.fillStyle = f.state === 'flee' ? '#e8b24a' : '#b4becc';
          const t = f.state === 'flee' ? '逃走' : '硬直';
          ctx2.fillText(t, x + r + 5, y + 3.5);
        }
        ctx2.font = `${nameSize.toFixed(1)}px -apple-system, sans-serif`;
        ctx2.fillStyle = 'rgba(160,172,196,0.85)';
        const nm = f.name.length > 8 ? f.name.slice(0, 8) : f.name;
        ctx2.fillText(nm, x - ctx2.measureText(nm).width / 2, y + r + nameGap);
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
      // S1：1ラウンド。進めるのは進行層で、ここは絵を追いつかせるだけ。
      if (acc >= STEP_MS) { acc = 0; war.stepWar(run, sb); api.syncBattle(battle); syncLog(); syncBars(); syncRoster(); }
    }
    draw();
    if (battle.over && !finished && !awaitingPrice) finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    surrenderBtn.disabled = true;

    // S3〜S5：**ここで初めて戦死が確定する**（中で敗走の追い討ちが走る）。
    // 相手の世界にも書き戻される（S4）。画面はそのあとの姿を出す。
    let ok = true;
    try { war.settle(run, sb, { priceIndex }); }
    catch (e) { ok = false; console.error(e); toast('戦の締めに失敗した：' + e.message, 'bad'); }
    api.syncBattle(battle);

    // 決着時は必ず最終状態を流し込む。ログ・団結・名簿が途中で止まって見えるのを防ぐ。
    syncLog(); syncBars(); syncRoster();
    nextBtn.hidden = false;
    // 数えるのは画面の丸ではなく、世界に書き戻された数（battle.losses が唯一の出所）
    const L = (ok && sb.losses) ? sb.losses : { dead: battle.deaths.a.length, wounded: 0, fled: 0 };
    const tail = L.wounded || L.fled ? `（負傷 ${L.wounded} ・ 逃走 ${L.fled}）` : '';
    status.textContent = battle.outcome === 'win' ? `勝った。戦死 ${L.dead} 体。${tail}`
      : battle.outcome === 'surrender' ? `降伏した。戦死 ${L.dead} 体で止めた。${tail}`
      : `負けた。戦死 ${L.dead} 体。${tail}`;
    status.style.color = battle.outcome === 'lose' ? '#f0907c' : '#5fe3c4';
  }

  // S2：降伏。sim が出す3つの代価をそのまま出し、選んだ index を締めに渡す（R-962）。
  // **画面が world.food を自分で引かない**（締めでもう一度引かれて二重になる）。
  function doSurrender() {
    if (battle.over || awaitingPrice) return;
    const terms = war.surrenderWar(run, sb);
    if (!terms.accepted) {
      api.syncBattle(battle); syncLog(); syncBars(); syncRoster();
      toast('降伏は拒否された。追撃が来る。', 'bad');
      return;
    }
    api.markSurrender(battle, terms);
    syncLog(); syncBars(); syncRoster();
    const options = terms.options || [];
    if (options.length < 2) { finish(); return; }
    awaitingPrice = true;
    surrenderBtn.disabled = true;
    status.textContent = '降伏が受け入れられた。代価を選ぶ。';
    askPrice(options);
  }

  /** 代価の3択。押すまで締めない（押した瞬間に戦死が確定する）。 */
  function askPrice(options) {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h4', { style: { margin: '0 0 6px' } }, '降伏の代価をどれで払うか'));
    card.appendChild(el('p', {}, '早く降りれば安い。粘るほど高くつく。人で払うと、その体は戻らない。'));
    const row = el('div', { style: { display: 'flex', gap: '7px', marginTop: '8px' } });
    options.forEach((o, i) => {
      row.appendChild(el('button', {
        class: 'btn' + (i === 0 ? ' primary' : ''), style: { flex: 1 },
        onclick: () => {
          priceIndex = i;
          awaitingPrice = false;
          card.remove();
          toast(`降伏。代価：${o.label}（食料 ${o.food} ／ 人 ${o.captives}）`, 'warn');
          finish();
        },
      }, `${o.label}　食料 ${o.food} ／ 人 ${o.captives}`));
    });
    card.appendChild(row);
    body.insertBefore(card, logBox);
    // 戦場の下に入るので、そのままだと折りたたみの外に出ることがある。必ず見せる。
    card.scrollIntoView({ block: 'nearest' });
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
