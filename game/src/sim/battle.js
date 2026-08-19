// 戦争。個体単位で解く。集計値の突き合わせにはしない。
//
//  ・勝敗は殲滅ではなく団結の崩壊。先に折れたほうが敗走する
//  ・戦死は「ステータス由来90% / 完全ランダム10%（流れ矢）」
//  ・逃走癖は少数なら得、多数だと敗走カスケードで全滅（頻度依存）
//  ・逃げた個体は生き延びるが戦功が付かない（社会的コスト）
//  ・降伏はオーナー裁定。代価は戦況の関数。資源が動くのは降伏のときだけ

import { RNG } from '../core/rng.js';
import { ROLE, DISTRICT, PHASE, blankSkills, makeIndividual } from '../core/model.js';
import { GENE_NAMES } from '../core/genes.js';
import * as C from './constants.js';
import { foundingGenome, phenotype, homozygosity } from './genetics.js';
import { combatStats, citizenPower, eff, sins, clamp, clamp01 } from './derive.js';
import { record, applyDelta } from './chronicle.js';
import { spawn, kill } from './world.js';
import { cardOr } from './cards.js';

const GHOST_NAMES = [
  'カルデア', 'ヴィンランド', 'ネブカド', 'サルゴン', 'ミュケナイ',
  'ハットゥシャ', 'ウガリト', 'ラガシュ', 'エラム', 'ミタンニ',
  'ティルス', 'クレタ', 'アヴァリス', 'ヌビア', 'バクトリア',
];

// ---------------------------------------------------------------------------
// ゴースト（CPU対戦相手）
// ---------------------------------------------------------------------------

/**
 * 同じ遺伝エンジンで作った国。roster.js の「実際に走った10国」が使えないときの
 * 妥協枠（マッチング不足時はゴースト、という設計文書の規定に対応）。
 */
export function makeGhost(seed, phase = 1, power = 1) {
  const rng = new RNG((seed >>> 0) || 1);
  const key = 'ghost' + (seed >>> 0);
  const name = GHOST_NAMES[rng.int(GHOST_NAMES.length)] + '国';
  // フェーズ1の相手は「隣の村」であって国ではない。人数も練度もこちらと同格にする
  const village = phase === PHASE.VILLAGE;
  const n = village ? C.FIRST_WAR_SIZE + rng.int(4) : 12 + rng.int(28);
  // 国ごとに遺伝子の狙いを振る＝国の性格。同じ相手ばかりにならない
  const targets = {};
  for (const g of GENE_NAMES) targets[g] = clamp01(rng.range(0.2, 0.8));
  const people = [];
  for (let i = 0; i < n; i++) {
    const hap = foundingGenome(targets, rng, 0.18);
    const genes = phenotype(hap);
    // 年齢は本人の寿命と整合させる。
    //
    // 年齢と寿命を独立に振っていたため、「寿命6なのに5歳」という個体が湧いていた。
    // 実在の個体は年齢の数だけ死亡判定を通過している＝年齢が高いこと自体が
    // 寿命の高さの証拠なので、そういう個体は世界の中には存在しえない。
    // 実測では捕虜の17%が余命1世代未満で入国し、23%が1〜2世代で老衰していた。
    // 初戦の捕虜1体は「10体の村に1体＝色が変わる」という企画の看板そのものなので、
    // 入った直後に死ぬと第2の柱が電源の入る前に切れる。
    const baseLife = C.BASE_LIFESPAN + C.LIFESPAN_SPAN * genes.寿命;
    const ageCap = Math.max(1, Math.min(village ? 3 : 5, Math.floor(baseLife * 0.45) - C.ADULT_AGE + 1));
    const ind = makeIndividual(`${key}#${i}`, name.slice(0, 2) + 'の' + (i + 1), {
      genes, skills: blankSkills(), age: C.ADULT_AGE + rng.int(ageCap), sex: rng.int(2),
      district: rng.bool(0.4) ? DISTRICT.FRONTIER : DISTRICT.CENTER,
      lineage: { [key]: 1 },
    });
    ind.hap = hap;
    ind.foreign = true;
    ind.origin = key;
    ind.homeName = name;
    ind.homozygosity = homozygosity(hap);
    ind.regimeGrudge = clamp01(rng.range(0, 0.35));
    ind.ledger = [];
    ind.motive = {};
    // その国の環境が開いた素質しか国民力には出ない。
    // 村どうしの初戦では、向こうも練度が浅い（＝素質と練度の差が見える場面になる）
    ind.expressed = village
      ? { war: rng.bool(0.4), prod: rng.bool(0.6) }
      : { war: rng.bool(0.35 + 0.4 * power), prod: rng.bool(0.6) };
    const skillCap = village ? 0.30 : 0.55;
    for (const s of Object.keys(ind.skills)) ind.skills[s] = clamp01(rng.range(0, skillCap) * power);
    ind.power = citizenPower(ind);
    people.push(ind);
  }
  rankNation(people);
  const strength = people.reduce((s, p) => s + p.power, 0);
  return {
    key, name, seed: seed >>> 0, phase, profile: 'ghost',
    people, strength,
    powerIndex: Math.round(people.length * 0.55 + strength * 1.4 + 8),
    hue: ((seed >>> 3) % 360) / 360,
    ruthless: rng.bool(0.35),   // 降伏を拒否して追撃するか
    deployTop: 0.35 + rng.next() * 0.4,
  };
}

/** 相手国内での順位を付ける。外国人は階級しか見えないので、これが唯一の手掛かり。 */
export function rankNation(people) {
  const sorted = [...people].sort((a, b) => citizenPower(b) - citizenPower(a));
  const n = sorted.length || 1;
  sorted.forEach((p, i) => { p.homeRankPct = (i + 0.5) / n; });
  return sorted;
}

/** 外国人は総合値の階級しか見えない。しかも「相手国内での」順位である。 */
export function publicRank(world, foreignIndividual) {
  const pct = foreignIndividual?.homeRankPct;
  if (pct == null) return '不明';
  if (pct <= 0.01) return '上位1%';
  const band = Math.min(100, Math.ceil(pct * 10) * 10);
  return `上位${band}%`;
}

// ---------------------------------------------------------------------------
// 開戦
// ---------------------------------------------------------------------------

/** 派遣：カード（＋局長の歪み）が誰を出すかを決める。総力戦は自分の首を絞める。 */
export function selectDeployment(world, rng) {
  const topPct = cardOr(world, 'deploy_top', 45) / 100;
  const spareAge = cardOr(world, 'spare_old', 8);
  const raise = cardOr(world, 'raise_young', 20) / 100;
  const pool = [...world.people.values()].filter(
    (p) => p.age >= C.ADULT_AGE && p.age < spareAge && !p.wounded
  );
  pool.sort((a, b) => citizenPower(b) - citizenPower(a));
  let n = Math.max(2, Math.round(pool.length * topPct));
  // 総力戦は自分の首を絞める。畑が止まるだけでなく、小さい国は
  // 一度の敗戦で人口が戻らなくなるので、全人口の4割を上限にする
  n = Math.min(n, pool.length, Math.max(2, Math.floor(world.people.size * 0.4)));
  const picked = pool.slice(0, n);
  // 育成派遣：恐怖耐性と統率は実戦でしか本命が伸びない。出さなければ一生開かない
  const young = pool.filter((p) => p.age <= 3 && !picked.includes(p));
  const nYoung = Math.round(young.length * raise);
  for (let i = 0; i < nYoung; i++) picked.push(young[i]);
  if (!picked.length && pool.length) picked.push(pool[0]);
  return picked;
}

function makeUnit(ind, side, key) {
  const st = combatStats(ind);
  return {
    key, side, id: ind.id, name: ind.name, ind,
    stats: st, hp: st.hp, maxHp: st.hp,
    dead: false, wounded: false, fled: false, escort: false,
    kills: 0, damage: 0, guardedBy: [],
  };
}

function buildSide(name, inds, key) {
  const units = inds.map((p, i) => makeUnit(p, key, `${key}${i}`));
  const bond = units.length ? units.reduce((s, u) => s + u.stats.bond, 0) / units.length : 0.5;
  const lead = units.length ? Math.max(...units.map((u) => u.stats.lead)) : 0;
  const c0 = clamp(0.40 + 0.50 * bond + 0.40 * lead, 0.25, 1.35);
  return {
    key, name, units, c0, cohesion: c0, start: units.length,
    deadThis: 0, fledThis: 0, routed: false,
  };
}

export function startWar(world, rng, opponent) {
  // 初戦＝10体到達時の強制戦争。ここだけは同格・同規模にする。
  //
  // 「5対5なら、攻撃力天才が恐怖で固まって死ぬのを目撃できる。素質と練度が
  //  別物だという設計を、チュートリアルなしで教えられる」——看板の場面なので、
  // 派遣カードにも相手の規模にも左右させない。4対19では個体が識別できない。
  const firstWar = world.phase === PHASE.VILLAGE && !world.firstWarDone;
  const mine = firstWar ? selectFirstWarForce(world) : selectDeployment(world, rng);
  const guards = Math.round(cardOr(world, 'guards', 0));
  const theirs = firstWar
    ? matchEnemyForce(opponent, mine.length)
    : pickEnemyForce(opponent, rng);

  const home = buildSide('自国', mine, 'home');
  const away = buildSide(opponent.name || '敵国', theirs, 'away');

  // 護衛＝随伴。1体につきN体を付けると運死が下がるが、その体は他の役に就けない
  if (guards > 0 && home.units.length > guards + 1) {
    const sorted = [...home.units].sort((a, b) => (a.ind.age - b.ind.age) || (b.stats.lead - a.stats.lead));
    const vip = sorted[0];
    const pool = home.units.filter((u) => u !== vip).sort((a, b) => a.stats.lead - b.stats.lead);
    for (let i = 0; i < guards && i < pool.length; i++) {
      pool[i].escort = true; pool[i].guarding = vip.key;
      vip.guardedBy.push(pool[i].key);
    }
  }

  const battle = {
    id: `w${world.gen}-${world.battles.length}`,
    gen: world.gen, worldSeed: world.seed,
    // 開戦時のフェーズを持っておく。捕虜の人数はこれで決まるので、
    // 戦後にフェーズが上がっても captiveOptions と takeCaptives が食い違わない
    phase: world.phase, firstWar,
    opponentKey: opponent.key, opponentName: opponent.name,
    sides: { home, away },
    round: 0, over: false, outcome: null, pursuit: false,
    log: [], surrenderOffered: false,
  };
  world.battles.push(battle);
  world.lastWarGen = world.gen;
  battle.startEvent = record(world, '開戦', {
    text: `${opponent.name}と戦になった（${home.units.length}対${away.units.length}）`,
  });
  return battle;
}

/**
 * 初戦の自軍。派遣カードを通さず5体を揃える。
 *
 * 人口10の村に成人は4人しかいないことが多い（残りは子ども）。
 * 足りない分は年長の子どもで埋める——これは手抜きではなく設計そのもので、
 * 「将来の名将は、一番死にやすい時期に戦場へ出さないと育たない」に対応する。
 * 恐怖耐性と統率は実戦でしか本命が伸びないので、初戦は育成の機会でもある。
 */
export function selectFirstWarForce(world) {
  const all = [...world.people.values()].filter((p) => !p.wounded);
  const adults = all.filter((p) => p.age >= C.ADULT_AGE);
  adults.sort((a, b) => citizenPower(b) - citizenPower(a));
  const picked = adults.slice(0, C.FIRST_WAR_SIZE);
  if (picked.length < C.FIRST_WAR_SIZE) {
    const youths = all
      .filter((p) => p.age >= 1 && p.age < C.ADULT_AGE)
      .sort((a, b) => citizenPower(b) - citizenPower(a));
    for (const y of youths) {
      if (picked.length >= C.FIRST_WAR_SIZE) break;
      picked.push(y);
    }
  }
  return picked;
}

/** 初戦の敵軍。こちらと同数・上位から。規模で殴り合いにしない。 */
function matchEnemyForce(opponent, n) {
  const pool = [...opponent.people].filter((p) => p.alive !== false);
  pool.sort((a, b) => citizenPower(b) - citizenPower(a));
  return pool.slice(0, Math.max(1, Math.min(n, pool.length)));
}

function pickEnemyForce(opponent, rng) {
  const pool = [...opponent.people].filter((p) => p.alive !== false);
  pool.sort((a, b) => citizenPower(b) - citizenPower(a));
  const n = Math.max(2, Math.min(pool.length, Math.round(pool.length * (opponent.deployTop ?? 0.45))));
  return pool.slice(0, n);
}

// ---------------------------------------------------------------------------
// 1ラウンド
// ---------------------------------------------------------------------------

const active = (s) => s.units.filter((u) => !u.dead && !u.fled && !u.escort);
const standing = (s) => s.units.filter((u) => !u.dead && !u.fled);

export function stepBattle(battle, rng) {
  const out = [];
  if (battle.over) return out;
  battle.round++;
  const { home, away } = battle.sides;
  home.deadThis = 0; home.fledThis = 0;
  away.deadThis = 0; away.fledThis = 0;

  const A = active(home), B = active(away);
  if (!A.length || !B.length) return finish(battle, out, !A.length ? 'away' : 'home', '殲滅');

  // 逃走が増えるほど部隊全体が斬られやすくなる（頻度依存の本体）
  home.exposure = 1 + fledRatio(home) * 1.6 + (battle.pursuit ? 0.5 : 0);
  away.exposure = 1 + fledRatio(away) * 1.6 + (battle.pursuit ? 0.5 : 0);

  // --- 攻撃 ---
  const pairs = [[A, B, away], [B, A, home]];
  for (const [attackers, defenders, defSide] of pairs) {
    for (const u of attackers) {
      if (u.dead || u.fled) continue;
      const live = defenders.filter((d) => !d.dead && !d.fled);
      if (!live.length) continue;
      const t = live[rng.int(live.length)];
      if (rng.next() > u.stats.acc) continue;
      const crit = rng.next() < u.stats.crit ? 1.8 : 1;
      const dmg = 12 * u.stats.atk * crit / (0.55 + t.stats.def) * defSide.exposure;
      t.hp -= dmg;
      u.damage += dmg;
      if (t.hp <= 0 && !t.dead) {
        resolveDown(battle, t, u, rng, out);
        // 流れ矢：戦死のうち約10%はステータスと無関係な完全ランダム抽選
        if (!t.wounded && rng.next() < C.LUCK_SHARE / (1 - C.LUCK_SHARE)) {
          const victims = standing(defSide).filter((v) => !v.dead && v !== t);
          if (victims.length) {
            const v = pickLuckVictim(defSide, victims, rng);
            v.hp = 0;
            resolveDown(battle, v, null, rng, out, true);
          }
        }
      }
    }
  }

  // --- 恐怖と逃走 ---
  for (const side of [home, away]) {
    const base = 0.12 + clamp(1 - side.cohesion / side.c0, 0, 1.4);
    const loss = side.start ? (side.units.filter((u) => u.dead).length / side.start) : 0;
    for (const u of side.units) {
      if (u.dead || u.fled) continue;
      const hurt = u.hp / u.maxHp < 0.42 ? 0.35 : 0;
      const pressure = base + hurt + loss * 0.35;
      const p = clamp(u.stats.flee * pressure * 0.45, 0, 0.55);
      if (rng.next() < p) {
        u.fled = true;
        side.fledThis++;
        out.push({ round: battle.round, kind: '逃走', side: side.key, name: u.name, id: u.id });
      }
    }
  }

  // --- 団結 ---
  for (const side of [home, away]) {
    const n0 = Math.max(1, side.start);
    const cmd = active(side).sort((a, b) => b.stats.lead - a.stats.lead)[0];
    const gain = cmd ? 0.07 * cmd.stats.lead : 0;
    const drop = (side.deadThis / n0) * 1.25 + (side.fledThis / n0) * 1.85 + 0.018;
    side.cohesion = clamp(side.cohesion - drop + gain, -1, side.c0 * 1.15);
  }

  battle.log.push({
    round: battle.round,
    home: { cohesion: home.cohesion, alive: standing(home).length, fled: home.units.filter(u => u.fled).length },
    away: { cohesion: away.cohesion, alive: standing(away).length, fled: away.units.filter(u => u.fled).length },
  });

  // --- 崩壊判定：先に折れたほうが敗走する ---
  const homeBroke = home.cohesion <= 0 || !standing(home).length;
  const awayBroke = away.cohesion <= 0 || !standing(away).length;
  if (homeBroke && awayBroke) return finish(battle, out, home.cohesion >= away.cohesion ? 'home' : 'away', '相打ち');
  if (homeBroke) return finish(battle, out, 'away', '崩壊');
  if (awayBroke) return finish(battle, out, 'home', '崩壊');
  if (battle.round >= C.MAX_ROUNDS) {
    return finish(battle, out, home.cohesion >= away.cohesion ? 'home' : 'away', '日没');
  }
  return out;
}

function fledRatio(side) {
  if (!side.start) return 0;
  return side.units.filter((u) => u.fled).length / side.start;
}

/** 護衛が付いていれば流れ矢の的になりにくい。護衛は身代わりになる。 */
function pickLuckVictim(side, victims, rng) {
  const weights = victims.map((v) => (v.guardedBy.length ? 1 / (1 + v.guardedBy.length * 1.5) : 1));
  let total = 0; for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < victims.length; i++) { r -= weights[i]; if (r <= 0) return victims[i]; }
  return victims[victims.length - 1];
}

function resolveDown(battle, t, killer, rng, out, luck = false) {
  const side = battle.sides[t.side];
  if (rng.next() < C.WOUND_SHARE && !luck) {
    t.wounded = true;
    t.hp = t.maxHp * 0.25;
    out.push({ round: battle.round, kind: '負傷', side: t.side, name: t.name, id: t.id, by: killer?.name ?? null });
  } else {
    t.dead = true;
    // 戦死のうち約10%は流れ矢＝ステータスと無関係な完全ランダム抽選。
    // 誰がどちらで死んだかを残さないと「ステ由来90%/運10%」が検証できない
    t.deathDetail = luck ? 'war:luck' : 'war:stat';
    t.byLuck = luck;
    side.deadThis++;
    if (killer) killer.kills++;
    out.push({
      round: battle.round, kind: '戦死', side: t.side, name: t.name, id: t.id,
      by: killer?.name ?? null, luck, detail: t.deathDetail,
    });
  }
}

function finish(battle, out, winner, how) {
  battle.over = true;
  const loser = winner === 'home' ? 'away' : 'home';
  battle.sides[loser].routed = how === '崩壊' || how === '殲滅';
  battle.outcome = battle.outcome || { kind: how, winner, loser };
  // 敗走の追い討ちは applyRout()。乱数を使うので呼び出し側の rng が要る
  out.push({ round: battle.round, kind: '決着', how, winner, loser });
  return out;
}

/**
 * 敗走の追い討ち。finish の中で乱数を使うと呼び出し側の rng が見えないので分離した。
 * settleWar から必ず1回だけ呼ぶ。
 */
export function applyRout(battle, rng) {
  if (!battle.outcome || battle.routApplied) return [];
  battle.routApplied = true;
  const out = [];
  const how = battle.outcome.kind;
  if (how !== '崩壊' && how !== '殲滅' && how !== '相打ち') return out;
  const side = battle.sides[battle.outcome.loser];
  const fr = fledRatio(side);
  for (const u of side.units) {
    if (u.dead) continue;
    const p = u.fled
      ? C.ROUT_FLED_DEATH + C.ROUT_FLED_CROWD * fr
      : (battle.pursuit ? C.ROUT_HELD_DEATH * 2.2 : C.ROUT_HELD_DEATH);
    if (rng.next() < clamp(p, 0, 0.95)) {
      u.dead = true;
      // 敗走中の被害はステータス（逃げたか踏み止まったか）由来。運死ではない
      u.deathDetail = 'war:stat';
      u.byLuck = false;
      out.push({ round: battle.round, kind: '戦死', side: u.side, name: u.name, id: u.id, rout: true, fled: u.fled });
    } else if (rng.next() < 0.25) {
      u.wounded = true;
      out.push({ round: battle.round, kind: '負傷', side: u.side, name: u.name, id: u.id, rout: true });
    }
  }
  out.push(...drawLuckDeaths(battle, rng));
  return out;
}

/**
 * 流れ矢。戦死者のうち約1割は完全にランダムな抽選で、ステータスと無関係に誰でも引く。
 *
 * ラウンド中のHP撃破にだけ運死を付けていたときは実測2.1%にしかならなかった。
 * 戦死の大半は敗走時の追い討ち（ステータス由来）で出るので、母数が合わない。
 * 決着後にその戦の全戦死数を数えて、比率が10%になるところまで抽選する。
 */
function drawLuckDeaths(battle, rng) {
  const out = [];
  const all = [...battle.sides.home.units, ...battle.sides.away.units];
  const already = all.filter((u) => u.dead && u.byLuck).length;
  const statDead = all.filter((u) => u.dead && !u.byLuck).length;
  const want = Math.round(statDead * C.LUCK_SHARE / (1 - C.LUCK_SHARE)) - already;
  for (let i = 0; i < want; i++) {
    const living = all.filter((u) => !u.dead);
    if (living.length <= 1) break;
    const v = pickLuckVictim(null, living, rng);
    v.dead = true;
    v.byLuck = true;
    v.deathDetail = 'war:luck';
    out.push({ round: battle.round, kind: '戦死', side: v.side, name: v.name, id: v.id, luck: true, detail: 'war:luck' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// サレンダー：戦闘中の唯一の判断。オーナー裁定。代価は戦況の関数
// ---------------------------------------------------------------------------

export function surrender(battle) {
  if (battle.over) return { ok: false, reason: '決着済み' };
  const h = battle.sides.home, a = battle.sides.away;
  if (h.cohesion <= 0) return { ok: false, reason: '崩壊後は降伏できない' };

  // 早く降りれば安く、粘るほど高くつく
  const broken = clamp(1 - h.cohesion / h.c0, 0, 1);
  const losing = clamp((a.cohesion / a.c0) - (h.cohesion / h.c0), -1, 1);
  const severity = clamp(0.30 + 1.05 * broken + 0.35 * Math.max(0, losing) + 0.015 * battle.round, 0.25, 2.2);

  const survivors = standing(h).length;
  const baseFood = Math.round(6 + severity * 14);
  const baseHeads = Math.max(1, Math.round(severity * 2.2));
  const options = [
    { label: '資源で払う', food: baseFood, captives: 0 },
    { label: '折半', food: Math.round(baseFood * 0.5), captives: Math.max(1, Math.round(baseHeads * 0.5)) },
    { label: '人で払う', food: 0, captives: baseHeads },
  ];

  // 受諾か拒否かは勝者の裁定。殲滅すれば自分の報酬（捕虜）が消えるので支配戦略にはならない
  const accepted = !(battle.opponentRuthless && severity > 1.4 && survivors > 2);
  const outcome = {
    ok: true, accepted, severity, options,
    price: options[0], survivors,
    kind: accepted ? 'サレンダー' : '追撃',
    winner: 'away', loser: 'home',
  };
  battle.surrenderOffered = true;
  if (accepted) {
    battle.over = true;
    battle.outcome = outcome;
  } else {
    battle.pursuit = true;   // 拒否されたら追撃モード。被害が跳ね上がる
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 捕虜
// ---------------------------------------------------------------------------

export const CAPTIVE_AXES = [
  { key: '総合', label: '総合', score: (p) => citizenPower(p) },
  { key: '武', label: '武力', score: (p) => eff(p, '攻撃素質') + 0.5 * (p.skills.戦技 ?? 0) },
  { key: '知', label: '知性', score: (p) => p.genes.知性 + 0.4 * p.genes.好奇心 },
  { key: '統率', label: '統率', score: (p) => eff(p, '統率素質') },
  { key: '繁殖', label: '繁殖性', score: (p) => p.genes.繁殖性 },
  { key: '器用', label: '器用', score: (p) => eff(p, '器用') + 0.4 * p.genes.技術習得 },
  { key: '頑健', label: '頑健', score: (p) => p.genes.頑健 + 0.4 * p.genes.寿命 },
];

/** その戦で引ける捕虜の人数。開戦時のフェーズで決まる。 */
export function captiveRange(battle) {
  return C.CAPTIVE_COUNT[battle?.phase ?? 1] || C.CAPTIVE_COUNT[1];
}

/** 勝者だけが軸を1本選べる。指名ではないので当たり外れは残るが、方向は選べる。 */
export function captiveOptions(battle) {
  const won = battle.outcome && battle.outcome.winner === 'home';
  const survivors = battle.sides.away.units.filter((u) => !u.dead).length;
  // 人数は takeCaptives とまったく同じ出所から出す。
  // 別々に計算していたため「1体と表示して3〜5体返る」という食い違いが起きていた
  const [lo, hi] = captiveRange(battle);
  return {
    axes: won ? CAPTIVE_AXES.map((a) => ({ key: a.key, label: a.label })) : [],
    winner: !!won,
    pool: won ? '平均より上' : '全プール',
    survivors,
    min: Math.min(lo, survivors), max: Math.min(hi, survivors),
    count: Math.min(lo, survivors),   // 確定人数（lo===hi のフェーズ1はこれがそのまま）
    exact: lo === hi,
    note: won ? '軸を1つ選ぶと、相手の平均より上のプールから抽選する' : '敗者は相手の全プールから抽選する',
  };
}

/**
 * 捕虜を引く。勝者は選んだ軸の「平均より上」から、敗者は全プールから抽選する。
 * 人数差は出ない。出るのは引くプールの質だけ。
 * @param mySide 自分がどちら側か（ライバル国どうしの戦では 'away' 側も引く）
 */
export function takeCaptives(world, battle, axis, rng, mySide = 'home') {
  // 互換：戦闘を経由せずに外来血だけを入れたい呼び出し
  // （近親交配からの回復を測るときなど）。第2引数が battle ではなく RNG のとき。
  if (battle && typeof battle.next === 'function') {
    return injectOutsideBlood(world, battle, axis ?? 1);
  }
  const cacheKey = 'captives_' + mySide;
  if (battle[cacheKey]) return battle[cacheKey];
  const otherSide = mySide === 'home' ? 'away' : 'home';
  const won = battle.outcome && battle.outcome.winner === mySide;
  const enemy = battle.sides[otherSide];
  const alive = enemy.units.filter((u) => !u.dead).map((u) => u.ind);
  // 殲滅した瞬間、自分の報酬が消える
  if (!alive.length) { battle[cacheKey] = []; return []; }

  const [lo, hi] = captiveRange(battle);
  const n = Math.min(alive.length, lo + rng.int(hi - lo + 1));

  let pool = alive;
  if (won) {
    const ax = CAPTIVE_AXES.find((a) => a.key === axis) || CAPTIVE_AXES[0];
    const mean = alive.reduce((s, p) => s + ax.score(p), 0) / alive.length;
    const above = alive.filter((p) => ax.score(p) >= mean);
    pool = above.length ? above : alive;
  }
  const picked = rng.shuffle([...pool]).slice(0, n);
  const fromName = mySide === 'home' ? battle.opponentName : (battle.homeName || '自国');
  const out = [];
  for (const p of picked) {
    const cap = { ...p };
    cap.captiveOf = battle.id;
    cap.fromNation = p.homeName || fromName;
    cap.homeRankPct = p.homeRankPct ?? 0.5;
    cap.grudgeBrought = clamp01((p.regimeGrudge ?? 0) + 0.35); // 力ずくで連れてこられた
    cap.ledger = [];
    cap.sourceId = p.id;
    world.border.set(cap.id, cap);
    world.foreign.set(cap.id, cap);
    out.push(cap);
  }
  battle[cacheKey] = out;
  record(world, '捕虜', {
    text: `${fromName}から${out.length}名を国境まで連れ帰った`,
    trueCause: battle.startEvent?.id ?? null,
  });
  return out;
}

/**
 * 外来血をn体入れる。戦争を経ずに雑種強勢だけを見たいときの入口。
 * 遺伝子は無関係な国から引くので、劣性ホモがヘテロに戻って荷重が隠れる。
 */
export function injectOutsideBlood(world, rng, n = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ghost = makeGhost((rng.int(1e9) ^ (world.gen * 2654435761)) >>> 0, world.phase, 1);
    const donor = ghost.people[rng.int(ghost.people.length)];
    if (!donor) continue;
    const cap = { ...donor };
    cap.fromNation = ghost.name;
    cap.grudgeBrought = clamp01((donor.regimeGrudge ?? 0) + 0.35);
    cap.ledger = [];
    world.border.set(cap.id, cap);
    world.foreign.set(cap.id, cap);
    borderDecision(world, cap.id, 'accept');
    out.push(cap);
  }
  return out;
}

/**
 * 国境処理。戦争終了時に行うので国民への通達はなく、感情変数は動かない。
 * 一度入れたあとに殺すのは粛清であり、いつも通りの反応が返る（purge を使うこと）。
 */
export function borderDecision(world, captiveId, decision) {
  const cap = world.border.get(captiveId);
  if (!cap) return null;
  world.border.delete(captiveId);

  if (decision === 'return') {
    // 送還される個体は一度も入国しておらず、見たものが何もない。双方リスクゼロ
    return record(world, '送還', { text: `${cap.name}を${cap.fromNation}へ返した` });
  }
  if (decision === 'kill') {
    world.killedAtBorder = (world.killedAtBorder || 0) + 1;
    const ev = record(world, '誅殺', {
      text: `${cap.name}を国境で誅殺した`,
      revealed: false,
    });
    // 大量誅殺は軍務関係者に露呈する。一次情報はその戦争の参加者まで
    if (world.killedAtBorder >= 3) {
      const vets = [...world.people.values()].filter((p) => p.deeds.some((d) => d.kind === '従軍'));
      for (const v of vets) {
        const d = 0.05 * (0.4 + v.genes.感受性);
        v.regimeGrudge = clamp01(v.regimeGrudge + d);
        applyDelta(world, v, '怨恨', d, ev.id);
        // 高感受性 × 高知性 × 怨恨の個体がいればリークする
        if (v.genes.感受性 > 0.6 && v.genes.知性 > 0.6 && v.regimeGrudge > 0.4) ev.revealed = true;
      }
    }
    return ev;
  }
  // accept：帰化。ここから先は自国民であり、殺せば粛清になる
  const ind = spawn(world, cap.name, cap.hap, {
    sex: cap.sex, age: cap.age, born: world.gen - cap.age,
    lineage: { ...cap.lineage },
    origin: cap.origin,
    // 住まわせる場所はオーナーの動詞「置く」の管轄（setDistrict）。
    // 自動で辺境に送っていたが、辺境は寿命に15%の負債が付くので、
    // 入国した瞬間に隠れたペナルティを課していた。初期配置は中心にして、
    // 辺境送りにするかどうかはオーナーに決めさせる
    district: DISTRICT.CENTER,
    role: ROLE.IDLE,
    expressed: { ...cap.expressed },
  });
  ind.skills = { ...cap.skills };     // 練度は本人のもの。遺伝ではないので持って来る
  ind.regimeGrudge = cap.grudgeBrought;
  ind.immigrant = true;
  ind.fromNation = cap.fromNation;
  if (!world.origins.has(cap.origin)) {
    world.origins.set(cap.origin, { key: cap.origin, name: cap.fromNation, hue: hashHue(cap.origin) });
  }
  const ev = record(world, '帰化', {
    target: ind.id,
    text: `${ind.name}が${cap.fromNation}から入った`,
    effects: [{ field: '血統', delta: 1, subjectId: ind.id }],
  });
  applyDelta(world, ind, '血統', 1, ev.id);
  applyDelta(world, ind, '怨恨', ind.regimeGrudge, ev.id);
  return ev;
}

function hashHue(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 360) / 360;
}

// ---------------------------------------------------------------------------
// 戦後処理：世界側への反映
// ---------------------------------------------------------------------------

/**
 * 戦闘の結果を世界に書き戻す。戦死は本当に削る。
 * @param opts.priceIndex サレンダーした場合に選んだ代価（surrender の options のindex）
 */
export function settleWar(world, battle, rng, opts = {}) {
  if (battle.settled) return [];
  battle.settled = true;
  const events = [];
  events.push(...applyRout(battle, rng));

  const won = battle.outcome && battle.outcome.winner === 'home';
  const { events: lossEvents, dead, wounded, fled } = applySideLosses(world, battle, 'home', rng);
  events.push(...lossEvents);

  // 降伏の賠償。資源が動くのは降伏したときだけ
  if (battle.outcome && battle.outcome.kind === 'サレンダー') {
    const idx = opts.priceIndex ?? 0;
    const price = battle.outcome.options[idx] || battle.outcome.options[0];
    battle.outcome.price = price;
    world.food = Math.max(0, world.food - price.food);
    if (price.captives > 0) {
      const pool = [...world.people.values()].filter((p) => p.age >= C.ADULT_AGE);
      const give = rng.shuffle(pool).slice(0, price.captives);
      for (const p of give) {
        const ev = kill(world, p, '賠償として引き渡し', battle.startEvent?.id ?? null);
        if (ev) events.push(ev);
      }
    }
    // 降伏は隠せない。誇りの高い兵は屈辱、憤怒の強い国民は欲が未充足のまま残る
    for (const p of world.people.values()) {
      const sn = sins(p);
      const d = 0.10 * p.genes.誇り + 0.12 * sn.憤怒 - 0.10 * p.genes.保身;
      p.regimeGrudge = clamp01(p.regimeGrudge + Math.max(0, d));
    }
  }

  const ev = record(world, '戦終', {
    trueCause: battle.startEvent?.id ?? null,
    revealed: true,
    text: `${battle.opponentName}との戦は${battle.outcome?.kind ?? '不明'}で終わった` +
      `（戦死${dead}・負傷${wounded}・逃走${fled}）`,
    effects: [{ field: '民心', delta: won ? 0.08 : -0.15 }],
  });
  applyDelta(world, world, '民心', won ? 0.08 : -0.15, ev.id);
  world.morale = clamp(world.morale + (won ? 0.08 : -0.15), C.MORALE_FLOOR, 1);
  events.push(ev);
  // 初戦が終わった。これでフェーズ2に上がれる（順番は 10体 → 初戦 → 戦後 → P2）
  if (battle.firstWar) {
    world.firstWarDone = true;
    world.pendingFirstWar = false;
  }
  battle.summary = { dead, wounded, fled, won, rounds: battle.round };
  return events;
}

/**
 * 片側の損耗を、その側の世界に書き戻す。
 * ライバル国どうしの戦（roster.js）では両側についてこれを呼ぶ。
 */
export function applySideLosses(world, battle, sideKey, rng) {
  const side = battle.sides[sideKey];
  const events = [];
  let dead = 0, wounded = 0, fled = 0;
  for (const u of side.units) {
    const p = world.people.get(u.id);
    if (!p) continue;
    if (u.dead) {
      dead++;
      const ev = kill(world, p, '戦死', battle.startEvent?.id ?? null, u.deathDetail || 'war:stat');
      if (ev) events.push(ev);
      // 戦死者の家族に怨恨が積む
      for (const q of world.people.values()) {
        if (q.fatherId !== p.id && q.motherId !== p.id && q.id !== p.fatherId && q.id !== p.motherId) continue;
        const d = 0.28 * (0.5 + q.genes.情愛);
        q.regimeGrudge = clamp01(q.regimeGrudge + d);
        if (ev) applyDelta(world, q, '怨恨', d, ev.id);
      }
      continue;
    }
    // 生還：練度が伸びる。実戦は恐怖耐性の本命
    p.wounded = p.wounded || u.wounded;
    if (u.wounded) wounded++;
    const gain = C.SKILL_GAIN.war;
    for (const [sk, rate] of Object.entries(gain)) {
      const cur = p.skills[sk] ?? 0;
      p.skills[sk] = clamp01(cur + rate * (1 - cur) * (u.fled ? 0.25 : 1));
    }
    if (u.fled) {
      fled++;
      // 逃げた個体は生き延びるが戦功が付かない。実績が積まれず、登用されなくなる
      p.deeds.push({ kind: '逃走', gen: world.gen, battle: battle.id });
      p.cowardice = (p.cowardice || 0) + 1;
    } else {
      p.deeds.push({ kind: '従軍', gen: world.gen, battle: battle.id, kills: u.kills });
      if (u.kills > 0) p.deeds.push({ kind: '戦功', gen: world.gen, kills: u.kills });
    }
    p.fatigue = clamp01(p.fatigue + 0.35);
    p.power = citizenPower(p);
  }
  return { events, dead, wounded, fled };
}

/** 戦闘を最後まで回す（ヘッドレス／ライバル国用）。 */
export function runBattle(battle, rng, hooks = {}) {
  const all = [];
  let guard = C.MAX_ROUNDS + 5;
  while (!battle.over && guard-- > 0) {
    all.push(...stepBattle(battle, rng));
    if (hooks.onRound) hooks.onRound(battle, all);
  }
  if (!battle.outcome) {
    const h = battle.sides.home, a = battle.sides.away;
    battle.over = true;
    battle.outcome = { kind: '日没', winner: h.cohesion >= a.cohesion ? 'home' : 'away', loser: h.cohesion >= a.cohesion ? 'away' : 'home' };
  }
  return all;
}
