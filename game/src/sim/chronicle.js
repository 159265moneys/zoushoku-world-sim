// 年代記：因果の台座。
//
//  ・事件レコードは trueCause（真の原因・システムだけが知る）と
//    claimed（公表された帰属）を別カラムで持つ
//  ・出所を持たせるのは 怨恨 / 民心 / 産出率 / 血統 / 帰属 の5本だけ
//  ・値の増分に原因イベントIDが付き、継承時も出所を引き継ぐ
//  ・保持は「個体の重要度」ではなく「到達可能性」。生きている怨恨から
//    辿れる事件は無名の農民の冤罪でも残す

import { makeEvent, TRACKED } from '../core/model.js';

export function initChronicle(world) {
  world.events = [];
  world.eventById = new Map();
  world.nextEventId = 1;
  world.downstream = new Map(); // trueCause -> [eventId]
}

/**
 * 事件を1件記録する。
 * @param {object} opts.trueCause 上流の事件id（真の原因）
 * @param {object} opts.claimed   公表された帰属 {by, blame, text}
 */
export function record(world, kind, opts = {}) {
  const id = world.nextEventId++;
  const ev = makeEvent(id, world.gen, kind, opts);
  ev.tick = world.tick;
  ev.refs = 0;             // この事件を出所に持つ増分の数（保持判定に使う）
  world.events.push(ev);
  world.eventById.set(id, ev);
  if (ev.trueCause != null) {
    if (!world.downstream.has(ev.trueCause)) world.downstream.set(ev.trueCause, []);
    world.downstream.get(ev.trueCause).push(id);
  }
  return ev;
}

/**
 * 追跡対象5本の値を動かす。増分に原因イベントIDを付ける。
 * subject は個体か world（民心・産出率は world 側）。
 */
const LEDGER_MAX = 48;

export function applyDelta(world, subject, field, delta, eventId, extra = {}) {
  if (!TRACKED.includes(field)) {
    // 追跡外の値は普通に動かしてよい
    return;
  }
  if (!subject.ledger) subject.ledger = [];
  // 同じ (値, 原因事件) は1行にまとめる。台帳が無限に伸びないので畳む必要がなくなり、
  // 「生きている怨恨から上流を辿る」鎖も切れない
  const row = subject.ledger.find((d) => d.field === field && d.eventId === eventId);
  if (row) {
    row.delta += delta;
    row.gen = world.gen;
  } else {
    subject.ledger.push({ field, delta, eventId, gen: world.gen, ...extra });
    if (eventId != null) {
      const ev = world.eventById.get(eventId);
      if (ev) ev.refs++;
    }
  }
  // それでも溢れたら、寄与の小さいものから捨てる（大きい怨恨ほど鎖が残る）
  if (subject.ledger.length > LEDGER_MAX) {
    subject.ledger.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    for (const d of subject.ledger.slice(LEDGER_MAX)) {
      if (d.eventId == null) continue;
      const ev = world.eventById.get(d.eventId);
      if (ev && ev.refs > 0) ev.refs--;
    }
    subject.ledger.length = LEDGER_MAX;
  }
}

/** 継承：親の出所を子に引き継ぐ。3世代後の謀反から原因の粛清まで遡れるのはこれのため。 */
export function inheritLedger(world, child, parents, rate) {
  const seen = new Set();
  for (const p of parents) {
    if (!p || !p.ledger) continue;
    for (const d of p.ledger) {
      if (d.field !== '怨恨') continue;
      const key = d.eventId + ':' + d.field;
      if (seen.has(key)) continue;
      seen.add(key);
      applyDelta(world, child, '怨恨', d.delta * rate, d.eventId, { inherited: true, from: p.id });
    }
  }
}

/** 上流を遡る。真の原因の鎖。 */
export function traceUp(world, eventId, depth = 24) {
  const out = [];
  let cur = world.eventById.get(eventId);
  const seen = new Set();
  while (cur && depth-- > 0) {
    if (cur.trueCause == null) break;
    if (seen.has(cur.trueCause)) break;
    seen.add(cur.trueCause);
    const up = world.eventById.get(cur.trueCause);
    if (!up) break;
    out.push(up);
    cur = up;
  }
  return out;
}

/**
 * 1件を開くと上流（何が原因か）と下流（何を引き起こしたか）が展開される。
 * 年代記UIとテストはこれを叩く。
 */
export function trace(world, eventId) {
  const ev = world.eventById.get(eventId) || null;
  return {
    event: ev,
    up: ev ? traceUp(world, eventId) : [],
    down: ev ? traceDown(world, eventId) : [],
    // 表示されるのはオーナーが知っている帰属であって真の原因ではない
    visible: ev ? (ev.revealed ? 'trueCause' : 'claimed') : null,
  };
}

/** 下流に展開する。何を引き起こしたか。 */
export function traceDown(world, eventId, depth = 6) {
  const out = [];
  const walk = (id, d) => {
    if (d <= 0) return;
    const kids = world.downstream.get(id) || [];
    for (const k of kids) {
      const ev = world.eventById.get(k);
      if (!ev || out.includes(ev)) continue;
      out.push(ev);
      walk(k, d - 1);
    }
  };
  walk(eventId, depth);
  return out;
}

/**
 * 年代記の閲覧。表示されるのはオーナーが知っている帰属であって真の原因ではない。
 * revealed が立っていない事件は claimed しか読めない。
 */
export function chronicle(world, filters = {}) {
  const f = filters || {};
  let list = world.events;
  if (f.kind) {
    const kinds = Array.isArray(f.kind) ? f.kind : [f.kind];
    list = list.filter((e) => kinds.includes(e.kind));
  }
  if (f.minGen != null) list = list.filter((e) => e.gen >= f.minGen);
  if (f.maxGen != null) list = list.filter((e) => e.gen <= f.maxGen);
  if (f.actor != null) list = list.filter((e) => e.actor === f.actor);
  if (f.target != null) list = list.filter((e) => e.target === f.target);
  if (f.involving != null) list = list.filter((e) => e.actor === f.involving || e.target === f.involving);
  if (f.revealed === true) list = list.filter((e) => e.revealed);
  if (f.text) list = list.filter((e) => e.text.includes(f.text));
  const out = f.desc ? [...list].reverse() : [...list];
  return f.limit ? out.slice(0, f.limit) : out;
}

/**
 * 保持：生きている怨恨・民心・産出率・血統の増分から辿れる事件は
 * 個体の重要度に関わらず残す。参照されなくなった事件だけを畳む。
 */
export function pruneChronicle(world, keepGens = 40) {
  const cutoff = world.gen - keepGens;
  if (cutoff <= 0) return 0;
  // 生存個体の台帳から到達可能な事件を集める（上流も含めて全部辿る）
  const reach = new Set();
  const push = (id) => {
    let cur = id, guard = 64;
    while (cur != null && !reach.has(cur) && guard-- > 0) {
      reach.add(cur);
      const ev = world.eventById.get(cur);
      cur = ev ? ev.trueCause : null;
    }
  };
  for (const p of world.people.values()) {
    if (p.ledger) for (const d of p.ledger) push(d.eventId);
  }
  if (world.ledger) for (const d of world.ledger) push(d.eventId);
  for (const c of world.border.values()) {
    if (c.ledger) for (const d of c.ledger) push(d.eventId);
  }
  let dropped = 0;
  const kept = [];
  for (const ev of world.events) {
    if (ev.gen >= cutoff || reach.has(ev.id) || ev.canon || ev.pinned) { kept.push(ev); continue; }
    world.eventById.delete(ev.id);
    world.downstream.delete(ev.id);
    dropped++;
  }
  world.events = kept;
  return dropped;
}

/** 編む：公表された帰属を確定させる（v2では枠だけ。UIから呼ぶ）。 */
export function setCanon(world, eventId, canon) {
  const ev = world.eventById.get(eventId);
  if (!ev) return null;
  ev.canon = canon;
  ev.pinned = true;
  return ev;
}
