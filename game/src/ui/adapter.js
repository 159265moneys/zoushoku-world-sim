// ============================================================================
// adapter.js — 本物の src/sim を、画面が期待している形に写す層。
//
// sim は「シミュレーションとして正しい形」を持っていて、UI は「絵として読める形」を
// 期待している。両者は素直には一致しない。ズレはすべてここに閉じ込める。
// **src/sim は絶対に触らない。UI 側のコードも変えない。**
//
// 写しているのは主に4つ：
//   1. 血統の入れ物   world.origins(Map, hue 0..1) -> world.strains(object, hue 度)
//   2. 世代の記録     world.stats -> world.history
//   3. 国境の待ち行列 world.border(Map) -> world.borderQueue(配列)
//   4. 戦闘           battle.sides.home/away(units) -> battle.a/.b(fighters)
//
// 色相だけは sim の値をそのまま使わず、こちらで割り当て直している（後述）。
// ============================================================================

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- 色相

// sim は色相を 0..1 で均等に配る（0, 0.1, 0.2 …）。これをそのまま度に直すと
// 自国(赤)とほぼ同じ色の国が出てきて、「捕虜が1体入った瞬間に色が違う」が成立しない。
// 色は完全に表示側の都合なので、ここで割り当て直す。制約は2つ：
//   - 自国(0度)から60度以上離す
//   - 赤の対蹠点(180度付近)を空ける。ほぼ正反対の色相は円環上の中点が
//     どちら回りか不安定になり、似た親から正反対の子色が出る
const HUE_BANDS = [60, 84, 108, 132, 156, 204, 228, 252, 276, 300];

function hash32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** 血統キー -> 表示用の色相（度）。自国は必ず 0（赤）。 */
function displayHue(key, homeKey) {
  if (key === homeKey || key === 'home' || key === 'self') return 0;
  return HUE_BANDS[hash32(key) % HUE_BANDS.length];
}

// 出自キー -> 読める国名。sim の origins は 'agrarian' のようなプロファイルidを
// そのまま名前に使うことがあるので、対戦相手一覧で見えた国名を覚えておいて充てる。
const ORIGIN_NAMES = new Map();
function rememberOrigin(key, name) {
  if (key && name && !/^[a-z_]+$/.test(String(name))) ORIGIN_NAMES.set(key, name);
}
function originName(key, fallback) {
  return ORIGIN_NAMES.get(key) || (fallback && !/^[a-z_]+$/.test(String(fallback)) ? fallback : null) || String(key);
}

// ---------------------------------------------------------------- world

const adapted = new WeakSet();

/** sim の world に、UI が読むプロパティを getter として生やす。実体は複製しない。 */
export function adaptWorld(w) {
  if (!w || typeof w !== 'object' || adapted.has(w)) return w;
  adapted.add(w);

  const homeKey = w.originKey || 'home';
  const def = (name, get) => {
    if (name in w) return;                    // sim が既に持っているなら触らない
    Object.defineProperty(w, name, { get, configurable: true, enumerable: false });
  };

  // 1. 血統。origins は Map（キー -> {key,name,hue 0..1}）。
  def('strains', () => {
    const src = w.origins;
    const out = {};
    const put = (k, v) => {
      const nm = k === homeKey ? ((v && v.name) || '我らの血') : originName(k, v && v.name);
      out[k] = { key: k, name: nm, hue: displayHue(k, homeKey) };
    };
    if (src instanceof Map) for (const [k, v] of src) put(k, v);
    else if (src && typeof src === 'object') for (const k in src) put(k, src[k]);
    else put(homeKey, { name: '我らの血' });
    if (!out[homeKey]) put(homeKey, { name: '我らの血' });
    // 国境で待っている捕虜の出自は、まだ world.origins に入っていない
    // （入国して初めて登録される）。国境画面で色と名前を出すために先に足す。
    const q = w.border instanceof Map ? [...w.border.values()] : [];
    for (const c of q) for (const k in (c.lineage || {})) if (!out[k]) put(k, { name: c.homeName });
    return out;
  });

  // 2. 推移グラフ。sim は stats、UI は history。
  //
  // admixture / pure を必ず持って来ること。**外来血の「量」(foreign) は同化の
  // メーターにならない**：隔離するとよそ者どうしで繁殖して系統が薄まらないので、
  // 量は多いまま混血度だけがゼロに張り付く（＝斑のまま固定）。
  // 量だけ見て「混ざってきた」と出すと、隔離政策の見え方がまるごと嘘になる。
  def('history', () => (w.stats || []).map(s => ({
    gen: s.gen,
    pop: s.pop,
    yieldRate: s.yield ?? s.yieldRate ?? 0,
    consumption: s.consumption ?? 0,
    morale: s.morale ?? 0,
    food: s.food ?? 0,
    grudge: s.grudge ?? 0,
    admixture: s.admixture ?? 0,   // 1 − 血統の最大成分。0＝単色/斑、0.5＝完全な混色
    pure: s.pure ?? 0,             // 純血個体の割合
    foreign: s.foreign ?? 0,       // 外来血の量。混ざり具合ではない
  })));

  // 同化の現在値。history の最後（＝最新世代の集計）。
  def('mixState', () => {
    const h = w.stats || [];
    const s = h[h.length - 1] || {};
    return { admixture: s.admixture ?? 0, pure: s.pure ?? 1, foreign: s.foreign ?? 0 };
  });

  // 3. 国境で待っている捕虜。sim は Map、UI は配列。
  def('borderQueue', () => (w.border instanceof Map ? [...w.border.values()]
    : Array.isArray(w.border) ? w.border : []));

  // 4. その他、sim が持っていないもの
  def('intel', () => 0);                      // v2 に諜報局はない
  if (!('name' in w)) w.name = '我らのシャーレ';
  if (!('warReady' in w)) w.warReady = false;

  return w;
}

/** 戦争できる状態か。sim 側に概念がないので画面のために導出する。 */
function refreshWarReady(w) {
  if (!w) return;
  const enough = w.people.size >= 10;
  const cooled = (w.gen - (w.lastWarGen ?? -99)) >= 2;
  const idle = !(w.borderQueue && w.borderQueue.length);
  // 初戦だけは不応期を無視する。sim は 10体に達すると pendingFirstWar を立てて
  // フェーズ移行を止めるので、ここで戦えないと世界が10体で止まったままになる。
  if (w.pendingFirstWar && idle) { w.warReady = true; return; }
  w.warReady = !!(enough && cooled && idle);
}

// ---------------------------------------------------------------- 戦闘

const ROSTER_OF = new WeakMap();   // world -> roster（startWar で相手世界を引くため）

/** listOpponents の要素 / ghost / world から、sim.startWar が食える相手を作る。 */
function toSimOpponent(sim, roster, opponent) {
  if (!opponent) return sim.makeGhost(Date0(), 1, 300);
  // すでに sim の相手の形（people が配列）ならそのまま
  if (Array.isArray(opponent.people)) return opponent;

  // listOpponents の要素 -> peek で相手の world を引いて、people を配列に開く
  const w2 = opponent.world || (roster && sim.peek ? sim.peek(roster, opponent.id) : null);
  if (w2 && w2.people) {
    return {
      key: opponent.id || w2.originKey || 'foe',
      name: opponent.name || w2.name || '敵国',
      seed: w2.seed,
      phase: w2.phase,
      profile: opponent.profile || w2.profile || 'ghost',
      people: [...w2.people.values()],
      strength: opponent.power ?? 0,
      powerIndex: w2.powerIndex,
      hue: opponent.hue ?? 0,
      ruthless: 0.35,
      deployTop: 60,
      _world: w2,
    };
  }
  return opponent;
}
function Date0() { return 1; }   // 種を Date に依存させない

/**
 * 戦闘画面で敵の個体を描くための血統表。
 * 相手世界の出自キーを全部載せる。相手自身の出自だけは、こちらから見た色
 * （＝国力一覧や捕虜と同じ色）に固定する。相手世界の中では自国＝赤だが、
 * こちらから見ているので赤にしてはいけない。
 */
function foeStrains(foe, hue) {
  const out = {};
  const w2 = foe._world;
  if (w2 && w2.origins instanceof Map) {
    for (const [k, v] of w2.origins) {
      out[k] = { key: k, name: (v && v.name) || String(k), hue: displayHue(k, null) };
    }
  }
  const own = (w2 && w2.originKey) || foe.key || 'home';
  out[own] = { key: own, name: `${foe.name}の血`, hue };
  if (!out.home) out.home = { key: 'home', name: `${foe.name}の血`, hue };
  if (!out.self) out.self = { key: 'self', name: `${foe.name}の血`, hue };
  return out;
}

/** sim の battle を UI の見た目用モデルに射影する。 */
function projectBattle(view) {
  const b = view._sim;
  const S = view._sides;
  for (const [uiKey, simKey] of [['a', 'home'], ['b', 'away']]) {
    const side = b.sides[simKey];
    const dst = view[uiKey];
    const base = side.c0 || 1;
    dst.cohesion = clamp((side.cohesion ?? 0) / base);
    // 名前は開戦時に決めたものを使う。sim は home を一律 '自国' と呼ぶので、
    // 上書きすると団結バーとモーダルの見出しから国の名前が消える。
    if (!dst.name) dst.name = side.name;

    side.units.forEach((u, i) => {
      let f = dst.fighters[i];
      if (!f) {
        const n = side.units.length;
        // 5対5なら1列。sim は数十体を送り込んでくるので、列を折り返して格子に並べる。
        const rows = Math.min(n, 8);
        const cols = Math.ceil(n / rows);
        const col = Math.floor(i / rows), row = i % rows;
        const inner = cols > 1 ? (col / (cols - 1)) * 0.16 : 0;
        f = dst.fighters[i] = {
          id: u.key, indId: u.id, name: u.name, ind: u.ind, side: uiKey,
          x: uiKey === 'a' ? 0.20 - inner : 0.80 + inner,
          y: rows > 1 ? 0.09 + (0.82 * row) / (rows - 1) : 0.5,
          hp: 1, fear: 0, state: 'fight',
        };
      }
      f.ind = u.ind;
      f.hp = u.maxHp ? clamp(u.hp / u.maxHp) : (u.dead ? 0 : 1);
      const prev = f.state;
      f.state = u.dead ? 'dead' : (u.fled ? 'flee' : 'fight');
      // 恐怖は sim に無いので団結と胆力から出す。目の細さに使うだけ。
      const nerve = (u.stats && u.stats.nerve) != null ? u.stats.nerve : 0.5;
      f.fear = u.dead ? 1 : clamp((1 - dst.cohesion) * (1.35 - nerve) + (u.fled ? 0.7 : 0));
      // 位置
      const dir = uiKey === 'a' ? 1 : -1;
      if (f.state === 'fight') f.x += dir * 0.010;
      else if (f.state === 'flee') f.x -= dir * 0.030;
      f.x = clamp(f.x, 0.02, 0.98);

      // 状態が変わったらログの一行にする（sim のログは数値スナップショットなので文にならない）
      if (prev !== f.state) {
        if (f.state === 'dead') {
          view.deaths[uiKey].push(f);
          pushLog(view, `${u.name} が倒れた。`, 'bad');
        } else if (f.state === 'flee') {
          pushLog(view, `${u.name} が背を向けた。`, 'flee');
        }
      }
    });
  }

  view.t = b.round ?? view.t;
  view.over = !!b.over;
  if (b.over && !view._closed) {
    view._closed = true;
    const o = b.outcome || {};
    view.outcome = view.surrendered ? 'surrender' : (o.winner === 'home' ? 'win' : 'lose');
    pushLog(view,
      view.outcome === 'win' ? `${view.b.name} の団結が折れた。敗走。`
        : view.outcome === 'surrender' ? '降伏が受諾された。'
        : 'こちらの団結が折れた。敗走。',
      view.outcome === 'lose' ? 'bad' : 'hi');
  }
  return view;
}

function pushLog(view, text, cls = '') {
  view.log.push({ t: view.t, text, cls });
  if (view.log.length > 400) view.log.shift();
}

// ---------------------------------------------------------------- 具申・カード

const BUREAU_LABEL = { military: '軍務局', agri: '農業局', civil: '民生局' };
const G = (ind, k) => (ind && ind.genes && ind.genes[k] != null ? ind.genes[k] : 0.5);

// sim の具申は {kind, stake, targetBureau, text, approveText, rejectText} を持つが、
// 「誰が得をして誰が損をするか」は持っていない。画面の要求はそこなので、
// 賭けているもの(stake)と相手(targetBureau)と局長の性格から組み立てる。
function stakeSides(p, w, chief) {
  const mine = BUREAU_LABEL[p.bureauKey] || p.bureauKey || '局';
  const other = p.targetBureau && p.targetBureau !== p.bureauKey
    ? (BUREAU_LABEL[p.targetBureau] || p.targetBureau) : null;
  const byStake = {
    予算: { gain: `${mine}（配分が厚くなる）`, lose: other ? `${other}（削られる）` : '他局（削られる）' },
    人材: { gain: `${mine}（人手）`, lose: other ? `${other}（人を抜かれる）` : '他局（人を抜かれる）' },
    名誉: { gain: `${chief ? chief.name : mine}（面目が立つ）`, lose: '競っている家系（序列が下がる）' },
    命: { gain: `${mine}（統制）`, lose: '対象の家系（体制怨恨が積む）' },
    方針: { gain: `${mine}（やり方が通る）`, lose: '反対側の局（やり方を曲げられる）' },
  };
  return byStake[p.stake] || { gain: mine, lose: other || '—' };
}

function motiveOf(c) {
  if (!c) return '—';
  const parts = [];
  for (const k of ['野心', '保身', '誇り', '勤勉', '私欲']) {
    if (G(c, k) > 0.55) parts.push(`${k} ${Math.round(G(c, k) * 100)}`);
  }
  return parts.join(' / ') || '目立った偏りはない';
}

function riskOf(c) {
  if (!c) return null;
  if (G(c, '野心') > 0.6) return '野心が高い。これは要望ではなく手だ。';
  if (G(c, '保身') > 0.6) return '保身が高い。責任の逃げ道を作ろうとしている。';
  if (G(c, '誇り') > 0.65) return '誇りが高い。断れば助けを求めなくなる。';
  return null;
}

function adaptPetitions(list, w) {
  return (list || []).map(p => {
    const chief = p.actorId != null ? w.people.get(p.actorId) : null;
    const sides = stakeSides(p, w, chief);
    return {
      ...p,
      id: String(p.id),
      bureau: p.bureauKey || p.bureau,
      bureauLabel: BUREAU_LABEL[p.bureauKey] || p.bureauKey || '局',
      fromId: p.actorId ?? null,
      fromName: p.actorName || (chief ? chief.name : '局長'),
      title: p.kind || '具申',
      detail: p.text || '',
      gain: sides.gain,
      lose: sides.lose,
      motive: motiveOf(chief),
      risk: riskOf(chief),
      approveText: p.approveText,
      rejectText: p.rejectText,
    };
  });
}

// sim のカードは label しか持たない。何をするカードなのかの説明は表示側の仕事。
const CARD_DESC = {
  deploy_top: '戦力の高いほうから順に戦場へ送る。',
  spare_old: '老いた個体を戦場から外す。練度は残るが数が減る。',
  raise_young: '若手を実戦に出す。育つが、死ぬ。',
  guards: '上位の個体に護衛を随伴させる。護衛は代わりに死ぬ。',
  drill: '産出しないが安全に練度が伸びる。',
  surrender_at: '不在時の応戦方針。0 なら降伏しない。',
  hunt_ratio: '狩りに回す割合。産出しつつ武力の練度が伸びる。',
  stockpile: '備蓄の下限。割り込むと配役が畑へ寄る。',
  frontier: '辺境に人を置く。産出は落ちるが練度の伸びがよい。',
  ration_equal: '配給を均等にする。民心は上がるが、伸びる者が伸びない。',
  hereditary: '世襲の度合い。高いほど家柄で人事が決まる。',
  mix_policy: '0で隔離、100で融和。低いままだと外来の血は入っても混ざらず、'
    + '斑（まだら）が何世代でも固定される。高いほど中間色が増えて境界が溶ける。',
};

// 看板のカード。フェーズ2の中心の判断なので、方針タブで一段強く出す。
const FLAGSHIP = new Set(['mix_policy']);

function adaptCards(cards) {
  if (!Array.isArray(cards)) return null;
  return cards.map(c => ({
    ...c,
    name: c.name || c.label || c.id,
    desc: c.desc || c.hint || CARD_DESC[c.id] || '',
    flagship: c.flagship ?? FLAGSHIP.has(c.id),
    on: c.on !== undefined ? c.on : true,
    unit: c.unit ?? '',
    min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 5, def: c.def ?? 0,
    bureau: c.bureau || 'civil',
  }));
}

// ---------------------------------------------------------------- 本体

export function makeAdapter(sim) {
  const A = Object.create(null);

  A.createWorld = (seed, answers, opts) => {
    const w = adaptWorld(sim.createWorld(seed, answers, opts));
    refreshWarReady(w);
    return w;
  };

  A.stepTick = (w, rng) => sim.stepTick(w, rng) || [];

  A.advanceGeneration = (w, rng) => {
    const res = sim.advanceGeneration(w, rng);
    refreshWarReady(w);
    // sim は {events, ...} を返す。UI は配列を回す。
    if (Array.isArray(res)) return res;
    return (res && res.events) || [];
  };

  // 世代の長さは core/model.js の GEN_MS（実時間）と、sim の TICKS_PER_GEN
  // （1世代が何tickか）の2つで決まる。後者は sim の経済がその粒度で調律されて
  // いる数なので、画面が勝手な数を使ってはいけない（120刻みで回していたときは
  // 1世代あたり10倍の産出と練度が入っていた）。
  A.TICKS_PER_GEN = (sim.SIM_CONST && sim.SIM_CONST.TICKS_PER_GEN) || 12;

  A.createRoster = (seed) => sim.createRoster(seed);
  A.stepRoster = (roster, rng) => (sim.advanceRoster || sim.stepRoster)?.(roster, rng);

  A.listOpponents = (roster) => {
    const list = sim.listOpponents(roster) || [];
    return list.map(o => {
      const w2 = sim.peek ? sim.peek(roster, o.id) : null;
      if (w2) adaptWorld(w2);
      const prof = PROFILE_TEXT[o.profile] || {};
      // 相手の出自キーと国名を覚えておく。捕虜が来たときに「agrarian」ではなく
      // 「デメテルの血」と出せるようにするため。
      rememberOrigin(o.id, o.name);
      if (w2 && w2.originKey) rememberOrigin(w2.originKey, o.name);
      return {
        ...o,
        hue: displayHue(o.id, null),           // 表示用に割り当て直す
        profileName: o.profileName || prof.name || o.profile,
        profileDesc: o.profileDesc || prof.desc || '',
        pop: w2 ? w2.people.size : (o.pop ?? 0),
        gen: w2 ? w2.gen : (o.gen ?? 0),
        world: w2,
        power: Math.round(o.power ?? 0),
      };
    });
  };

  A.peek = (roster, id) => {
    const w2 = sim.peek ? sim.peek(roster, id) : null;
    return w2 ? adaptWorld(w2) : null;
  };

  A.makeGhost = (seed, phase, power) => sim.makeGhost(seed, phase, power);

  A.startWar = (w, rng, opponent) => {
    const roster = ROSTER_OF.get(w) || opponent?._roster || null;
    const foe = toSimOpponent(sim, roster ?? opponentRoster, opponent);
    const sb = sim.startWar(w, rng, foe);
    const hue = opponent && opponent.id ? displayHue(opponent.id, null)
      : displayHue(foe.key || foe.name || 'foe', null);
    const view = {
      _sim: sb, _rng: rng, _world: w,
      id: sb.id, gen: sb.gen ?? w.gen, seed: (w.seed ^ (w.gen * 40503)) >>> 0,
      t: 0, over: false, outcome: null, surrendered: null,
      opponent: {
        id: opponent?.id || foe.key, name: foe.name, hue,
        world: foe._world || null,
        // 相手の個体を描くときの血統表。
        // 相手の住人の lineage キーは相手世界の出自キー（'agrarian' など）なので、
        // それを全部引けるようにしておかないと、色相が hashHue の当てずっぽうに落ちて
        // 「敵は青のはずなのに緑で描かれる」になる。
        strains: foeStrains(foe, hue),
      },
      a: { name: w.name || '我らのシャーレ', hue: 0, cohesion: 1, base: 1, fighters: [], world: w },
      b: { name: foe.name, hue, cohesion: 1, base: 1, fighters: [], world: foe._world || null },
      log: [], deaths: { a: [], b: [] },
    };
    pushLog(view, `${view.a.name} と ${view.b.name} が衝突した。`
      + `${sb.sides.home.units.length} 対 ${sb.sides.away.units.length}。`, 'hi');
    return projectBattle(view);
  };

  A.stepBattle = (view, rng) => {
    if (!view || view.over) return [];
    sim.stepBattle(view._sim, rng);
    projectBattle(view);
    return [];
  };

  A.surrender = (view) => {
    const raw = sim.surrender(view._sim) || {};
    const accepted = raw.accepted !== false;
    const terms = {
      food: Math.round(raw.food ?? raw.resources ?? 0),
      captives: Math.round(raw.captives ?? raw.people ?? 0),
      accepted,
      gap: raw.gap ?? 0,
    };
    if (accepted) { view.surrendered = terms; view.over = true; }
    projectBattle(view);
    if (accepted) view.outcome = 'surrender';
    return terms;
  };

  A.captiveOptions = (view) => {
    const o = sim.captiveOptions(view._sim) || {};
    const axes = (o.axes || []).map(a => (typeof a === 'string' ? { key: a, label: a } : a));
    // 何体引けるかは sim の captiveOptions が返さない（takeCaptives が
    // CAPTIVE_COUNT[開戦時のフェーズ] から乱数で決める）。
    // 画面が「1体」と言い切って3体来る、という食い違いを起こさないよう、
    // ここで同じ定数から幅を出して、幅のまま出す。
    const [lo, hi] = captiveRange(view._sim);
    return {
      won: o.winner ?? (view.outcome === 'win'),
      axes,
      count: lo,
      countMax: hi,
      countLabel: lo === hi ? `${lo} 体` : `${lo}〜${hi} 体`,
      poolSize: o.survivors ?? o.poolSize ?? 0,
      pool: o.pool && Array.isArray(o.pool) ? o.pool : [],
      note: o.note || '',
    };
  };

  /** 開戦時のフェーズで決まる捕虜の人数の幅。P1は[1,1]、P2は[1,5]。 */
  function captiveRange(simBattle) {
    const table = (sim.SIM_CONST && sim.SIM_CONST.CAPTIVE_COUNT) || { 1: [1, 1], 2: [1, 5] };
    const phase = (simBattle && simBattle.phase) || 1;
    const r = table[phase] || table[1] || [1, 1];
    return [r[0], r[1]];
  }

  A.takeCaptives = (w, view, axis, rng) => {
    const got = sim.takeCaptives(w, view._sim, axis, rng) || [];
    const list = Array.isArray(got) ? got : [];
    const foeName = view?.opponent?.name;
    rememberOrigin(view?.opponent?.id, foeName);
    // sim の捕虜は出身国名を持っていない。国境画面が「どこから来た誰か」を出せるよう補う。
    for (const c of [...list, ...(w.borderQueue || [])]) {
      if (c && !c.homeName) c.homeName = originName(c.origin, foeName);
      if (c && c.origin) rememberOrigin(c.origin, foeName);
      if (c) c.foreign = true;
    }
    return list;
  };

  // 国境の3択。画面の語彙は 受け入れ／誅殺／送還 で、sim が読むのは
  // accept / kill / return。'execute' は sim の分岐に無く、既定の accept に
  // 落ちていた——**誅殺を押すと入国していた**。ここで必ず写す。
  const BORDER_DECISION = { accept: 'accept', execute: 'kill', kill: 'kill', return: 'return' };

  A.borderDecision = (w, id, decision) => {
    const d = BORDER_DECISION[decision] || 'accept';
    const e = sim.borderDecision(w, id, d);
    refreshWarReady(w);
    return e;
  };

  A.settleWar = (w, view) => {
    const sb = view && view._sim ? view._sim : view;
    const rng = (view && view._rng) || null;
    const r = sim.settleWar && sb && rng ? sim.settleWar(w, sb, rng) : null;
    // 初戦を終えた印。これが立たないとフェーズ2の条件が永遠に満たされず、
    // 10体の村で足踏みし続ける（クリックで最後まで通せない＝行き止まり）。
    // sim が自分で立てるなら二重に立てても同じ値なので害はない。
    if (sb && sb.firstWar) w.firstWarDone = true;
    refreshWarReady(w);
    return r;
  };

  // sim の publicRank は外国人向けで文字列を返す（'上位30%'）。
  // UI は自国民の実値も欲しいので、ここで2系統に分ける。
  // 「自国民は実値、外国人は階級のみ」という設計はここで守る。
  A.publicRank = (w, ind) => {
    const mine = w.people.has(ind.id);
    if (!mine) {
      const raw = sim.publicRank(w, ind);
      const frac = ind.homeRankPct;
      const pct = frac == null ? null : (frac <= 0.01 ? 1 : Math.min(100, Math.ceil(frac * 10) * 10));
      return { pct, label: typeof raw === 'string' ? raw : (pct != null ? `上位 ${pct}%` : '不明') };
    }
    const p = sim.citizenPower(ind);
    const all = [...w.people.values()].map(sim.citizenPower).sort((a, b) => b - a);
    const idx = all.findIndex(v => v <= p);
    const r = all.length ? clamp((idx < 0 ? all.length : idx) / all.length) : 0.5;
    const pct = r <= 0.01 ? 1 : Math.max(10, Math.ceil(r * 10) * 10);
    return { pct, label: `上位 ${pct}%`, value: Math.round(p) };
  };

  A.petitions = (w, rng) => adaptPetitions(sim.petitions(w, rng), w);
  A.resolvePetition = (w, id, ok, rng) => {
    // sim 側の id が数値なら戻す
    const n = Number(id);
    const res = sim.resolvePetition(w, Number.isFinite(n) && String(n) === String(id) ? n : id, ok, rng);
    return Array.isArray(res) ? res : (res && res.events) || [];
  };

  A.canonize = (w, id, text, opts) => (sim.setCanon || sim.canonize)?.(w, id, text, opts);

  A.powerOf = (ind) => sim.citizenPower(ind);

  // 注意：sim の rankNation は国力のスカラーではない。
  // 個体の配列を受け取り、homeRankPct を焼いて並べ替えた配列を返す関数である
  // （名前が似ているだけで別物。world を渡すと people is not iterable で落ちる）。
  // 国力は「各局の出力を潰した一つの濁った数字」なので、ここで作る。
  A.nationPower = (w) => {
    let s = 0;
    for (const p of w.people.values()) s += sim.citizenPower(p);
    return Math.round(s * (0.75 + 0.5 * (w.morale ?? 0.5)) + (w.food ?? 0) * 0.4);
  };

  /** 外国人の階級を出すために homeRankPct を焼く（sim の rankNation の本来の用途） */
  A.rankForeign = (people) => (sim.rankNation ? sim.rankNation(people) : people);

  // mix_policy（外来血を混ぜる）は **sim の cards.js に入った**ので、
  // adapter が仮に置いていたカードと setCard の分岐は落とした。ここは素通し。
  A.CARDS = adaptCards(sim.CARDS) || [];
  A.setCard = (w, id, on, value) => sim.setCard(w, id, on, value);

  // 検索のフィルタ名が違う（UI: ageMin/geneMin/strain、sim: minAge/min/origin）。
  // 血統での絞り込みは sim の origin が「主たる出自」なので lineage の最大キーで代用する。
  A.search = (w, f = {}) => {
    const out = sim.search(w, {
      role: f.role || undefined,
      district: f.district || undefined,
      minAge: f.ageMin ?? undefined,
      maxAge: f.ageMax ?? undefined,
      gene: f.gene || undefined,
      min: f.gene ? (f.geneMin ?? 0) : undefined,
      sort: SORT_MAP[f.sort] || (f.gene && f.sort === f.gene ? 'gene' : (f.sort === 'training' ? undefined : f.sort)),
      limit: undefined,
    }) || [];
    let list = out;
    if (f.strain) list = list.filter(p => dominantKey(p) === f.strain);
    if (f.includeDead) list = list.concat([...w.dead.values()]);
    if (f.sort === 'training') {
      list = [...list].sort((a, b) => trainingOf(b) - trainingOf(a));
    } else if (f.sort === 'name') {
      list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    if (f.desc === false) list = [...list].reverse();
    return list.slice(0, f.limit ?? 400);
  };

  // 素通しでよいもの
  // 注意：ここに setCard / search を入れてはいけない。上で包んだものが潰される。
  for (const k of ['assignRole', 'setDistrict', 'appointBureau',
    'chronicle', 'traceUp', 'traceDown']) {
    if (typeof sim[k] === 'function' && !(k in A)) A[k] = sim[k];
  }

  return A;
}

const SORT_MAP = { power: 'power', age: 'age', name: undefined, training: undefined };
const SKILL_KEYS = ['恐怖耐性', '統率', '戦技', '農技', '狩技'];

function trainingOf(p) {
  if (!p.skills) return 0;
  let s = 0; for (const k of SKILL_KEYS) s += p.skills[k] || 0;
  return s / SKILL_KEYS.length;
}
function dominantKey(p) {
  const L = p.lineage || {}; let best = p.origin || 'home', bv = -1;
  for (const k in L) if (L[k] > bv) { bv = L[k]; best = k; }
  return best;
}

// startWar が roster を必要とするので、main が作った roster をここに預ける
let opponentRoster = null;
export function setRoster(roster) { opponentRoster = roster; }

const PROFILE_TEXT = {
  martial: { name: '武断', desc: '狩りと実戦に厚く配役する。降伏しない。' },
  agrarian: { name: '農本', desc: '産出優先。備蓄を厚く。戦争は最小限。' },
  fecund: { name: '多産', desc: '繁殖性優先。質より量。密度ストレスを許容。' },
  purist: { name: '純血', desc: '捕虜をほぼ誅殺。自国産の血だけで回す。' },
  melting: { name: '融和', desc: '捕虜を全部受け入れる。混血を最大化。' },
  terror: { name: '恐怖', desc: '怨恨を無視して粛清を多用。従順を選抜。' },
  laissez: { name: '放任', desc: 'ほとんど何もしない。局長に丸投げ。' },
  pious: { name: '信仰', desc: '信仰性・団結傾向を選抜。排他的で捕虜を拒む。' },
  merit: { name: '実力主義', desc: '素質上位を抜擢。家柄を無視する。' },
  dynastic: { name: '世襲', desc: '局長の血統を固定。透過率を最小に。' },
};
