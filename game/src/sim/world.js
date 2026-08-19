// 世界。createWorld / stepTick / advanceGeneration と、オーナーの動詞のうち
// 「置く」（配役・居住区・任命）と「読む」（検索）。
//
// sim は ui を知らない。DOMも window も Date.now() も触らない。
// 乱数は必ず引数で渡された RNG を使う。

import {
  makeVillage, makeIndividual, blankSkills, PHASE, PHASE_THRESHOLD,
  ROLE, BUREAU, BUREAU_LABEL, DISTRICT,
} from '../core/model.js';
import { RNG } from '../core/rng.js';
import { NameGiver } from '../core/names.js';
import { GENE_NAMES } from '../core/genes.js';
import * as C from './constants.js';
import {
  foundingGenome, answersToTargets, specToTargets, projectCentroid, breedGenome, phenotype,
  enforceNoUniversalSuperiority, enforceChromosomeCeiling,
  homozygosity, recessiveHomo, carriers, geneticLoad, vitalityOf,
} from './genetics.js';
import {
  eff, sins, sinOutputs, citizenPower, produce, consume, unmetTotal,
  willingness, acceptance, clamp, clamp01, combatStats,
} from './derive.js';
import { initChronicle, record, applyDelta, inheritLedger, pruneChronicle } from './chronicle.js';
import { defaultCards, cardOr, readCard } from './cards.js';

const SEG_OF_ROLE = {
  [ROLE.HUNT]: 'war', [ROLE.DRILL]: 'war', [ROLE.WAR]: 'war',
  [ROLE.FARM]: 'prod',
};

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/**
 * @param opts.name       世界の呼び名（UIの表示用）
 * @param opts.foundSeed 創世個体の遺伝子だけを別の種から引く。
 *   ロスター（10国の対照実験）が「同じ元手を10人のオーナーに渡す」形になるために要る。
 *   プレイヤーの世界では使わない。
 */
export function createWorld(seed, answers = [], opts = {}) {
  const w = makeVillage();
  w.seed = seed >>> 0;
  w.name = opts.name ?? '我らのシャーレ';
  w.originKey = 'home';
  w.origins = new Map([['home', { key: 'home', name: '自国', hue: (w.seed % 360) / 360 }]]);
  w.cards = defaultCards();
  w.transparency = 0.5;     // 透過率。法務局がないv2は固定値＋カードで動く
  w.lastWarGen = -99;
  w.border = new Map();     // 国境で待機している捕虜（まだ入国していない）
  w.foreign = new Map();    // 外国人の参照（publicRank 用）
  w.petitions = new Map();
  w.nextPetitionId = 1;
  w.battles = [];
  w.ledger = [];            // 民心・産出率の出所
  w.stats = [];
  w.food = C.START_FOOD;
  w.land = C.LAND_START;    // 産出の上限を決める唯一の資源。開墾で増える
  w.landFactor = 1;
  w.houses = new Map();     // 家系。merit / dynastic の出自分布を測るため
  // 世代ごとの件数ログ。観測側は「advanceGeneration 直後の world.gen」で引く
  w.purgeLog = [];
  w.rebelLog = [];
  w.bureauLog = [];         // {gen,bureau,id,name,house,houseRank,noble,power,deeds}
  w.deathStats = {};        // 死因の内訳。戦死はステ由来／運死を分ける
  w._pendingPurges = 0;
  // 交配相手はオーナーが指名できない。動かせるのは「地位・実績・住まわせ方」だけで、
  // それが結果として血の濃さを決める（ラマルクではなくダーウィン経路）。
  w.mating = { foreignBias: 0, inbreedGuard: 0.0, prefer: null };
  w.fertBias = 1;
  w.reachedThreshold = false; // 一度でも10体に達したか（初戦の損耗で割り込んでも戻らない）
  w.firstWarDone = false;     // 強制戦争（初戦）を終えたか。フェーズ2の前提条件
  w.pendingFirstWar = false;  // 10体に達したがまだ戦っていない＝UIが初戦を出す合図
  w.answers = answers;
  w.collapsing = false;
  w.rebellions = 0;
  initChronicle(w);

  w.giver = new NameGiver(new RNG((w.seed ^ 0x9e3779b9) >>> 0));
  const rng = new RNG((((opts.foundSeed ?? w.seed) >>> 0) ^ 0x85ebca6b) >>> 0);

  // 回答＝種族の重心。二匹はそこから独立に引いたサンプル
  const spec = specToTargets(answers);
  const targets = spec.targets;
  w.spec = { mode: spec.mode, spread: spec.spread, centroid: projectCentroid(targets) };
  const founders = ['アダム', 'イザナミ'];
  const genesis = record(w, '創世', { text: '世界が始まった' });
  for (let i = 0; i < 2; i++) {
    const hap = foundingGenome(targets, rng, spec.spread);
    const ind = spawn(w, founders[i], hap, { sex: i, age: 2, born: 0, lineage: { home: 1 } });
    ind.expressed = { war: true, prod: true }; // 創世の二匹だけは両方開いている
    ind.role = i === 0 ? ROLE.HUNT : ROLE.FARM;
    ind.founder = true;
    ind.myth = true;                            // 神を直接見た
    record(w, '誕生', { actor: ind.id, trueCause: genesis.id, text: `${ind.name}が現れた` });
  }
  recomputeAggregates(w);
  return w;
}

/** 個体を1体作って world に入れる。genes は hap から必ず導出する。 */
export function spawn(w, name, hap, opts = {}) {
  const id = w.nextId++;
  const genes = phenotype(hap);
  const ind = makeIndividual(id, name, {
    ...opts,
    genes,
    skills: blankSkills(),                 // 練度は絶対に継承しない
    expressed: opts.expressed ?? {},
  });
  ind.hap = hap;
  ind.regimeGrudge = opts.regimeGrudge ?? 0;
  ind.ledger = [];
  ind.motive = {};
  ind.mated = false;
  ind.homoz = homozygosity(hap);
  ind.load = geneticLoad(hap);
  ind.vitality = vitalityOf(ind.load);
  ind.origin = opts.origin ?? w.originKey;
  ind.district = opts.district ?? DISTRICT.CENTER;
  ind.role = opts.role ?? ROLE.CHILD;
  // 家系。父系で継ぐ（誰も設計していないのに硬直した家系と流動的な家系が両方生まれる）
  // 寿命の個体差。遺伝子だけで決めると、好況期に生まれた大コホートが
  // 揃って老衰して人口が階段状に落ちる。世代の山谷が共振して絶滅の主因になるので、
  // 決定的なハッシュで個体ごとに散らす（乱数を引かないので再現性は保たれる）。
  ind.lifeJitter = 0.78 + 0.44 * hash01(w.seed ^ (id * 2654435761));
  ind.house = opts.house ?? ('H' + id);
  ind.noble = !!opts.noble;
  ind.houseRank = houseRankOf(w, ind.house);
  registerHouse(w, ind);
  ind.power = citizenPower(ind);
  w.people.set(id, ind);
  return ind;
}

/** 決定的な 0..1 ハッシュ。乱数列を消費せずに個体差を作るためのもの。 */
function hash01(x) {
  let h = (x ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function registerHouse(w, ind) {
  let h = w.houses.get(ind.house);
  if (!h) {
    h = { key: ind.house, founderId: ind.id, gen: w.gen, bureauCount: 0, titleCount: 0, members: 0 };
    w.houses.set(ind.house, h);
  }
  h.members++;
  return h;
}
function houseRankOf(w, key) {
  return w.houses.get(key)?.bureauCount ?? 0;
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export function stepTick(w, rng) {
  const events = [];
  w.tick++;

  let gross = 0, hidden = 0, eat = 0;
  const pop = w.people.size;
  if (pop === 0) { w.collapsing = true; return events; }

  const density = densityStress(w);
  w.density = density;

  // 規模の逓減：働き手が土地を超えると1人あたりの取り分が落ちる。
  // 人口の天井を決めているのは食料でも密度でもなく、最終的にはこれ。
  let workers = 0;
  for (const p of w.people.values()) if (p.role === ROLE.FARM || p.role === ROLE.HUNT) workers++;
  const ratio = workers / Math.max(1, w.land);
  const landFactor = ratio <= 0.7 ? 1 : 1 / (1 + 2.5 * (ratio - 0.7));
  w.landFactor = landFactor;
  w.workers = workers;

  for (const p of w.people.values()) {
    const pr = produce(p, w, landFactor);
    gross += pr.gross;
    hidden += pr.hidden;
    eat += consume(p);
    gainSkills(w, p, rng);
    // 疲労：働けば溜まり、休めば抜ける。
    // 回復を定数（-0.02）にしていたため、働き続ける個体の疲労が必ず1.0に張り付き、
    // 全成人が恒久的に3割減という見えない税を払っていた。回復を疲労に比例させると
    // 均衡値が0.3前後に落ち着き、怠惰（疲労耐性）の差がそのまま均衡の差になる。
    const so = sinOutputs(sins(p));
    const load = p.role === ROLE.IDLE || p.role === ROLE.CHILD ? 0 : 0.045;
    p.fatigue = clamp01(p.fatigue + load * so.疲労耐性 - 0.12 * p.fatigue);
    p.power = citizenPower(p);
  }

  const net = gross - hidden;
  w.yieldRate = net;
  w.consumption = eat;
  w.food = clamp(w.food + net - eat, -20, C.FOOD_CAP_BASE + pop * C.FOOD_CAP_PER_HEAD);

  // 隠匿：オーナーからは「なぜか産出が落ちている」としか見えない
  if (hidden > net * 0.18 && hidden > 0.4 && rng.bool(0.10)) {
    const culprit = pickWeighted(w, rng, (p) => produce(p, w, landFactor).hidden);
    if (culprit) {
      const ev = record(w, '隠匿', {
        actor: culprit.id,
        claimed: { by: null, blame: '不作', text: '不作である' },
        revealed: false,
        text: `${culprit.name}が収穫を隠した`,
        effects: [{ field: '産出率', delta: -hidden }],
      });
      applyDelta(w, w, '産出率', -hidden, ev.id);
      events.push(ev);
    }
  }

  // 飢餓
  if (w.food <= 0) {
    w.food = 0;
    // 餓死は「不足の深さ」に比例させる。定率にすると、わずかな不作でも
    // 小さい村が丸ごと消えて、崩壊が読めない事故になる
    const deficit = clamp((eat - net) / Math.max(0.01, eat), 0, 1);
    for (const p of [...w.people.values()]) {
      if (isProtectedFounder(w, p) || isFragileVillage(w)) continue;
      const so = sinOutputs(sins(p));
      const pDie = 0.05 * deficit * (1 - clamp01(so.飢餓耐性)) * (1 + density);
      if (rng.bool(pDie)) {
        const ev = kill(w, p, '餓死', null);
        events.push(ev);
      }
    }
  }

  // 狩りの事故（練度の入口にリスクを付ける）。
  // 狩技が上がるほど安全になる＝練度に「生き延びる」という出力が付く
  for (const p of w.people.values()) {
    if (p.role !== ROLE.HUNT) continue;
    if (isProtectedFounder(w, p) || isFragileVillage(w)) continue;
    const cs = combatStats(p);
    const skill = clamp01(p.skills.狩技 ?? 0);
    const pDie = 0.0030 * (1.6 - clamp01(cs.nerve)) * (1.4 - p.genes.頑健) * (1 - 0.6 * skill);
    if (rng.bool(pDie)) {
      const ev = kill(w, p, '事故', null);
      events.push(ev);
      break;
    }
  }

  updateMorale(w);
  return events;
}

/** 練度の伸び。環境係数（生育地・家業・貧富）が伸び率を決める。遺伝は一切関与しない。 */
function gainSkills(w, p, rng) {
  const table = C.SKILL_GAIN[p.role] || {};
  const so = sinOutputs(sins(p));
  const foodPer = w.people.size ? w.food / w.people.size : 0;
  // 貧しいほど早く働きに出て早く伸びる（代わりに体格と寿命に負債）
  const poverty = clamp(1.25 - foodPer * 0.12, 0.85, 1.25);
  const place = p.district === DISTRICT.FRONTIER ? 1.22 : 0.92;
  const youth = p.age < C.ADULT_AGE ? 0.5 : clamp(1.15 - p.age * 0.05, 0.5, 1.15);
  const envCoef = poverty * place * youth * so.練度補正;
  for (const [sk, rate] of Object.entries(table)) {
    const cur = p.skills[sk] ?? 0;
    p.skills[sk] = clamp01(cur + rate * envCoef * (1 - cur) / C.TICKS_PER_GEN * 4);
  }
  // 辺境は恐怖耐性がタダで伸びる（獣と飢え）。中心部は伸びない
  if (p.district === DISTRICT.FRONTIER) {
    const cur = p.skills.恐怖耐性 ?? 0;
    p.skills.恐怖耐性 = clamp01(cur + 0.012 * (1 - cur));
  }
}

/**
 * 創世の二匹は村が根付くまで死なない。
 *
 * 実測で全体の1/4近くが「第1世代でアダムが狩りの事故で死に、
 * 残った1体が8世代かけて老衰する」という終わり方をしていた。
 * 個体数2から始める設計である以上、最初の2体に平常の死亡率を掛けると
 * 世界が始まる前に終わる。設計文書が創世の個体を特別扱いしている
 * （神を直接見た2体／その子孫は文化ミームを持つ）ので、そこに乗せる。
 */
function isProtectedFounder(w, p) {
  return !!p.founder && w.people.size < 6;
}

/**
 * 根付く前の村では、餓死と事故で人が減らない。
 *
 * P1は「素質と運で決まる」——それは初戦の勝敗の話であって、
 * 村が存在するかどうかの話ではない。個体数2〜5の段階で1体失うと
 * 系がそのまま止まるので、思想も遺伝も一度も測れないまま終わる。
 * 老衰だけは通す（時間は誰にでも等しく流れる）。
 */
function isFragileVillage(w) {
  return w.phase === PHASE.VILLAGE && w.people.size < 6;
}

function densityStress(w) {
  // 密度は土地に対して測る。食料に対して測ると、食料の上限が人口に比例している
  // 以上、密度が永久にゼロになって人口が発散する
  const cap = Math.max(4, w.land * C.POP_PER_LAND + w.tech * 4);
  return clamp(w.people.size / cap - 1, 0, 4);
}

/**
 * 開墾と土地消耗。
 *
 * 開墾は「余剰があるとき」ではなく「人手があるとき」に進む。
 * 余剰を条件にすると、一度人口が土地を追い越した世界は
 * 余剰が出ない→土地が増えない→永久に余剰が出ない、というデッドロックに落ちて
 * 必ず絶滅する（実測でここが主な死因だった）。畑を拓くのは飢えているときの仕事である。
 */
function updateLand(w) {
  const farmers = [...w.people.values()].filter((p) => p.role === ROLE.FARM).length;
  if (farmers > 0) {
    const diligence = meanGene(w, '勤勉');
    w.land += C.LAND_GROW * Math.min(farmers, w.land * 1.5) * (0.5 + diligence);
  }
  w.land = clamp(w.land * (1 - C.LAND_DECAY), 4, C.LAND_MAX);
}

function meanGene(w, name) {
  let s = 0, n = 0;
  for (const p of w.people.values()) { s += p.genes[name] ?? 0.5; n++; }
  return n ? s / n : 0.5;
}

function updateMorale(w) {
  const pop = w.people.size;
  if (!pop) return;
  let unmet = 0, grudge = 0;
  for (const p of w.people.values()) {
    p.unmet = unmetTotal(p, w);
    unmet += p.unmet;
    grudge += clamp01(p.regimeGrudge);
  }
  const mUnmet = unmet / pop;
  const mGrudge = grudge / pop;
  const target = clamp(0.85 - mUnmet * 0.6 - mGrudge * 0.8 - w.density * 0.10, C.MORALE_FLOOR, 1);
  w.morale = w.morale + (target - w.morale) * 0.25;
  w.regimeGrudge = mGrudge;
}

// ---------------------------------------------------------------------------
// 世代
// ---------------------------------------------------------------------------

export function advanceGeneration(w, rng) {
  const events = [];
  // その世代の残りticksを消化する（UIが刻んでいれば0回、ヘッドレスなら12回）
  const wanted = (w.gen + 1) * C.TICKS_PER_GEN;
  let guard = C.TICKS_PER_GEN * 2;
  while (w.tick < wanted && guard-- > 0) events.push(...stepTick(w, rng));

  // 世代境界で起きることは「新しい世代の出来事」として記録する。
  // 観測側は advanceGeneration の直後に world.gen で引くので、ここで先に進めておかないと
  // その世代の粛清も一揆も年代記から拾えない。
  w.gen++;
  updateLand(w);

  // 1. 発現（幼少期にその局面に置かれたか）。ここを逃すと素質は一生開かない
  for (const p of w.people.values()) {
    if (p.age <= C.EXPRESS_AGE) expressChild(w, p, rng, events);
  }

  // 2. 加齢
  for (const p of w.people.values()) p.age++;

  // 3. 死（老衰・傷病）
  for (const p of [...w.people.values()]) {
    if (isProtectedFounder(w, p)) continue;
    const so = sinOutputs(sins(p));
    const debt = p.district === DISTRICT.FRONTIER ? 0.85 : 1;
    const life = (C.BASE_LIFESPAN + C.LIFESPAN_SPAN * p.genes.寿命)
      * so.寿命補正 * debt * (p.lifeJitter ?? 1) * (p.vitality ?? 1);
    let pDie = 0.012;
    if (p.age > life) pDie = clamp(0.22 + (p.age - life) * 0.32, 0, 0.96);
    if (p.wounded) pDie += 0.06;
    pDie += 0.05 * w.density;   // 密度ストレスは餓死の崖の手前で効く
    // オーナーが望む形質の個体は中心部に置かれ、良い配給を受け、危険な役から外れる。
    // 望まれない個体は辺境に送られる。淘汰装置としてのオーナーはここにも出る
    pDie *= clamp(2 - preferenceMatch(w, p), 0.45, 2.2);
    if (rng.bool(pDie)) events.push(kill(w, p, p.age > life ? '老衰' : '傷病', null));
  }

  // 4. 配役（成人した者、役なしの者）
  autoAssign(w, rng, events);

  // 5. 繁殖
  events.push(...breedGeneration(w, rng));

  // 6. 怨恨の整理：個人怨恨は本人の死で消える。体制怨恨は消えない
  for (const p of w.people.values()) {
    for (const k of Object.keys(p.grudges)) {
      const id = Number(k);
      if (!w.people.has(id)) delete p.grudges[k];
    }
    p.regimeGrudge = clamp01(p.regimeGrudge * (1 - C.GRUDGE_DECAY));
    p.mated = false;
  }

  // 7. 謀反・一揆
  const reb = checkRebellion(w, rng);
  if (reb) events.push(reb);

  // 8. フェーズ移行
  //
  // 順番は「10体到達 → 初戦 → 戦後処理 → フェーズ2」。
  // 人口だけで上げていたときは、初戦より先に部族フェーズへ入ってしまい、
  // 配役タブが消えたあとに初戦が来ていた。設計はその逆で、
  // フェーズ2は**外来血の流入で幕を開ける**——初戦で連れ帰った1体が幕開けそのもの。
  if (w.people.size >= PHASE_THRESHOLD[1]) w.reachedThreshold = true;
  if (w.phase === PHASE.VILLAGE && w.reachedThreshold) {
    if (!w.firstWarDone) {
      // 強制戦争。閾値に達したがまだ戦っていない。ここで足踏みさせる
      if (!w.pendingFirstWar) {
        w.pendingFirstWar = true;
        events.push(record(w, '初戦の予兆', {
          text: '村が10体に達した。隣のシャーレが見えている',
        }));
      }
    } else {
      w.phase = PHASE.TRIBE;
      w.pendingFirstWar = false;
      events.push(record(w, 'フェーズ移行', {
        text: '村が部族になった。もう一人ずつ手で置くことはできない',
      }));
    }
  }

  // 「敷く」：融和か隔離か。カードがオンのときだけオーナーの数字が通る
  //（ライバル国はカードを使わず profile が直接 foreignBias を持つので干渉しない）
  const mix = readCard(w, 'mix_policy');
  if (mix != null) w.mating.foreignBias = clamp((mix - 50) / 50, -1, 1);

  // 9. 世代ログの確定。粛清は世代の途中（具申の裁定やライバル国の手番）でも起きるので
  //    カウンタに溜めておき、ここで新しい世代の目盛りに書き込む
  w.purgeLog[w.gen] = w._pendingPurges;
  w._pendingPurges = 0;
  w.rebelLog[w.gen] = reb ? 1 : 0;

  updateMorale(w);
  recomputeAggregates(w);
  if (w.gen % 25 === 0) pruneChronicle(w, 40);

  w.collapsing = w.people.size > 0 && w.yieldRate < w.consumption * 0.85 && w.food < 3;

  const report = makeReport(w, events);
  return { events, report };
}

function expressChild(w, p, rng, events) {
  if (p.expressed.war && p.expressed.prod) return;
  const f = w.people.get(p.fatherId) || w.dead.get(p.fatherId);
  const m = w.people.get(p.motherId) || w.dead.get(p.motherId);
  let seg = SEG_OF_ROLE[p.role] || SEG_OF_ROLE[f?.role] || SEG_OF_ROLE[m?.role] || null;
  // 辺境で育てば戦争側が勝手に開く。中心部は開きにくい
  if (p.district === DISTRICT.FRONTIER && rng.bool(0.45)) seg = 'war';
  const openP = p.district === DISTRICT.CENTER ? 0.62 : 0.85;
  if (seg && !p.expressed[seg] && rng.bool(openP)) {
    p.expressed[seg] = true;
    p.power = citizenPower(p);
    events.push(record(w, '発現', {
      actor: p.id,
      text: `${p.name}の${seg === 'war' ? '戦の' : '生産の'}素質が開いた`,
    }));
  }
  // 内発／外発：幼少期にその欲が「行為」で満たされたか「報酬」で満たされたか
  const surplus = w.people.size ? w.food / w.people.size : 0;
  const byAct = { 憤怒: seg === 'war', 傲慢: seg === 'war', 強欲: seg === 'prod', 怠惰: !seg };
  for (const k of Object.keys(byAct)) {
    if (p.motive[k]) continue;
    if (byAct[k] && surplus < 3.0) p.motive[k] = 'intrinsic';
    else if (surplus > 2.2) p.motive[k] = 'extrinsic';
    else p.motive[k] = rng.bool(0.45) ? 'intrinsic' : 'extrinsic';
  }
}

function autoAssign(w, rng, events) {
  const huntShare = cardOr(w, 'hunt_ratio', 30) / 100;
  // 模擬戦は産出しない。村の段階（働き手が数人）で兵を抱えると、
  // 思想の差が出る前に食料で潰れる。演習はP2から
  const drillShare = w.phase === PHASE.VILLAGE ? 0 : cardOr(w, 'drill', 0) / 100;
  const adults = [...w.people.values()].filter((p) => p.age >= C.ADULT_AGE);
  const needFood = w.food < w.people.size * 2.5;
  for (const p of adults) {
    if (p.roleLocked) continue;              // オーナーが名指しで置いた個体は動かさない
    if (p.role === ROLE.WAR) p.role = ROLE.IDLE;
    if (p.role !== ROLE.CHILD && p.role !== ROLE.IDLE && rng.bool(0.72)) continue;
    const r = rng.next();
    let role;
    if (needFood) role = r < 0.62 ? ROLE.FARM : (r < 0.62 + huntShare ? ROLE.HUNT : ROLE.FARM);
    else if (r < drillShare) role = ROLE.DRILL;
    else if (r < drillShare + huntShare) role = ROLE.HUNT;
    else role = ROLE.FARM;
    // 意欲係数：本人が望まない役は性能が出ないので、望む方へ弱く引く
    if (willingness(p, role) < 0.5 && rng.bool(0.5)) {
      role = willingness(p, ROLE.HUNT) > willingness(p, ROLE.FARM) ? ROLE.HUNT : ROLE.FARM;
    }
    p.role = role;
  }
  for (const p of w.people.values()) {
    if (p.age < C.ADULT_AGE) p.role = ROLE.CHILD;
  }
}

function breedGeneration(w, rng) {
  const events = [];
  if (w.people.size >= C.MAX_POP) return events;
  const adults = [...w.people.values()].filter((p) => p.age >= C.ADULT_AGE);
  const males = adults.filter((p) => p.sex === 0);
  const females = adults.filter((p) => p.sex === 1 && p.age <= C.FERTILE_MAX);
  if (!males.length || !females.length) return events;

  const foodPer = w.food / Math.max(1, w.people.size);
  // 備蓄（ストック）だけを見ると、産出がすでに消費を割っていても
  // 蔵が満ちている間は増え続け、空になった瞬間に崖から落ちる。
  // ストックとフロー（産出／消費）の両方を見て、崖の手前で効かせる。
  const flow = clamp(w.yieldRate / Math.max(0.01, w.consumption), 0, 1.6);
  // 床を置くのが要点。ゼロにすると飢饉のあいだ子が1人も生まれず、
  // 残った1コホートが揃って老衰して確実に絶滅する（実測で39/40が這うようにこれで死んだ）。
  // 飢えても子は生まれる。減るのは崩壊であって絶滅ではない。
  const foodFactor = clamp(Math.pow(foodPer / 2.4, 1.2) * Math.pow(flow, 0.8), 0.15, 1.2);
  const density = densityStress(w);
  const scale = (C.PHASE_FERT[w.phase] ?? 1) * (w.fertBias ?? 1) / (1 + density * density);
  const pFemale = femaleBias(w, males, females);

  for (const mother of females) {
    if (w.people.size >= C.MAX_POP) break;
    const sn = sins(mother);
    const so = sinOutputs(sn);
    const ageFert = clamp(1 - Math.max(0, mother.age - C.FERTILE_PEAK) * C.FERTILE_FALL, 0, 1);
    let p = scale * (0.35 + 0.85 * mother.genes.繁殖性) * so.繁殖補正 * ageFert
          * foodFactor * (0.45 + 0.55 * w.morale) * (1 - clamp01(mother.fatigue) * 0.3)
          * (mother.vitality ?? 1)    // 腐った血統は子も残せなくなる
          * preferenceMatch(w, mother);
    const father = chooseMate(w, mother, males, rng);
    if (!father) continue;
    // 融和／隔離は「その組み合わせが成立するか」に効く。
    // 相手選びの重みにしか掛けていなかったとき、外来の女は候補が全員よそ者なので
    // 全候補が同じ係数で割られ、正規化された抽選では何も起きなかった——
    // 隔離政策なのに外来の血が母系から素通りしていた。
    p *= originFactor(w, father, mother);
    p = clamp(p, 0, 3.2);
    let n = Math.floor(p);
    if (rng.bool(p - n)) n++;
    if (n <= 0) continue;
    mother.mated = true; father.mated = true;
    for (let i = 0; i < n && w.people.size < C.MAX_POP; i++) {
      events.push(birth(w, father, mother, rng, pFemale));
    }
  }
  return events;
}

/**
 * 小さい村では性比が偏ると一発で詰む（男ばかり生まれた村は次の世代がない）。
 * 少数側に寄せる弱い補正を掛ける。人口が増えれば効かなくなる。
 */
function femaleBias(w, males, females) {
  const tot = males.length + females.length;
  if (!tot || w.people.size >= 24) return 0.5;
  const strength = 0.7 * (1 - w.people.size / 24);
  return clamp(0.5 + strength * (males.length / tot - 0.5), 0.2, 0.8);
}

function chooseMate(w, mother, males, rng) {
  let total = 0;
  const scored = [];
  for (const m of males) {
    if (m.id === mother.id) continue;
    const sn = sins(m);
    let s = 0.3 + 0.7 * m.power + 0.5 * sn.色欲 + 0.3 * m.deeds.length * 0.1;
    if (m.district === mother.district) s *= 1.35;
    // 地位と実績は繁殖機会になる。逃走は戦功が付かないので機会が落ちる（社会的コスト）
    if (m.bureau) s *= 1.7;
    s *= 1 + 0.22 * m.titles.length;
    if (m.cowardice) s *= Math.max(0.45, 1 - 0.22 * m.cowardice);
    // オーナーが引き上げた形質は、地位を通して血が濃くなる
    s *= preferenceMatch(w, m);
    // 血統の好み。純血路線は外来血を避け、融和路線は寄せる
    s *= originFactor(w, m, mother);
    // 個人怨恨は結ばれない
    if (mother.grudges[m.id] > 0.4 || m.grudges[mother.id] > 0.4) s *= 0.15;
    // 村は狭い。近い血ほど結ばれやすく、その結果として劣性ホモが溜まる。
    // inbreedGuard（融和・実力主義が高く、純血・世襲がゼロ）だけがこれを抑える。
    // 村（P1）では相手が数人しかいないので、そもそも選びようがない。効かせるのはP2から
    const kin = w.phase === PHASE.VILLAGE ? 0 : kinship(w, m, mother);
    if (kin >= 0.9) {
      // 兄弟・親子は方針に関係なく避ける（ウェスターマーク効果）。
      // これがないと村内婚が「いちばん近い血をいちばん好む」形になり、
      // 実測で母親から見た土着の男の平均血縁度が0.90——村がほぼ兄妹婚で回っていた。
      // そして血縁ゼロのよそ者が最も選ばれない相手になり、捕虜が子を残せなかった。
      s *= C.INCEST_AVOID;
    } else if (kin > 0) {
      // いとこ・同じ家は好む。ここが近親交配の実体（村内婚であって兄妹婚ではない）。
      // guard=0 なら好み、0.5 で中立、1 なら同じ強さで避ける
      const guard = clamp01(w.mating.inbreedGuard ?? 0);
      s *= Math.pow(1 + C.ENDOGAMY * kin, 1 - 2 * guard);
    }
    s = Math.max(0.001, s);
    scored.push([m, s]); total += s;
  }
  if (!scored.length) return null;
  let r = rng.next() * total;
  for (const [m, s] of scored) { r -= s; if (r <= 0) return m; }
  return scored[scored.length - 1][0];
}

/**
 * オーナーの統治がどの血を濃くしているか。
 *
 * オーナーは交配相手を指名できない（柵）。動かせるのは登用・叙勲・住まわせ方だけで、
 * それが地位になり、地位が繁殖機会になる——という間接経路だけがある。
 * その総和をここで1つの係数にしている。ラマルクではなくダーウィンの経路。
 */
function preferenceMatch(w, ind) {
  const pref = w.mating.prefer;
  if (!pref) return 1;
  let m = 1;
  for (const g in pref) m *= 1 + pref[g] * ((ind.genes[g] ?? 0.5) - 0.5);
  return clamp(m, 0.04, 12);
}

/**
 * 出自の異なる者どうしの結ばれやすさ。
 * mix_policy カード（0＝隔離 … 100＝融和）が world.mating.foreignBias を動かす。
 * 「100体の段階で融和か優生かを選ばされる。しかも読める規模で」——フェーズ2の第一問。
 */
function originFactor(w, a, b) {
  const bias = w.mating.foreignBias || 0;
  if (!bias || a.origin === b.origin) return 1;
  return bias > 0 ? 1 + bias * 1.6 : Math.max(0.05, 1 + bias * 0.95);
}

/**
 * 血の近さ。1.0＝親子・兄弟、0.5＝いとこ（祖父母を共有）、0＝他人。
 *
 * これが要る理由：成人男性が50人いる村で交配相手を能力だけで選ぶと、
 * 事実上のランダム交配になり、劣性ホモ率が理論下限（q²）から動かない。
 * 実測で閉鎖世界の劣性ホモ率が0.136、外交ありの下限が0.1225——
 * つまり**閉じても腐っていなかった**。腐っていないものは治らないので、
 * 雑種強勢も測れなかった。
 * 村は狭く、人は近くで結ばれる。その局所性こそが近親交配の実体である。
 */
function kinship(w, a, b) {
  if (a.id === b.id) return 1;
  const near = [a.id, a.fatherId, a.motherId].filter((x) => x != null);
  const nearB = new Set([b.id, b.fatherId, b.motherId].filter((x) => x != null));
  for (const x of near) if (nearB.has(x)) return 1;
  const grand = (ind) => {
    const s = [];
    for (const pid of [ind.fatherId, ind.motherId]) {
      if (pid == null) continue;
      const p = w.people.get(pid) ?? w.dead.get(pid);
      if (!p) continue;
      if (p.fatherId != null) s.push(p.fatherId);
      if (p.motherId != null) s.push(p.motherId);
    }
    return s;
  };
  const gb = new Set(grand(b));
  for (const x of grand(a)) if (gb.has(x)) return 0.5;
  // 同じ家（父系の氏族）は、系図では辿れなくても近い血である
  if (a.house && a.house === b.house) return 0.35;
  return 0;
}

function birth(w, father, mother, rng, pFemale = 0.5) {
  const hap = breedGenome(father.hap, mother.hap, father.genes.可塑, mother.genes.可塑, rng);
  const lineage = mixLineage(father.lineage, mother.lineage, w.originKey);
  const child = spawn(w, w.giver.take(), hap, {
    sex: rng.bool(pFemale) ? 1 : 0, age: 0, born: w.gen,
    fatherId: father.id, motherId: mother.id,
    lineage,
    district: rng.bool(0.5) ? father.district : mother.district,
    origin: dominantOrigin(lineage, w.originKey),
    house: father.house,                                  // 家系は父系で継ぐ
    noble: !!(father.noble || mother.noble || father.bureau || mother.bureau),
  });
  for (let pass = 0; pass < 3; pass++) {
    if (!enforceChromosomeCeiling(child.genes, father.genes, mother.genes)) break;
  }
  enforceNoUniversalSuperiority(child.genes, father.genes, mother.genes);
  child.power = citizenPower(child);

  // 体制怨恨は家系に継承される。個人怨恨は継承しない
  child.regimeGrudge = clamp01(((father.regimeGrudge + mother.regimeGrudge) / 2) * C.GRUDGE_INHERIT);
  child.myth = !!(father.myth || mother.myth);

  const ev = record(w, '誕生', {
    actor: child.id, target: mother.id,
    text: `${child.name}が生まれた（${father.name}と${mother.name}）`,
    effects: [{ field: '血統', delta: 1, subjectId: child.id }],
  });
  // 出所の継承。3世代後の謀反から原因の粛清まで遡れるのはこれのおかげ
  inheritLedger(w, child, [father, mother], C.GRUDGE_INHERIT / 2);
  applyDelta(w, child, '血統', 1, ev.id);

  // 劣性ホモが表に出たら記録する（数世代潜伏していたものが今出た）
  const rh = recessiveHomo(hap);
  if (rh.length) {
    child.surfaced = rh;
    const strong = rh.filter((g) => Math.abs(child.genes[g] - 0.5) > 0.28);
    if (strong.length) {
      record(w, '潜伏形質の発現', {
        actor: child.id, trueCause: ev.id, revealed: false,
        text: `${child.name}に${strong.join('・')}が現れた`,
      });
    }
  }
  return ev;
}

/** 血統の最大成分をその個体の出自とする。コイン投げで継ぐと外来の系統が
 *  遺伝子を残したままラベルだけランダムウォークで消える（実測で16世代で0になった）。 */
function dominantOrigin(lineage, fallback) {
  let best = fallback, bv = -1;
  for (const k in lineage) if (lineage[k] > bv) { bv = lineage[k]; best = k; }
  return best;
}

function mixLineage(a, b, fallback = 'home') {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) out[k] = (out[k] || 0) + v * 0.5;
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v * 0.5;
  let s = 0; for (const v of Object.values(out)) s += v;
  if (s > 0) for (const k of Object.keys(out)) out[k] /= s;
  // 1%未満の系統は畳む（色相計算が無限に細かくならないように）
  for (const k of Object.keys(out)) if (out[k] < 0.01) delete out[k];
  let s2 = 0; for (const v of Object.values(out)) s2 += v;
  if (s2 > 0) for (const k of Object.keys(out)) out[k] /= s2;
  return Object.keys(out).length ? out : { [fallback]: 1 };
}

// ---------------------------------------------------------------------------
// 死・粛清
// ---------------------------------------------------------------------------

/**
 * 死。戦死は「なかったこと」にしない。
 * @param detail 戦死の内訳など。'war:stat'（ステータス由来）/ 'war:luck'（流れ矢）
 */
export function kill(w, ind, cause, causeEventId, detail = null) {
  if (!w.people.has(ind.id)) return null;
  ind.alive = false;
  ind.deathGen = w.gen;
  ind.deathCause = cause;
  if (detail) {
    ind.deathDetail = detail;
    ind.deathByLuck = detail === 'war:luck';
  }
  w.people.delete(ind.id);
  w.dead.set(ind.id, ind);
  const key = detail || cause;
  w.deathStats[key] = (w.deathStats[key] || 0) + 1;
  if (w.bureaus) {
    for (const k of Object.keys(w.bureaus)) if (w.bureaus[k] === ind.id) w.bureaus[k] = null;
  }
  return record(w, '死亡', {
    actor: ind.id, trueCause: causeEventId,
    text: `${ind.name}が${cause}した`,
    cause, detail,
    effects: [{ field: '血統', delta: -1, subjectId: ind.id }],
  });
}

/**
 * 粛清。オーナーの動詞「殺す」。v2ではUIに出さない（P3以降）が、
 * ライバル国の恐怖統治と、可読性テスト（3世代後の謀反）に必要なので実装する。
 * 怨恨は体制に向く。局長個人には向かない。
 */
export function purge(w, id, rng, reason = '粛清') {
  const ind = w.people.get(id);
  if (!ind) return null;
  const ev = record(w, '粛清', {
    actor: null, target: id,
    claimed: { by: w.bureaus.military, blame: ind.name, text: `${ind.name}は謀反人であった` },
    revealed: true,
    text: `${ind.name}が${reason}された`,
  });
  // 遺族と目撃者に体制怨恨。冤罪は最も純度が高い
  const kin = [...w.people.values()].filter(
    (p) => p.fatherId === id || p.motherId === id || p.id === ind.fatherId || p.id === ind.motherId
  );
  for (const k of kin) {
    k.regimeGrudge = clamp01(k.regimeGrudge + 0.45);
    applyDelta(w, k, '怨恨', 0.45, ev.id);
  }
  for (const p of w.people.values()) {
    if (kin.includes(p)) continue;
    const d = 0.05 * (0.4 + p.genes.感受性) * (1 - 0.5 * p.genes.従順);
    p.regimeGrudge = clamp01(p.regimeGrudge + d);
    applyDelta(w, p, '怨恨', d, ev.id);
  }
  kill(w, ind, '処刑', ev.id);
  w._pendingPurges++;
  w.purges = w.purges || [];
  w.purges.push({ gen: w.gen, id, name: ind.name, house: ind.house, eventId: ev.id, reason });
  updateMorale(w);
  return ev;
}

// ---------------------------------------------------------------------------
// 謀反：怨恨 × 感受性 × 扇動者の存在
// ---------------------------------------------------------------------------

function checkRebellion(w, rng) {
  const pop = w.people.size;
  if (pop < 4) return null;
  // 蜂起の直後は鎮圧と消耗で動けない。これがないと一揆が2世代に1度起き続け、
  // そのたびに備蓄が焼けて国が経済ではなく暴動で死ぬ
  if (w.gen - (w.lastRebelGen ?? -99) < C.REBEL_COOLDOWN) return null;
  let sum = 0;
  const agitators = [];
  for (const p of w.people.values()) {
    sum += clamp01(p.regimeGrudge);
    // 高感受性 × 高知性 × 怨恨 ＝ 扇動者。8番と2番から導出されるので新規の遺伝子は要らない
    if (p.genes.感受性 > 0.58 && p.genes.知性 > 0.55 && p.regimeGrudge > 0.45) agitators.push(p);
  }
  const mean = sum / pop;
  // 恐怖は短期には効く。粛清の直後に蜂起は起きない——起きるのは、
  // それを見ていない世代が怨恨だけを相続して大人になったあとである。
  // この抑圧項がないと相関のピークが lag=0 に来て、「3世代後に返る」が測れない。
  w.fear = clamp01((w.fear ?? 0) * 0.58 + (w._pendingPurges + (w.purgeLog[w.gen - 1] ?? 0)) / Math.max(4, pop) * 2.6);
  const suppression = 1 / (1 + 5.0 * w.fear);
  const pressure = mean * (1 - w.morale) * (1 + agitators.length * 0.35) * suppression;
  if (pressure < 0.22) return null;
  if (!rng.bool(clamp(pressure, 0, 0.9))) return null;

  const rebels = [...w.people.values()]
    .filter((p) => p.regimeGrudge > mean * 0.8 && p.age >= C.ADULT_AGE)
    .sort((a, b) => b.regimeGrudge - a.regimeGrudge)
    .slice(0, Math.max(2, Math.floor(pop * 0.25)));
  if (rebels.length < 2) return null;

  // 真の原因＝反乱者の怨恨台帳で最も寄与の大きい事件。ここが年代記の鎖の要
  const cause = dominantCause(rebels);
  const causeEv = cause != null ? w.eventById.get(cause) : null;
  const leader = agitators[0] || rebels[0];
  w.rebellions++;
  w.lastRebelGen = w.gen;
  w.rebels = w.rebels || [];
  w.rebels.push({
    gen: w.gen, leader: leader.id, n: rebels.length,
    trueCause: cause, causeGen: causeEv ? causeEv.gen : null,
    causeKind: causeEv ? causeEv.kind : null,
    lag: causeEv ? w.gen - causeEv.gen : null,   // 「3世代後に返る」の実測値
  });
  const ev = record(w, '一揆', {
    actor: leader.id,
    trueCause: cause,
    claimed: { by: w.bureaus.civil, blame: '飢饉', text: '飢饉による暴発である' },
    revealed: agitators.length > 0,
    text: `${leader.name}を中心に${rebels.length}名が蜂起した`,
    effects: [{ field: '民心', delta: -0.25 }],
  });
  applyDelta(w, w, '民心', -0.25, ev.id);
  w.morale = clamp(w.morale - 0.25, C.MORALE_FLOOR, 1);
  // 備蓄を焼く
  const burn = w.food * clamp(0.15 + rebels.length / pop, 0, 0.6);
  w.food = Math.max(0, w.food - burn);
  applyDelta(w, w, '産出率', -burn, ev.id);
  return ev;
}

/** 個体群の怨恨台帳から、最も寄与の大きい上流事件を選ぶ。 */
export function dominantCause(people) {
  const acc = new Map();
  for (const p of people) {
    for (const d of p.ledger || []) {
      if (d.field !== '怨恨' || d.eventId == null) continue;
      acc.set(d.eventId, (acc.get(d.eventId) || 0) + Math.abs(d.delta));
    }
  }
  let best = null, bestV = 0;
  for (const [id, v] of acc) if (v > bestV) { bestV = v; best = id; }
  return best;
}

// ---------------------------------------------------------------------------
// オーナーの動詞：置く
// ---------------------------------------------------------------------------

export function assignRole(w, id, role) {
  if (w.phase !== PHASE.VILLAGE) return null;   // P2で「自分で配役する」ボタンは消える
  const p = w.people.get(id);
  if (!p || !Object.values(ROLE).includes(role)) return null;
  const prev = p.role;
  p.role = role;
  p.roleLocked = true;
  return record(w, '配役', {
    target: id, text: `${p.name}を${roleLabel(role)}に置いた（前は${roleLabel(prev)}）`,
  });
}

export function setDistrict(w, id, district) {
  const p = w.people.get(id);
  if (!p || !Object.values(DISTRICT).includes(district)) return null;
  const prev = p.district;
  if (prev === district) return null;
  p.district = district;
  return record(w, '移住', {
    target: id,
    text: `${p.name}を${district === DISTRICT.FRONTIER ? '辺境' : '中心'}へ移した`,
  });
}

/** 任命＝神の実在を教えること。前任者は個人怨恨のノードになる。 */
export function appointBureau(w, bureauKey, id) {
  if (!Object.values(BUREAU).includes(bureauKey)) return null;
  const prevId = w.bureaus[bureauKey];
  const p = id == null ? null : w.people.get(id);
  if (id != null && !p) return null;
  w.lastChief = w.lastChief || {};
  if (prevId != null) w.lastChief[bureauKey] = prevId;
  if (prevId != null && w.people.has(prevId)) {
    const prev = w.people.get(prevId);
    prev.bureau = null;
    if (id != null) {
      // 弾かれた前任者は後任を憎む。これは個人怨恨（本人の死で消える）
      prev.grudges[id] = clamp01((prev.grudges[id] || 0) + 0.35 + 0.4 * prev.genes.誇り);
      prev.regimeGrudge = clamp01(prev.regimeGrudge + 0.12 * prev.genes.誇り);
    }
  }
  w.bureaus[bureauKey] = id;
  if (p) {
    p.bureau = bureauKey;
    p.knowsOwner = true;   // 入信儀式。知ってしまった人間は市井に戻せない
    p.will = willingness(p, 'bureau');
    p.accept = acceptance(p, w);
    // 出自つきの任命ログ。透過率が血統構造を変えるかはこれでしか測れない
    const house = w.houses.get(p.house);
    p.houseRank = house ? house.bureauCount : 0;
    w.bureauLog.push({
      gen: w.gen, bureau: bureauKey, id: p.id, name: p.name,
      house: p.house, houseRank: p.houseRank, noble: !!p.noble,
      power: citizenPower(p), deeds: p.deeds.length, accept: p.accept,
      fatherId: p.fatherId, immigrant: !!p.immigrant,
    });
    if (house) house.bureauCount++;
    p.noble = true;        // 局長を出した家はここから名家になる
  }
  const ev = record(w, '任命', {
    target: id,
    text: p ? `${p.name}を${BUREAU_LABEL[bureauKey]}長にした` : `${BUREAU_LABEL[bureauKey]}長を空席にした`,
  });
  // 受容係数が低い（無名の抜擢）と周囲に軋轢が出る
  if (p && p.accept < 0.5) {
    for (const q of w.people.values()) {
      if (q.id === p.id) continue;
      const d = 0.06 * q.genes.序列意識;
      q.grudges[p.id] = clamp01((q.grudges[p.id] || 0) + d);
    }
  }
  return ev;
}

function roleLabel(r) {
  return { idle: '無役', farm: '農作業', hunt: '狩り', drill: '模擬戦', war: '実戦', child: '子ども' }[r] || r;
}

// ---------------------------------------------------------------------------
// 読む：検索
// ---------------------------------------------------------------------------

/**
 * 素質・年齢・役割・居住区・所属で絞る。
 * 未発現の素質は確定値を出さない（レンジ表示）ので、UI用に est を付ける。
 */
export function search(w, filters = {}) {
  const f = filters || {};
  let list = [...w.people.values()];
  if (f.role) { const rs = [].concat(f.role); list = list.filter((p) => rs.includes(p.role)); }
  if (f.district) list = list.filter((p) => p.district === f.district);
  if (f.bureau !== undefined) {
    if (f.bureau === null) list = list.filter((p) => !p.bureau);
    else list = list.filter((p) => p.bureau === f.bureau);
  }
  if (f.minAge != null) list = list.filter((p) => p.age >= f.minAge);
  if (f.maxAge != null) list = list.filter((p) => p.age <= f.maxAge);
  if (f.sex != null) list = list.filter((p) => p.sex === f.sex);
  if (f.origin) list = list.filter((p) => p.origin === f.origin);
  if (f.expressed) list = list.filter((p) => !!p.expressed[f.expressed]);
  if (f.unexpressed) list = list.filter((p) => !p.expressed[f.unexpressed]);
  if (f.gene && GENE_NAMES.includes(f.gene)) {
    const lo = f.min ?? 0, hi = f.max ?? 1;
    list = list.filter((p) => p.genes[f.gene] >= lo && p.genes[f.gene] <= hi);
  }
  if (f.minPower != null) list = list.filter((p) => citizenPower(p) >= f.minPower);
  const key = f.sort || (f.gene ? 'gene' : 'power');
  const cmp = {
    power: (a, b) => citizenPower(b) - citizenPower(a),
    gene: (a, b) => (b.genes[f.gene] ?? 0) - (a.genes[f.gene] ?? 0),
    age: (a, b) => a.age - b.age,
    id: (a, b) => a.id - b.id,
    grudge: (a, b) => b.regimeGrudge - a.regimeGrudge,
  }[key] || ((a, b) => a.id - b.id);
  list.sort(cmp);
  return f.limit ? list.slice(0, f.limit) : list;
}

/** 未発現の素質はレンジで返す（真値±10%）。確定値を出すと検索してソートするだけの作業になる。 */
export function readGene(w, ind, gene, rng) {
  const v = ind.genes[gene] ?? 0;
  const seg = { 攻撃素質: 'war', 胆力: 'war', 統率素質: 'war', 器用: 'prod', 技術習得: 'prod', 共同作業適性: 'prod' }[gene];
  if (!seg || ind.expressed[seg]) return { value: v, exact: true };
  const w10 = 0.10;
  return { value: null, exact: false, lo: clamp01(v - w10), hi: clamp01(v + w10) };
}

// ---------------------------------------------------------------------------

function pickWeighted(w, rng, fn) {
  let total = 0; const arr = [];
  for (const p of w.people.values()) { const v = Math.max(0, fn(p)); if (v > 0) { arr.push([p, v]); total += v; } }
  if (!arr.length) return null;
  let r = rng.next() * total;
  for (const [p, v] of arr) { r -= v; if (r <= 0) return p; }
  return arr[arr.length - 1][0];
}

export function recomputeAggregates(w) {
  const pop = w.people.size;
  const st = { gen: w.gen, pop, food: w.food, morale: w.morale, yield: w.yieldRate, consumption: w.consumption };
  if (!pop) { st.power = 0; st.homoz = 0; st.grudge = 0; st.foreign = 0; w.stats.push(st); w.powerIndex = 0; return st; }
  let power = 0, homoz = 0, grudge = 0, foreign = 0, admix = 0, pure = 0;
  const geneSum = {};
  for (const n of GENE_NAMES) geneSum[n] = 0;
  for (const p of w.people.values()) {
    power += citizenPower(p);
    homoz += p.homoz ?? 0;
    grudge += clamp01(p.regimeGrudge);
    foreign += 1 - (p.lineage[w.originKey] ?? 0);
    // 同化のメーター。色が混ざる＝遺伝が混ざる、が比喩ではなく同じ処理になる。
    // 外来血の「量」とは別物で、隔離政策では量が多いまま混血度だけがゼロに張り付く（＝斑）
    let top = 0;
    for (const k in p.lineage) if (p.lineage[k] > top) top = p.lineage[k];
    admix += 1 - top;
    if (top > 0.95) pure++;
    for (const n of GENE_NAMES) geneSum[n] += p.genes[n];
  }
  st.power = power / pop;
  st.homoz = homoz / pop;
  st.grudge = grudge / pop;
  st.foreign = foreign / pop;
  st.admixture = admix / pop;   // 0＝単色/斑、0.5＝完全な混色
  st.pure = pure / pop;         // 純血個体の割合
  st.genes = {};
  for (const n of GENE_NAMES) st.genes[n] = geneSum[n] / pop;
  w.stats.push(st);
  if (w.stats.length > 1200) w.stats.splice(0, w.stats.length - 1200);
  // 国力：意図的に情報を捨てるスカラー。混ぜた時点で構成が復元不能になるのが機能
  w.powerIndex = Math.round(
    pop * 0.55 + power * pop * 1.4 + Math.max(0, w.yieldRate) * 2.2
    + w.tech * 3 + w.morale * 8 + st.foreign * 12 * pop * 0.05
  );
  return st;
}

function makeReport(w, events) {
  const kinds = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const chief = (k) => {
    const id = w.bureaus[k];
    const p = id != null ? w.people.get(id) : null;
    return p ? p.name : '空席';
  };
  const soldiers = [...w.people.values()].filter((p) => p.role === ROLE.HUNT || p.role === ROLE.DRILL).length;
  const farmers = [...w.people.values()].filter((p) => p.role === ROLE.FARM).length;
  const lines = [
    `軍務局（${chief(BUREAU.MILITARY)}）：狩り・演習に${soldiers}名。` +
      (w.lastWarGen >= 0 ? `直近の戦は第${w.lastWarGen}世代。` : '戦の記録はない。'),
    `農業局（${chief(BUREAU.AGRI)}）：${farmers}名が耕し、産出${w.yieldRate.toFixed(1)}／消費${w.consumption.toFixed(1)}。備蓄${w.food.toFixed(1)}。`,
    `民生局（${chief(BUREAU.CIVIL)}）：人口${w.people.size}、民心${(w.morale * 100).toFixed(0)}％、` +
      `誕生${kinds['誕生'] || 0}・死亡${kinds['死亡'] || 0}。` +
      (kinds['一揆'] ? '蜂起が起きた。' : ''),
  ];
  return {
    gen: w.gen, pop: w.people.size, food: w.food, morale: w.morale,
    yieldRate: w.yieldRate, consumption: w.consumption,
    powerIndex: w.powerIndex, phase: w.phase, collapsing: w.collapsing,
    lines, counts: kinds,
  };
}

export { carriers };
