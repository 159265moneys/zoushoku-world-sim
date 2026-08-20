#!/usr/bin/env node
// ============================================================================
// flow.js — 継ぎ目の検査（G-01〜G-23）。REQUIREMENTS 8-2 / 10章 段0。
//
//   node game/test/flow.js                 全23項目
//   node game/test/flow.js --quick         種を減らして数秒で回す
//   node game/test/flow.js --only G-04,G-07
//   node game/test/flow.js --route ui      flow/ があっても旧UI経路で測る
//   node game/test/flow.js --json          機械可読の1行JSONも出す
//   node game/test/flow.js --strict        緑でないものがあれば exit 1
//   node game/test/flow.js --time          所要時間も出す（出力が非決定になる）
//
// 【この検査が見ているもの】
//   sim ではなく **継ぎ目**。sim単体とUI単体をいくら検証しても、繋いだ状態は
//   検証されない。13項目が緑のままゲームが起動していなかった実例がある。
//   だから世界に触るときは必ず `flow-route.js`（＝UIが実際に踏む経路）を通す。
//   sim を直接叩く検査をここに書いてはいけない。
//
// 【出方】
//   1項目1行で 緑 / 赤 / 未実装 のどれか。最後に「n/23 緑」。
//   未実装＝経路にその入口がまだ無くて測れないもの（赤とは別に数える）。
//
// 絶対規則：Math.random() を書かない / Date.now() に依存した挙動を書かない。
// ============================================================================

import { openRoute, scanWarCallSites, WAR_ENTRY_ALLOW } from './flow-route.js';
import { mean, round, maxOf, minOf } from './lib/util.js';

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const [k, inline] = t.slice(2).split('=');
    const next = argv[i + 1];
    if (inline !== undefined) a[k] = inline;
    else if (next !== undefined && !next.startsWith('--')) { a[k] = next; i++; }
    else a[k] = true;
  }
  return a;
}
const ARG = parseArgs(process.argv.slice(2));
const QUICK = !!ARG.quick;
const num = (k, d) => (ARG[k] !== undefined ? Number(ARG[k]) : d);

const CONF = {
  village: num('village-seeds', QUICK ? 6 : 20),   // G-01〜G-03
  war: num('war-seeds', QUICK ? 8 : 40),           // G-04〜G-08 / G-19 / G-23
  tribe: num('tribe-seeds', QUICK ? 4 : 16),       // G-09〜G-11 / G-14〜G-16 / G-22
  det: num('det-seeds', QUICK ? 3 : 6),            // G-17
  tribeGens: num('tribe-gens', QUICK ? 24 : 40),   // P2 を何世代ぶん回すか
  growCap: 30,                                     // 村がいっぱいになるまでの上限世代
};

// 種は固定。実行のたびに同じ歴史が出ること（R-001）。
const seedAt = (i) => ((20260819 + i * 7919) >>> 0);
const seeds = (n) => Array.from({ length: n }, (_, i) => seedAt(i));

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const PASS = 'PASS', FAIL = 'FAIL', TODO = 'TODO';
const MARK = { PASS: '緑  ', FAIL: '赤  ', TODO: '未実装' };

const ok = (note) => ({ state: PASS, note });
const ng = (note) => ({ state: FAIL, note });
const todo = (note) => ({ state: TODO, note });

const fmtList = (xs, n = 6) => {
  const s = xs.slice(0, n).join(',');
  return xs.length > n ? `${s},…` : s;
};
const pctOf = (a, b) => (b ? `${a}/${b}` : `${a}/0`);

// ---------------------------------------------------------------------------
// 標本（corpus）。必要になったものだけ作る。
// ---------------------------------------------------------------------------
function makeCorpora(route) {
  const cache = new Map();
  const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };

  /** 村：上限に着くまで ＋ 着いてから480tick 押してみる */
  const village = () => memo('village', () => seeds(CONF.village).map(seed => {
    const run = route.newRun(seed);
    const got = run.growUntilFull(CONF.growCap);
    const popAtFull = run.pop();
    const before = { pop: run.pop(), gen: run.gen(), skill: skillSum(run.world) };
    const moved = run.pushTicks(480);
    const after = { pop: run.pop(), gen: run.gen(), skill: skillSum(run.world) };
    return { seed, ...got, popAtFull, freeze: { moved, before, after } };
  }));

  /** 初戦：上限に着いた世界で、画面が薦める相手（国力いちばん下）と1戦 */
  const firstWar = () => memo('firstWar', () => seeds(CONF.war).map(seed => {
    const run = route.newRun(seed);
    const grew = run.growUntilFull(CONF.growCap);
    const targets = run.targets();
    // G-19：顔ぶれを2回出しても乱数が動かないこと
    const s0 = run.rng.s;
    const p1 = run.plannedForce(targets[0] ?? null);
    const s1 = run.rng.s;
    const p2 = run.plannedForce(targets[0] ?? null);
    const s2 = run.rng.s;
    const rec = run.warOnce({ target: targets[0] ?? null });
    return { seed, grew, targets: targets.length, rec, rngStable: (s0 === s1 && s1 === s2), plan: [p1, p2] };
  }));

  /** 部族：初戦を終えてから、戦えるときに戦いながら100体を目指す */
  const tribe = () => memo('tribe', () => seeds(CONF.tribe).map(seed => {
    const run = route.newRun(seed);
    run.growUntilFull(CONF.growCap);
    const first = run.warOnce({ target: run.targets()[0] ?? null });
    const wars = [];
    let minPop = run.pop(), gensInTribe = 0, hitHundred = null, blockedSample = null;
    for (let i = 0; i < CONF.tribeGens; i++) {
      run.advance();
      if (run.phase() !== 1) gensInTribe++;
      minPop = Math.min(minPop, run.pop());
      if (hitHundred == null && run.pop() >= 100) hitHundred = gensInTribe;
      if (hitHundred != null) break;
      if (run.phase() === 1) continue;
      const why = run.warReason();
      if (!why || !why.ok) continue;
      const t = run.targets()[0] ?? null;
      const rec = run.warOnce({ target: t });
      wars.push(rec);
      // 直後は不応期。ここで理由と残り時間が返るか（G-22）
      if (!blockedSample) {
        const after = run.warReason();
        if (after && !after.ok) blockedSample = after;
      }
      minPop = Math.min(minPop, run.pop());
    }
    return { seed, first, wars, minPop, gensInTribe, hitHundred, blockedSample, pop: run.pop(), phase: run.phase() };
  }));

  /** 降伏：2ラウンド目で降りる */
  const surrender = () => memo('surrender', () => seeds(Math.min(8, CONF.war)).map(seed => {
    const run = route.newRun(seed);
    run.growUntilFull(CONF.growCap);
    const rec = run.warOnce({ target: run.targets()[0] ?? null, surrenderAtRound: 2 });
    return { seed, rec };
  }));

  /** 決定性：同じ種で2回、同じ道を歩く */
  const determinism = () => memo('det', () => seeds(CONF.det).map(seed => {
    const sig = () => {
      const run = route.newRun(seed);
      run.growUntilFull(CONF.growCap);
      const rec = run.warOnce({ target: run.targets()[0] ?? null });
      const w = run.world;
      return [
        `gen=${w.gen}`, `pop=${w.people.size}`, `food=${Math.round(w.food)}`,
        `morale=${Math.round((w.morale ?? 0) * 1000)}`,
        `size=${rec.homeN}対${rec.awayN}`, `rounds=${rec.rounds}`,
        `out=${rec.outcome}`, `cap=${rec.captives}`,
      ].join(' ');
    };
    const a = sig(), b = sig();
    return { seed, a, b, same: a === b };
  }));

  /** 人口0で開戦を頼む */
  const pop0 = () => memo('pop0', () => seeds(3).map(seed => {
    const run = route.newRun(seed);
    run.growUntilFull(CONF.growCap);
    const t = run.targets()[0] ?? null;
    run.emptyWorld();
    const rec = run.warOnce({ target: t });
    return { seed, rec, pop: run.pop() };
  }));

  /** 世代境界ごとの prev（R-941） */
  const prev = () => memo('prev', () => {
    const run = route.newRun(seedAt(0));
    if (run.prev() === undefined) {
      // 1世代進めても持たないなら、その層が無いということ
      run.advance();
      if (run.prev() === undefined) return { has: false, rows: [] };
    }
    const rows = [];
    // **世代が実際に動いたときだけ数える。**
    //   聞いているのは「世代境界のたびに prev が1つ前の値になっているか」なので、
    //   境界が来ていない回を1件に数えると、村がいっぱいで時計が止まっている
    //   （R-956 が正しく効いている）だけで赤くなる。段0の版は UI 経路が
    //   一度も止まらないので、この違いが出なかった。
    for (let i = 0; i < 12 && rows.length < 6; i++) {
      const before = snapshot(run.world);
      const g0 = run.gen();
      run.advance();
      if (run.gen() === g0) break;              // 世界が止まっている＝境界が来ていない
      rows.push({ before, prev: run.prev() });
    }
    return { has: rows.length > 0, rows };
  });

  return { village, firstWar, tribe, surrender, determinism, pop0, prev };
}

function skillSum(w) {
  let s = 0;
  for (const p of w.people.values()) for (const k in (p.skills || {})) s += p.skills[k];
  return round(s, 3);
}
function snapshot(w) {
  return {
    pop: w.people.size, food: round(w.food, 3), morale: round(w.morale ?? 0, 4),
    yieldRate: round(w.yieldRate ?? w.yield ?? 0, 4), consumption: round(w.consumption ?? 0, 4),
  };
}

// ---------------------------------------------------------------------------
// G-01 〜 G-23
// ---------------------------------------------------------------------------
const CHECKS = [
  {
    id: 'G-01', need: 'village',
    title: '上限に着いた時点の人口が全件ちょうど10',
    run: (C) => {
      const rows = C.village();
      const pops = rows.map(r => r.popAtFull);
      const good = pops.filter(p => p === 10).length;
      const note = `${pctOf(good, pops.length)} 件が10。実測 ${minOf(pops)}〜${maxOf(pops)}（${fmtList(pops)}）`;
      return good === pops.length ? ok(note) : ng(`${note} — 人口を10で止める層が無い（R-954）`);
    },
  },
  {
    id: 'G-02', need: 'village',
    title: '上限までの世代（平均3〜5・最遅8以内・未到達0件）',
    run: (C) => {
      const rows = C.village();
      const unreached = rows.filter(r => !r.reached);
      const gens = rows.filter(r => r.reached).map(r => r.gens);
      const m = round(mean(gens), 2), worst = maxOf(gens, 0);
      const note = `平均 ${m} / 最遅 ${worst} / 未到達 ${unreached.length}件`;
      const good = unreached.length === 0 && m >= 3 && m <= 5 && worst <= 8;
      return good ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-03', need: 'village',
    title: 'いっぱいの村で tick を480回押しても1回も進まない',
    run: (C) => {
      const rows = C.village();
      const moved = rows.map(r => r.freeze.moved);
      const bad = rows.filter(r => r.freeze.moved > 0);
      const lost = rows.filter(r => r.freeze.after.pop < r.freeze.before.pop).length;
      const trained = rows.filter(r => r.freeze.after.skill > r.freeze.before.skill).length;
      const note = `進んだtick ${minOf(moved)}〜${maxOf(moved)}（0であること）。`
        + `そのあいだに人が減った世界 ${lost}/${rows.length}・練度が伸びた世界 ${trained}/${rows.length}`;
      return bad.length === 0 ? ok(note) : ng(`${note} — VILLAGE_FULL で時計を止める層が無い（R-956）`);
    },
  },
  {
    id: 'G-04', need: 'firstWar',
    title: '初戦の出撃数が全件 5対5',
    run: (C) => {
      const rows = C.firstWar().filter(r => r.rec.ok);
      const bad = rows.filter(r => r.rec.homeN !== 5 || r.rec.awayN !== 5);
      const note = `${pctOf(rows.length - bad.length, rows.length)} 件が5対5`
        + (bad.length ? `。ずれ：${fmtList(bad.map(b => `${b.rec.homeN}対${b.rec.awayN}`))}` : '');
      return bad.length === 0 ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-05', need: 'firstWar',
    title: '初戦の捕虜が全件ちょうど1体',
    run: (C) => {
      const rows = C.firstWar().filter(r => r.rec.ok);
      const caps = rows.map(r => r.rec.captives);
      const good = caps.filter(c => c === 1).length;
      const note = `${pctOf(good, caps.length)} 件が1体（実測 ${minOf(caps)}〜${maxOf(caps)}）`;
      return good === caps.length ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-06', need: 'firstWar',
    title: '初戦の相手の練度の最大値が全件 0.30以下',
    run: (C) => {
      const rows = C.firstWar().filter(r => r.rec.ok);
      const mx = rows.map(r => round(r.rec.foeSkillMax, 3));
      const bad = mx.filter(v => v > 0.30);
      const note = `最大 ${maxOf(mx, 0)} / 中央 ${round(median(mx), 3)}。0.30超え ${bad.length}/${mx.length}件`;
      return bad.length === 0 ? ok(note)
        : ng(`${note} — 初戦の相手が「隣村」ではなくロスターの国のまま（R-958）`);
    },
  },
  {
    id: 'G-07', need: 'firstWar',
    title: '戦闘画面が閉じる時点の戦死数 ＝ 世界から実際に消えた数',
    run: (C) => {
      const rows = C.firstWar().filter(r => r.rec.ok);
      const shown = rows.reduce((s, r) => s + r.rec.deathsShownAtClose, 0);
      const real = rows.reduce((s, r) => s + r.rec.worldDeaths, 0);
      const bad = rows.filter(r => r.rec.deathsShownAtClose !== r.rec.worldDeaths);
      const note = `画面 ${shown}体 / 実際 ${real}体。食い違った戦 ${bad.length}/${rows.length}`;
      return bad.length === 0 ? ok(note)
        : ng(`${note} — 戦死が確定する settleWar より前に画面を閉じている（R-952 S3）`);
    },
  },
  {
    id: 'G-08', need: 'firstWar',
    title: '捕虜に取った個体が、そのあと dead になっていない',
    run: (C) => {
      const rows = C.firstWar().filter(r => r.rec.ok);
      const corpse = rows.reduce((s, r) => s + r.rec.captivesFromCorpse, 0);
      const missing = rows.reduce((s, r) => s + r.rec.captivesMissing, 0);
      const total = rows.reduce((s, r) => s + r.rec.captives, 0);
      // 追い討ちで死ぬのは負けた側なので、**こちらが勝った戦でしか起きない**。
      // 標本に勝ち戦が何件あるかを必ず添える（0件なら、この検査は今回空振りしている）。
      const won = rows.filter(r => r.rec.outcome === 'win').length;
      const note = `${corpse}/${total} 体が「戦場では既に死んでいる体」。`
        + `入国したのに世界にいない ${missing}体（標本の勝ち戦 ${won}/${rows.length}）`;
      return (corpse === 0 && missing === 0) ? ok(note)
        : ng(`${note} — settleWar（追い討ち）より前に引いている（R-952 S7）`);
    },
  },
  {
    id: 'G-09', need: 'tribe',
    title: 'ロスターの国と戦うと相手世界の人口が減る',
    run: (C) => {
      const wars = allWars(C.tribe()).filter(r => r.ok && r.oppPopBefore != null);
      if (!wars.length) return todo('部族フェーズで国と戦えた戦が1つも無い（先に G-14/G-15 を見る）');
      const dropped = wars.filter(r => r.oppPopAfter < r.oppPopBefore).length;
      const note = `${pctOf(dropped, wars.length)} 戦で相手の人口が減った`;
      return dropped === wars.length ? ok(note)
        : ng(`${note} — applySideLosses が相手世界に呼ばれていない（R-953 / R-952 S4）`);
    },
  },
  {
    id: 'G-10', need: 'tribe',
    title: '相手の出撃数 ÷ 自軍の出撃数 が全件 2.0以下',
    run: (C) => {
      const wars = allWars(C.tribe()).filter(r => r.ok && r.homeN > 0);
      if (!wars.length) return todo('部族フェーズの戦が1つも無い');
      const ratios = wars.map(r => round(r.awayN / r.homeN, 2));
      const bad = ratios.filter(v => v > 2.0);
      const note = `中央 ${round(median(ratios), 2)} / 最大 ${maxOf(ratios)}。2.0超え ${bad.length}/${ratios.length}戦`;
      return bad.length === 0 ? ok(note) : ng(`${note} — 相手の出撃上限（自軍の1.5倍）が無い（R-963①）`);
    },
  },
  {
    id: 'G-11', need: 'tribe',
    title: '相手の戦場に age<2 の個体がいない',
    run: (C) => {
      const wars = allWars(C.tribe()).filter(r => r.ok);
      if (!wars.length) return todo('部族フェーズの戦が1つも無い');
      const infants = wars.reduce((s, r) => s + r.foeAges.filter(a => a < 2).length, 0);
      const heads = wars.reduce((s, r) => s + r.foeAges.length, 0);
      const note = `${infants}/${heads} 体が乳児（age<2）`;
      return infants === 0 ? ok(note) : ng(`${note} — 相手ビューを age>=2 で絞っていない（R-963）`);
    },
  },
  {
    id: 'G-12', need: 'surrender',
    title: '降伏したとき world.food が引かれるのは1回だけ',
    run: (C) => {
      const rows = C.surrender().filter(r => r.rec.ok);
      const counts = rows.map(r => r.rec.foodWrites.filter(([a, b]) => b < a).length);
      const writes = rows.map(r => r.rec.foodWrites.length);
      const bad = counts.filter(c => c > 1).length;
      const zero = counts.filter(c => c === 0).length;
      const note = `実際に減った回数 ${fmtList(counts)}（1回であること）。0回 ${zero}件・2回以上 ${bad}件`
        + `／food への書き込み自体は ${fmtList(writes)} 回`;
      if (bad) return ng(`${note} — UIの引き算と settleWar の二重引き（R-962）`);
      return ok(`${note}　※UI側の引き算が無害なのは adapter が代価を落として 0 にしているから（G-13参照）。`
        + `G-13 を直して引き算を消し忘れると、ここが赤くなる`);
    },
  },
  {
    id: 'G-13', need: 'surrender',
    title: '降伏の選択肢が画面に3つ届く',
    run: (C) => {
      const rows = C.surrender().filter(r => r.rec.ok && r.rec.surrenderOptions != null);
      if (!rows.length) return todo('降伏まで届いた戦が無い');
      const counts = rows.map(r => r.rec.surrenderOptions);
      const bad = counts.filter(c => c !== 3).length;
      const note = `届いた選択肢の数 ${fmtList(counts)}（3であること）`;
      return bad === 0 ? ok(note)
        : ng(`${note} — adapter が options を落として {food:0,captives:0} に潰している（R-962）`);
    },
  },
  {
    id: 'G-14', need: 'tribe',
    title: '部族を回して人口が5未満に落ちた世界が0件',
    run: (C) => {
      const rows = C.tribe();
      const bad = rows.filter(r => r.minPop < 5);
      const note = `最小人口 ${fmtList(rows.map(r => r.minPop))}。5未満 ${bad.length}/${rows.length}件`;
      return bad.length === 0 ? ok(note) : ng(`${note} — 最低人口16・不応期2世代・出撃上限が無い（R-963）`);
    },
  },
  {
    id: 'G-15', need: 'tribe',
    title: '人口100までの世代（平均7〜11・未到達3件以内）',
    run: (C) => {
      const rows = C.tribe();
      const hit = rows.filter(r => r.hitHundred != null);
      const miss = rows.length - hit.length;
      const m = hit.length ? round(mean(hit.map(r => r.hitHundred)), 2) : null;
      const note = `到達 ${hit.length}/${rows.length}（平均 ${m ?? '—'}世代・未到達 ${miss}件／${CONF.tribeGens}世代打ち切り）`;
      const good = miss <= 3 && m != null && m >= 7 && m <= 11;
      return good ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-16', need: 'tribe',
    title: '部族の1戦あたりの捕虜が全件1〜5体',
    run: (C) => {
      const wars = allWars(C.tribe()).filter(r => r.ok);
      if (!wars.length) return todo('部族フェーズの戦が1つも無い');
      const caps = wars.map(r => r.captives);
      const bad = caps.filter(c => c < 1 || c > 5).length;
      const note = `${pctOf(caps.length - bad, caps.length)} 戦が1〜5体（平均 ${round(mean(caps), 2)}）`;
      return bad === 0 ? ok(note) : ng(`${note} — 0体の戦が ${caps.filter(c => c === 0).length}件`);
    },
  },
  {
    id: 'G-17', need: 'determinism',
    title: '同じ種で2回まわすと歴史が一致する',
    run: (C) => {
      const rows = C.determinism();
      const bad = rows.filter(r => !r.same);
      const note = `${pctOf(rows.length - bad.length, rows.length)} 件が一致`
        + (bad.length ? `。例：${bad[0].a} ／ ${bad[0].b}` : `（例：${rows[0].a}）`);
      return bad.length === 0 ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-18', need: null,
    title: '戦争4関数の呼び口が flow/war.js の1か所だけ（静的検査）',
    run: async () => {
      const hits = await scanWarCallSites();
      const byFile = new Map();
      for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
      const list = [...byFile].map(([f, n]) => `${f}(${n})`).join(' ');
      const note = `呼び口 ${hits.length}件${hits.length ? `：${list}` : ''}　許可：${WAR_ENTRY_ALLOW.join(' / ')}`;
      return hits.length === 0 ? ok(note) : ng(`${note} — R-951`);
    },
  },
  {
    id: 'G-19', need: 'firstWar',
    title: '「出す顔ぶれ」を2回出しても乱数が動かない',
    run: (C) => {
      const rows = C.firstWar();
      if (rows.every(r => r.plan[0] == null)) return todo('顔ぶれを出す入口が経路に無い');
      const bad = rows.filter(r => !r.rngStable);
      const diff = rows.filter(r => r.plan[0] && r.plan[1] && r.plan[0].n !== r.plan[1].n);
      const note = `乱数が動いた ${bad.length}/${rows.length}件・2回の答えが違った ${diff.length}件`;
      return (bad.length === 0 && diff.length === 0) ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-20', need: 'pop0',
    title: '人口0で戦争を頼んでも開戦しない',
    run: (C) => {
      const rows = C.pop0();
      const started = rows.filter(r => r.rec.ok);
      const note = started.length
        ? `${started.length}/${rows.length} 件で開戦してしまう（${fmtList(started.map(s => `${s.rec.homeN}対${s.rec.awayN}`))}）`
        : `${rows.length}/${rows.length} 件で開戦しなかった`;
      return started.length === 0 ? ok(note) : ng(`${note} — R-965`);
    },
  },
  {
    id: 'G-21', need: 'prev',
    title: '世代境界のたびに prev が1つ前の値になっている',
    run: (C) => {
      const d = C.prev();
      if (!d.has) return todo('前の世代の値を持つ層（run.prev / R-941）がまだ無い');
      const bad = d.rows.filter(r => !samePrev(r.before, r.prev));
      const note = `${pctOf(d.rows.length - bad.length, d.rows.length)} 件が一致`;
      return bad.length === 0 ? ok(note) : ng(note);
    },
  },
  {
    id: 'G-22', need: 'tribe',
    title: '「戦いに行く」が押せないとき、理由と残り時間が返る',
    run: (C) => {
      const rows = C.tribe().filter(r => r.blockedSample);
      if (!rows.length) {
        // 戦のあとに必ず不応期が来るはずなので、標本が取れないこと自体が異常
        const anyWar = allWars(C.tribe()).length;
        return anyWar
          ? ng('戦の直後でも「押せない」状態が観測できない（不応期が無い）')
          : todo('部族フェーズの戦が1つも無く、押せない状態を観測できない');
      }
      const withReason = rows.filter(r => r.blockedSample.reason != null).length;
      const withTime = rows.filter(r => r.blockedSample.remainMs != null).length;
      const note = `理由が返った ${pctOf(withReason, rows.length)}・残り時間が返った ${pctOf(withTime, rows.length)}`;
      return (withReason === rows.length && withTime === rows.length) ? ok(note)
        : ng(`${note} — いまは warReady の真偽値だけ（R-943 / 07-A-3）`);
    },
  },
  {
    id: 'G-23', need: 'tribe',
    title: '開戦前の「出す顔ぶれ」の人数 ＝ startWar 後の home.units.length',
    run: (C) => {
      const wars = allWars(C.tribe()).filter(r => r.ok && r.plannedN != null);
      if (!wars.length) return todo('開戦前に顔ぶれを出す段が経路に無い（R-944 の1画面が未実装）');
      const bad = wars.filter(r => r.plannedN !== r.homeN);
      const note = `${pctOf(wars.length - bad.length, wars.length)} 戦が一致`;
      if (wars.every(r => r.plannedSynthetic)) {
        return todo(`開戦前に顔ぶれを出す画面がまだ無い（R-944）。`
          + `参考：selectDeployment の人数と home.units は ${note}`);
      }
      return bad.length === 0 ? ok(note) : ng(note);
    },
  },
];

function allWars(rows) {
  const out = [];
  for (const r of rows) { if (r.first) out.push(r.first); for (const w of r.wars) out.push(w); }
  // 初戦はゴースト／隣村なので、国どうしの検査（G-09〜G-11）では混ぜたくない。
  // ここでは初戦も含めた全戦を返し、必要な検査側で firstWar を見て弾く。
  return out.filter(w => !w.firstWar);
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function samePrev(before, prev) {
  if (!prev) return false;
  for (const k of ['pop', 'food', 'morale']) {
    if (prev[k] == null) return false;
    if (round(prev[k], 3) !== round(before[k], 3)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 走らせる
// ---------------------------------------------------------------------------
async function main() {
  const t0 = ARG.time ? process.hrtime.bigint() : null;
  const route = await openRoute({ prefer: ARG.route === 'ui' ? 'ui' : 'flow' });
  const C = makeCorpora(route);

  const only = ARG.only ? String(ARG.only).split(',').map(s => s.trim().toUpperCase()) : null;
  const picked = CHECKS.filter(c => !only || only.includes(c.id));

  const head = [];
  head.push('増殖 継ぎ目の検査（G-01〜G-23）');
  head.push(`  経路   ${route.label}${route.hasFlow ? '' : '　※' + (route.note ?? '')}`);
  if (route.warn) head.push(`  警告   ${route.warn}`);
  head.push(`  種     村 ${CONF.village} / 初戦 ${CONF.war} / 部族 ${CONF.tribe}（${CONF.tribeGens}世代）/ 決定性 ${CONF.det}`);
  head.push('');
  process.stdout.write(head.join('\n') + '\n');

  const results = [];
  for (const c of picked) {
    let r;
    try {
      r = await c.run(C);
    } catch (e) {
      r = { state: FAIL, note: `検査が例外で落ちた：${e && e.message ? e.message : e}` };
      if (ARG.trace) console.error(e);
    }
    results.push({ id: c.id, title: c.title, ...r });
    process.stdout.write(`${c.id}  ${MARK[r.state]}  ${c.title}\n`);
    process.stdout.write(`              ${r.note}\n`);
  }

  const green = results.filter(r => r.state === PASS).length;
  const red = results.filter(r => r.state === FAIL).length;
  const grey = results.filter(r => r.state === TODO).length;
  process.stdout.write('\n' + '-'.repeat(72) + '\n');
  process.stdout.write(picked.length === CHECKS.length
    ? `${green}/${CHECKS.length} 緑　（赤 ${red} ・ 未実装 ${grey}）\n`
    : `${green}/${picked.length} 緑　（赤 ${red} ・ 未実装 ${grey}）`
      + `　※--only で ${picked.length}/${CHECKS.length} 項目だけまわした\n`);
  if (red || grey) {
    process.stdout.write(`赤：${results.filter(r => r.state === FAIL).map(r => r.id).join(' ') || 'なし'}\n`);
    process.stdout.write(`未実装：${results.filter(r => r.state === TODO).map(r => r.id).join(' ') || 'なし'}\n`);
  }
  if (t0) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(`所要 ${(ms / 1000).toFixed(1)}s\n`);
  }
  if (ARG.json) {
    process.stdout.write(JSON.stringify({
      route: route.kind, green, red, grey, total: CHECKS.length,
      results: results.map(r => ({ id: r.id, state: r.state, note: r.note })),
    }) + '\n');
  }
  if (ARG.strict && (red || grey)) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 2; });
