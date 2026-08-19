// ============================================================================
// p1.js — 第1フェーズ（始まりの村）の体験を検査項目にする。
//
// 設計文書「第1フェーズ：始まりの村」「なぜ30ではなく10か」が主張していること：
//
//   ・個体数2から始めて **10到達で終了**。実時間で5〜10分、**3〜4世代**
//   ・初戦は10体到達時。**5対5** ——「練度ゼロのパニックが見える。5対5なら、
//     攻撃力天才が恐怖で固まって死ぬのを目撃できる」
//   ・捕虜は **P1終了時1体**（SPEC「捕虜：P1終了時1体／P2は戦ごとに1〜5体」）
//   ・フェーズ2は「外来血の流入で幕を開ける」＝初戦の**後**に来る
//
// つまり正しい順序は  10体到達 → 初戦 → 戦後処理 → フェーズ2。
// 先にフェーズ2へ上がってしまうと、敵の規模も捕虜の数もP2の値で引かれ、
// 「5対5のパニック」という看板の場面がそもそも発生しない。
//
// ここはバランス調整ではなく**体験の形**の検査。数値がずれたら看板が壊れる。
// ============================================================================

import { RNG } from '../src/core/rng.js';
import { PHASE, PHASE_THRESHOLD } from '../src/core/model.js';
import { mean, round, pct, quantile, barChart, histogram, maxOf, minOf } from './lib/util.js';

const R = (id, title, claim) => ({ id, title, claim, status: 'SKIP', summary: '', detail: '', numbers: {} });

export const P1_TARGET = {
  popThreshold: PHASE_THRESHOLD?.[1] ?? 10,  // 村の終わり＝この人口
  gensToThreshold: [3, 4],                   // 3〜4世代で到達したい
  battleSide: 5,                             // 初戦は5対5
  battleTolerance: 1,                        // ±1まで
  captives: 1,                               // P1終了時の捕虜は1体
};

/**
 * 村を1つ、10体に達するまで回して初戦まで撃つ。
 * ゲームが辿る順序をそのまま再現する（オーナーは10体になった時点で初戦に出す）。
 */
export function playP1(api, seed, opts = {}) {
  const maxGens = opts.maxGens ?? 40;
  const TPG = api.TICKS_PER_GEN ?? 12;
  const rng = new RNG(((seed >>> 0) ^ 0x2f6a88c5) >>> 0);
  const answers = [];
  for (let i = 0; i < 12; i++) answers.push(rng.next());

  const out = {
    seed, series: [], reach10: null, firstWar: null,
    phaseAfterWar: null, error: null, extinct: false,
  };

  let world;
  try { world = api.createWorld(seed, answers); }
  catch (e) { out.error = `createWorld: ${e.message}`; return out; }

  out.series.push({ gen: world.gen, pop: world.people.size, phase: world.phase });

  for (let g = 0; g < maxGens; g++) {
    try {
      for (let t = 0; t < TPG; t++) api.stepTick(world, rng);
      api.advanceGeneration(world, rng);
    } catch (e) { out.error = `advanceGeneration(gen=${world.gen}): ${e.message}`; return out; }

    const pop = world.people.size;
    out.series.push({ gen: world.gen, pop, phase: world.phase });
    if (pop === 0) { out.extinct = true; return out; }

    if (pop >= P1_TARGET.popThreshold) {
      // ここが「10体到達」。この瞬間のフェーズが1でなければ順序が壊れている。
      out.reach10 = { gen: world.gen, pop, phase: world.phase };
      out.firstWar = fightFirstWar(api, world, rng, out);
      // 戦後にもう1世代進めて、フェーズがここで初めて2に上がるかを見る
      try {
        for (let t = 0; t < TPG; t++) api.stepTick(world, rng);
        api.advanceGeneration(world, rng);
        out.phaseAfterWar = world.phase;
      } catch (e) { out.error = `戦後の advanceGeneration: ${e.message}`; }
      return out;
    }
  }
  return out;   // maxGens 回しても10体に届かなかった
}

function fightFirstWar(api, world, rng, out) {
  if (!api.makeGhost || !api.startWar) return { error: 'makeGhost / startWar が無い' };
  const w = { phaseAtStart: world.phase };
  try {
    // ゲームと同じく、そのときのフェーズで相手を作る。
    // フェーズが既に2なら敵は12〜39体になる＝初戦が5対5にならない。
    const ghost = api.makeGhost((world.seed ^ 0xa5a5) >>> 0, world.phase, 1);
    const battle = api.startWar(world, rng, ghost);
    if (!battle) return { ...w, error: 'startWar が battle を返さない' };
    w.home = battle.sides?.home?.units?.length ?? battle.a?.fighters?.length ?? null;
    w.away = battle.sides?.away?.units?.length ?? battle.b?.fighters?.length ?? null;
    w.ghostSize = ghost.people?.length ?? ghost.size ?? null;

    let guard = 400;
    if (api.runBattle) api.runBattle(battle, rng);
    else while (!battle.over && guard-- > 0) api.stepBattle(battle, rng);
    w.rounds = battle.round ?? null;
    w.outcome = battle.outcome?.kind ?? null;
    w.winner = battle.outcome?.winner ?? null;

    if (api.settleWar) api.settleWar(world, battle, rng);
    // 捕虜。UI は captiveOptions で見せてから takeCaptives で引く。
    if (api.captiveOptions) {
      const o = api.captiveOptions(battle);
      w.optionsCount = o?.count ?? null;       // sim が公称する人数（あれば）
      w.optionsWinner = o?.winner ?? null;
    }
    if (api.takeCaptives) {
      const caps = api.takeCaptives(world, battle, '総合', rng) ?? [];
      w.captives = caps.length;
    }
    w.phaseAfterSettle = world.phase;
  } catch (e) {
    w.error = e.message;
  }
  return w;
}

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------
/**
 * P1 の検査が空振りでないことの証明。
 *
 * checkP1 はレコードの純関数なので、**壊れた序盤を捏造して食わせれば**
 * ちゃんと落ちるかを直接確かめられる。ここで使う数字は、修正前に実測された
 * 「初戦: 第6世代 / 人口11 / フェーズ2 / home 4 対 away 19 / 捕虜3体」そのもの。
 */
export function selfCheckP1() {
  const broken = [];
  for (let i = 0; i < 8; i++) {
    broken.push({
      seed: i, series: [], extinct: false, error: null,
      reach10: { gen: 6, pop: 11, phase: PHASE.TRIBE },   // ← 初戦前にもう部族
      phaseAfterWar: PHASE.TRIBE,
      firstWar: {
        phaseAtStart: PHASE.TRIBE, home: 4, away: 19, ghostSize: 19,
        rounds: 5, outcome: '崩壊', winner: 'home',
        optionsCount: 1, captives: 3,                    // ← 公称1体なのに3体来る
        phaseAfterSettle: PHASE.TRIBE,
      },
    });
  }
  const res = checkP1(broken);
  const byId = Object.fromEntries(res.map(x => [x.id, x.status]));
  const want = ['p1-order', 'p1-scale', 'p1-captives', 'p1-length'];
  const caught = want.filter(id => byId[id] === 'FAIL' || byId[id] === 'WARN');
  return {
    ok: caught.length === want.length,
    caught, statuses: byId,
    note: `壊れた序盤（第6世代・フェーズ2・4対19・捕虜3体）を食わせて ${caught.length}/${want.length} 項目が落ちた`,
  };
}

export function checkP1(runs) {
  const played = runs.filter(r => !r.error);
  const reached = played.filter(r => r.reach10);
  const wars = reached.map(r => r.firstWar).filter(w => w && !w.error && w.home != null);

  const out = [];

  // --- 1. 順序：10体到達 → 初戦 → 戦後処理 → フェーズ2 ---
  {
    const r = R('p1-order', 'P1: 初戦とフェーズ2の順序',
      '10体到達 → 初戦 → 戦後処理 → フェーズ2。フェーズ2は外来血の流入で幕を開ける');
    if (!reached.length) {
      r.status = 'INCONCLUSIVE';
      r.summary = `**判定不能**。${runs.length}種のうち10体に到達した村が0本（絶滅 ${played.filter(x => x.extinct).length}本）。順序を観測する場面が来ていない。`;
      out.push(r);
    } else {
      const stillVillage = reached.filter(r2 => r2.reach10.phase === PHASE.VILLAGE).length;
      const tribeAtWar = reached.length - stillVillage;
      const roseAfter = reached.filter(r2 => r2.phaseAfterWar === PHASE.TRIBE).length;
      r.numbers = {
        villages: reached.length,
        phase1AtFirstContact: stillVillage,
        phase2AlreadyAtFirstContact: tribeAtWar,
        phase2AfterWar: roseAfter,
      };
      if (tribeAtWar > 0) {
        r.status = 'FAIL';
        r.summary = `${reached.length}本中 **${tribeAtWar}本**で、初戦を撃つ前に既にフェーズ2へ上がっていた。`
          + `10体に達した同じ \`advanceGeneration\` の中でフェーズが切り替わるため、オーナーが初戦を撃つ時点で村は部族になっている。`
          + `敵の規模も捕虜の人数もP2の値で引かれるので、**5対5のパニックという看板の場面が発生しない**。`
          + `フェーズ移行は初戦の戦後処理の後に置く必要がある。`;
      } else {
        r.status = 'PASS';
        r.summary = `${reached.length}本すべてで初戦時点はフェーズ1（村）。戦後にフェーズ2へ上がったのは ${roseAfter}本。順序は 10体到達 → 初戦 → フェーズ2 になっている。`;
      }
      r.detail = [
        '```',
        barChart([
          ['初戦時にフェーズ1', stillVillage],
          ['初戦時に既にフェーズ2', tribeAtWar],
          ['戦後にフェーズ2へ', roseAfter],
        ], { width: 34, max: reached.length, fmt: v => `${v}/${reached.length}` }),
        '```',
      ].join('\n');
      out.push(r);
    }
  }

  // --- 2. 初戦の規模：5対5 ---
  {
    const r = R('p1-scale', 'P1: 初戦は5対5',
      '5対5なら、攻撃力天才が恐怖で固まって死ぬのを目撃できる。素質と練度が別物だと教えられる');
    if (!wars.length) {
      r.status = 'INCONCLUSIVE';
      r.summary = `**判定不能**。初戦まで到達した村が0本。`;
      out.push(r);
    } else {
      const homes = wars.map(w => w.home), aways = wars.map(w => w.away);
      const lo = P1_TARGET.battleSide - P1_TARGET.battleTolerance;
      const hi = P1_TARGET.battleSide + P1_TARGET.battleTolerance;
      const okHome = homes.filter(x => x >= lo && x <= hi).length;
      const okAway = aways.filter(x => x >= lo && x <= hi).length;
      r.numbers = {
        battles: wars.length,
        homeMedian: quantile(homes, 0.5), homeMin: minOf(homes), homeMax: maxOf(homes),
        awayMedian: quantile(aways, 0.5), awayMin: minOf(aways), awayMax: maxOf(aways),
        target: `${lo}〜${hi}`,
        homeInRange: okHome, awayInRange: okAway,
      };
      const homeOk = okHome >= wars.length * 0.7;
      const awayOk = okAway >= wars.length * 0.7;
      if (!homeOk || !awayOk) {
        r.status = 'FAIL';
        const bad = [];
        if (!homeOk) bad.push(`自国 中央値 ${quantile(homes, 0.5)}体（範囲 ${minOf(homes)}〜${maxOf(homes)}、${lo}〜${hi}に収まったのは ${okHome}/${wars.length}）`);
        if (!awayOk) bad.push(`相手 中央値 ${quantile(aways, 0.5)}体（範囲 ${minOf(aways)}〜${maxOf(aways)}、${okAway}/${wars.length}）`);
        r.summary = `初戦が5対5になっていない。${bad.join(' / ')}。`
          + `この規模でしか「練度ゼロのパニック」も「攻撃力天才が恐怖で固まって死ぬ」も観測できない。`;
      } else {
        r.status = 'PASS';
        r.summary = `初戦 ${wars.length}本の中央値は 自国 ${quantile(homes, 0.5)}体 対 相手 ${quantile(aways, 0.5)}体。`
          + `${lo}〜${hi}に収まったのは 自国 ${okHome}/${wars.length}、相手 ${okAway}/${wars.length}。`;
      }
      r.detail = [
        '初戦の参加人数:',
        '```',
        barChart([
          ['自国 中央値', quantile(homes, 0.5)],
          ['相手 中央値', quantile(aways, 0.5)],
          ['設計値', P1_TARGET.battleSide],
        ], { width: 30, max: Math.max(P1_TARGET.battleSide, maxOf(aways)) }),
        '```',
        '',
        '相手の人数の分布:',
        '```',
        histogram(aways, { bins: 8, lo: 0, hi: Math.max(10, maxOf(aways)), width: 30 }),
        '```',
      ].join('\n');
      out.push(r);
    }
  }

  // --- 3. 初戦の捕虜は1体 ---
  {
    const r = R('p1-captives', 'P1: 初戦の捕虜は1体',
      'P1終了時の捕虜は1体。P2は戦ごとに1〜5体');
    const withCaps = wars.filter(w => w.captives != null);
    if (!withCaps.length) {
      r.status = 'INCONCLUSIVE';
      r.summary = '**判定不能**。捕虜まで到達した初戦が0本。';
      out.push(r);
    } else {
      const counts = withCaps.map(w => w.captives);
      const won = withCaps.filter(w => w.winner === 'home');
      const wonCounts = won.map(w => w.captives);
      // 勝った戦だけを見る（負けた側は引ける人数が別物）
      const target = wonCounts.length ? wonCounts : counts;
      const exactly1 = target.filter(x => x === P1_TARGET.captives).length;
      // captiveOptions が公称する人数と実際に返った人数の食い違い
      const mismatches = withCaps.filter(w => w.optionsCount != null && w.optionsCount !== w.captives);
      r.numbers = {
        battles: withCaps.length, wonBattles: won.length,
        captiveMin: minOf(target), captiveMax: maxOf(target),
        captiveMedian: quantile(target, 0.5),
        exactlyOne: exactly1, target: P1_TARGET.captives,
        optionsCountReported: withCaps.some(w => w.optionsCount != null),
        optionsVsActualMismatch: mismatches.length,
      };
      // 勝ち戦が数本しかないと「たまたま1体だった」と区別がつかない。
      // ただし1体を超えているならその時点で違反なので、少数でも FAIL にしてよい。
      if (exactly1 === target.length && target.length < 3) {
        r.status = 'INCONCLUSIVE';
        r.summary = `**判定不能**（主張が否定されたのではない）。初戦 ${withCaps.length}本のうち勝ったのが ${won.length}本しかなく、`
          + `捕虜の人数を言い切るには足りない（3本以上ほしい）。観測できた範囲ではすべて ${minOf(target)}体で設計どおり。`
          + ` \`--p1-seeds\` を増やすか、初戦の勝率が低すぎないかを見る必要がある。`;
      } else if (exactly1 < target.length * 0.9) {
        r.status = 'FAIL';
        r.summary = `勝った初戦 ${target.length}本のうち捕虜がちょうど1体だったのは ${exactly1}本（範囲 ${minOf(target)}〜${maxOf(target)}体）。`
          + `P1の捕虜は1体でなければならない（\`CAPTIVE_COUNT[1] = [1,1]\`）。`
          + (mismatches.length ? ` さらに \`captiveOptions()\` が公称する人数と \`takeCaptives()\` が返す人数が ${mismatches.length}本で食い違っている。` : '')
          + ` フェーズが先に2へ上がっているため \`CAPTIVE_COUNT[2] = [1,5]\` が引かれているのが原因と思われる。`;
      } else if (mismatches.length) {
        r.status = 'WARN';
        r.summary = `捕虜の人数は1体で正しいが、\`captiveOptions()\` の公称と \`takeCaptives()\` の実数が ${mismatches.length}/${withCaps.length}本で食い違う。画面に出る数と実際に来る数がずれる。`;
      } else {
        r.status = 'PASS';
        r.summary = `勝った初戦 ${target.length}本すべてで捕虜は1体。`
          + (r.numbers.optionsCountReported ? ' `captiveOptions()` の公称とも一致。' : '');
      }
      r.detail = [
        '```',
        histogram(target, { bins: 6, lo: 0, hi: 6, width: 30 }),
        '```',
        `勝敗の内訳: 勝ち ${won.length} / 全体 ${withCaps.length}`,
      ].join('\n');
      out.push(r);
    }
  }

  // --- 4. P1の長さ：3〜4世代で10体 ---
  {
    const r = R('p1-length', 'P1: 3〜4世代で10体に到達',
      '個体数2から始めて10到達で終了。実時間で5〜10分、3〜4世代');
    if (!reached.length) {
      r.status = 'INCONCLUSIVE';
      r.summary = `**判定不能**。${runs.length}種のうち10体に到達した村が0本。`;
      out.push(r);
    } else {
      const gens = reached.map(x => x.reach10.gen);
      const [lo, hi] = P1_TARGET.gensToThreshold;
      const inRange = gens.filter(g => g >= lo && g <= hi).length;
      const med = quantile(gens, 0.5);
      r.numbers = {
        villages: reached.length, medianGens: med,
        min: minOf(gens), max: maxOf(gens),
        target: `${lo}〜${hi}`, inRange,
        notReached: played.length - reached.length,
      };
      if (med < lo || med > hi) {
        r.status = 'FAIL';
        r.summary = `10体到達までの中央値が **${med}世代**（範囲 ${minOf(gens)}〜${maxOf(gens)}）。設計は ${lo}〜${hi}世代。`
          + `P1が長すぎると初戦までが遠く、「実時間で5〜10分」が成立しない。`;
      } else if (inRange < reached.length * 0.6) {
        r.status = 'WARN';
        r.summary = `中央値 ${med}世代は設計どおりだが、${lo}〜${hi}に収まったのは ${inRange}/${reached.length}本とばらつきが大きい（${minOf(gens)}〜${maxOf(gens)}世代）。`;
      } else {
        r.status = 'PASS';
        r.summary = `10体到達までの中央値 ${med}世代（${lo}〜${hi}に収まったのは ${inRange}/${reached.length}本、範囲 ${minOf(gens)}〜${maxOf(gens)}）。`;
      }
      r.detail = [
        '10体到達までの世代数:',
        '```',
        histogram(gens, { bins: Math.min(10, Math.max(3, maxOf(gens))), lo: 0, hi: Math.max(8, maxOf(gens)), width: 30 }),
        '```',
        `到達しなかった村: ${played.length - reached.length}/${played.length}（うち絶滅 ${played.filter(x => x.extinct).length}）`,
      ].join('\n');
      out.push(r);
    }
  }

  return out;
}
