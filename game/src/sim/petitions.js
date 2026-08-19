// 具申。セッションの心臓。
//
// LLMは使わない。局長の人格ベクトル × 世界の状態から、
// 「誰が・誰を相手に・何を賭けて」の3要素の組み合わせで種類を出す。
// テンプレは11種しかないが、主体×対象×賭けの積で実際の見え方はほぼ重複しない。
//
// 承認しても却下しても誰かが不満を持つ。無害な選択は作らない。

import { BUREAU, BUREAU_LABEL, ROLE } from '../core/model.js';
import * as C from './constants.js';
import { sins, citizenPower, clamp, clamp01 } from './derive.js';
import { record, applyDelta } from './chronicle.js';
import { setCard } from './cards.js';
import { purge } from './world.js';

// 何を賭けているか。予算・人材・名誉・命・方針の5種
export const STAKE = {
  BUDGET: '予算', PEOPLE: '人材', HONOR: '名誉', LIFE: '命', POLICY: '方針',
};

const KINDS = [
  {
    key: '讒言', stake: STAKE.HONOR,
    // 序列意識（嫉妬）と野心が高いほど他局を陥れにいく
    score: (ch, w, sn) => 0.15 + 0.9 * sn.嫉妬 + 0.6 * ch.genes.野心 - 0.4 * ch.genes.情愛,
    needs: (w) => otherChiefs(w).length > 0,
  },
  {
    key: '予算要求', stake: STAKE.BUDGET,
    score: (ch, w, sn) => 0.2 + 0.7 * ch.genes.野心 + 0.5 * sn.強欲,
  },
  {
    key: '引抜', stake: STAKE.PEOPLE,
    score: (ch, w, sn) => 0.1 + 0.8 * ch.genes.野心 + 0.4 * ch.genes.統率素質 - 0.3 * ch.genes.従順,
  },
  {
    key: '粛清具申', stake: STAKE.LIFE,
    score: (ch, w, sn) => (w.regimeGrudge > 0.25 ? 0.4 : 0) + 0.9 * ch.genes.非情 + 0.5 * sn.憤怒 - 0.6 * ch.genes.情愛,
  },
  {
    key: '開戦具申', stake: STAKE.POLICY,
    score: (ch, w, sn) => (ch.bureau === BUREAU.MILITARY ? 0.5 : 0) + 0.8 * sn.憤怒 + 0.5 * ch.genes.野心 - 0.7 * ch.genes.保身,
  },
  {
    key: '温存', stake: STAKE.POLICY,
    score: (ch, w, sn) => 0.8 * ch.genes.保身 + 0.4 * ch.genes.情愛 - 0.6 * ch.genes.野心,
  },
  {
    key: '世襲固定', stake: STAKE.POLICY,
    score: (ch, w, sn) => 0.9 * ch.genes.頑迷 + 0.5 * ch.genes.序列意識 - 0.8 * ch.genes.柔軟,
  },
  {
    key: '抜擢', stake: STAKE.PEOPLE,
    score: (ch, w, sn) => 0.9 * ch.genes.柔軟 + 0.4 * ch.genes.好奇心 - 0.7 * ch.genes.頑迷,
  },
  {
    key: '慰撫', stake: STAKE.BUDGET,
    score: (ch, w, sn) => 0.8 * ch.genes.情愛 + (w.morale < 0.5 ? 0.6 : 0) - 0.5 * ch.genes.非情,
  },
  {
    key: '叙勲要求', stake: STAKE.HONOR,
    score: (ch, w, sn) => 0.9 * sn.傲慢 + 0.4 * ch.genes.誇り,
  },
  {
    key: '増産', stake: STAKE.POLICY,
    score: (ch, w, sn) => 0.7 * ch.genes.勤勉 + (w.food < w.people.size * 2 ? 0.8 : 0) - 0.5 * sn.怠惰,
  },
];

function otherChiefs(w) {
  const out = [];
  for (const k of Object.values(BUREAU)) {
    const id = w.bureaus[k];
    if (id != null && w.people.has(id)) out.push(w.people.get(id));
  }
  return out;
}

/** 局長の人格 × 世界状態から具申を作る。毎世代2〜5件。溜めない。 */
export function petitions(w, rng) {
  const out = [];
  const chiefs = [];
  for (const k of Object.values(BUREAU)) {
    const id = w.bureaus[k];
    if (id != null && w.people.has(id)) chiefs.push([k, w.people.get(id)]);
  }
  if (!chiefs.length) return out;

  for (const [bkey, ch] of chiefs) {
    const sn = sins(ch);
    const scored = KINDS
      .filter((k) => !k.needs || k.needs(w))
      .map((k) => [k, Math.max(0.01, k.score(ch, w, sn) * (0.7 + 0.6 * rng.next()))])
      .sort((a, b) => b[1] - a[1]);
    const n = 1 + (rng.next() < clamp(0.25 + 0.5 * ch.genes.野心, 0, 0.8) ? 1 : 0);
    for (let i = 0; i < n && i < scored.length; i++) {
      const p = buildPetition(w, rng, bkey, ch, scored[i][0], scored[i][1]);
      if (p) { out.push(p); w.petitions.set(p.id, p); }
    }
  }
  return out.slice(0, 5);
}

function buildPetition(w, rng, bkey, ch, kind, weight) {
  const id = w.nextPetitionId++;
  const others = otherChiefs(w).filter((c) => c.id !== ch.id);
  const rival = others.length ? others[rng.int(others.length)] : null;
  const commons = [...w.people.values()].filter((p) => p.age >= C.ADULT_AGE && !p.bureau && p.id !== ch.id);
  const suspect = commons.length
    ? commons.slice().sort((a, b) => (b.regimeGrudge - a.regimeGrudge))[0] : null;
  const talent = commons.length
    ? commons.slice().sort((a, b) => citizenPower(b) - citizenPower(a))[0] : null;
  const bereaved = commons.length
    ? commons.slice().sort((a, b) => b.regimeGrudge - a.regimeGrudge)[rng.int(Math.min(3, commons.length))] : null;

  const B = BUREAU_LABEL[bkey];
  const P = { id, gen: w.gen, bureauKey: bkey, actorId: ch.id, actorName: ch.name, kind: kind.key, stake: kind.stake, weight };

  switch (kind.key) {
    case '讒言':
      if (!rival) return null;
      P.targetId = rival.id; P.targetName = rival.name;
      P.text = `${B}長${ch.name}の具申：${BUREAU_LABEL[rival.bureau]}長${rival.name}に不審の廉あり。${P.stake}を賭けて糾弾したい。`;
      P.approveText = `${rival.name}の名誉を剥ぐ`; P.rejectText = '取り合わない';
      break;
    case '予算要求':
      P.targetBureau = bkey;
      P.text = `${B}長${ch.name}の具申：${B}への配分を厚くされたい。他局から回してもらう。`;
      P.approveText = `${B}に配分を寄せる`; P.rejectText = '据え置く';
      break;
    case '引抜':
      if (!talent || !rival) return null;
      P.targetId = talent.id; P.targetName = talent.name; P.targetBureau = rival.bureau;
      P.text = `${B}長${ch.name}の具申：${talent.name}を${B}へ移したい。${BUREAU_LABEL[rival.bureau]}が抱え込んでいる。`;
      P.approveText = `${talent.name}を${B}へ`; P.rejectText = '動かさない';
      break;
    case '粛清具申':
      if (!suspect) return null;
      P.targetId = suspect.id; P.targetName = suspect.name;
      P.text = `${B}長${ch.name}の具申：${suspect.name}は不穏である。命を賭して申し上げる、始末されたい。`;
      P.approveText = `${suspect.name}を粛清する`; P.rejectText = '放置する';
      break;
    case '開戦具申':
      P.text = `${B}長${ch.name}の具申：兵が鈍っている。次の戦を仕掛けられたい。`;
      P.approveText = '戦の支度を許す'; P.rejectText = '控えさせる';
      break;
    case '温存':
      P.text = `${B}長${ch.name}の具申：精鋭を出すべきではない。派遣を絞られたい。`;
      P.approveText = '派遣を絞る'; P.rejectText = '予定どおり出す';
      break;
    case '世襲固定':
      P.text = `${B}長${ch.name}の具申：家の格を乱すべきではない。役は血で継がせたい。`;
      P.approveText = '世襲を認める'; P.rejectText = '認めない';
      break;
    case '抜擢':
      if (!talent) return null;
      P.targetId = talent.id; P.targetName = talent.name;
      P.text = `${B}長${ch.name}の具申：${talent.name}は家柄こそないが器がある。引き上げたい。`;
      P.approveText = `${talent.name}を引き上げる`; P.rejectText = '据え置く';
      break;
    case '慰撫':
      if (!bereaved) return null;
      P.targetId = bereaved.id; P.targetName = bereaved.name;
      P.text = `${B}長${ch.name}の具申：${bereaved.name}ら遺族に配給を回されたい。恨みが溜まっている。`;
      P.approveText = '配給を回す'; P.rejectText = '回さない';
      break;
    case '叙勲要求':
      P.text = `${B}長${ch.name}の具申：${B}の働きに名を与えられたい。称号を賜りたい。`;
      P.approveText = `${ch.name}に称号を与える`; P.rejectText = '与えない';
      break;
    case '増産':
      P.text = `${B}長${ch.name}の具申：畑を広げたい。人手をこちらに回されたい。`;
      P.approveText = '人手を農に回す'; P.rejectText = '回さない';
      break;
    default: return null;
  }
  return P;
}

/**
 * 裁く。どちらを選んでも必ず誰かが不満を持つ。
 * 却下し続ければ局長が腐り、承認し続ければその局が肥大する。
 */
export function resolvePetition(w, petitionId, approve, rng) {
  const P = w.petitions.get(petitionId);
  if (!P) return [];
  if (P.resolved) return [];
  P.resolved = true;
  P.approved = !!approve;
  const events = [];
  const ch = w.people.get(P.actorId);
  const target = P.targetId != null ? w.people.get(P.targetId) : null;

  const base = record(w, '裁定', {
    actor: P.actorId, target: P.targetId ?? null,
    claimed: { by: P.actorId, blame: P.targetName ?? null, text: P.text },
    revealed: true,
    text: approve ? `【承認】${P.text}` : `【却下】${P.text}`,
  });
  events.push(base);

  if (!approve) {
    // 却下：局長が腐る。欲が未充足のまま残り、体制への怨恨に変わる
    if (ch) {
      const sn = sins(ch);
      const d = 0.10 + 0.18 * ch.genes.誇り + 0.12 * sn.傲慢;
      ch.regimeGrudge = clamp01(ch.regimeGrudge + d);
      applyDelta(w, ch, '怨恨', d, base.id);
      ch.spurned = (ch.spurned || 0) + 1;
    }
    // ただし却下で救われる者もいる
    if (P.kind === '粛清具申' && target) target.grudges[P.actorId] = clamp01((target.grudges[P.actorId] || 0) + 0.4);
    if (P.kind === '讒言' && target) {
      const d = 0.06;
      target.grudges[P.actorId] = clamp01((target.grudges[P.actorId] || 0) + 0.5);
      applyDelta(w, target, '怨恨', d, base.id);
    }
    return events;
  }

  // 承認：局が肥大し、割を食った側に怨恨が積む
  switch (P.kind) {
    case '讒言':
      if (target) {
        target.titles = target.titles.filter((t) => t.kind !== '叙勲');
        target.titles.push({ kind: '断罪', gen: w.gen, by: P.actorId });
        target.grudges[P.actorId] = clamp01((target.grudges[P.actorId] || 0) + 0.75);
        const d = 0.30;
        target.regimeGrudge = clamp01(target.regimeGrudge + d);
        applyDelta(w, target, '怨恨', d, base.id);
        if (ch) ch.deeds.push({ kind: '政争', gen: w.gen });
      }
      break;
    case '予算要求': {
      const k = P.bureauKey;
      const others = Object.keys(w.budget).filter((x) => x !== k);
      const take = 0.10;
      w.budget[k] = clamp(w.budget[k] + take, 0, 1);
      for (const o of others) w.budget[o] = clamp(w.budget[o] - take / others.length, 0, 1);
      for (const o of others) {
        const cid = w.bureaus[o];
        const c = cid != null ? w.people.get(cid) : null;
        if (c) c.grudges[P.actorId] = clamp01((c.grudges[P.actorId] || 0) + 0.3);
      }
      break;
    }
    case '引抜':
      if (target) {
        target.roleLocked = true;
        target.role = P.bureauKey === BUREAU.MILITARY ? ROLE.DRILL : ROLE.FARM;
        const rid = w.bureaus[P.targetBureau];
        const r = rid != null ? w.people.get(rid) : null;
        if (r) r.grudges[P.actorId] = clamp01((r.grudges[P.actorId] || 0) + 0.4);
      }
      break;
    case '粛清具申':
      if (target) {
        // 冤罪は最も純度が高い。証拠はないが入力は無制限
        const pev = purge(w, target.id, rng, '謀反の疑い');
        if (pev) { pev.trueCause = base.id; events.push(pev); }
      }
      break;
    case '開戦具申':
      w.warPending = true;
      for (const p of w.people.values()) {
        const sn = sins(p);
        if (sn.憤怒 < 0.35) p.regimeGrudge = clamp01(p.regimeGrudge + 0.04);
      }
      break;
    case '温存':
      setCard(w, 'deploy_top', true, Math.max(5, (w.cards.deploy_top?.value ?? 40) - 15));
      break;
    case '世襲固定':
      w.transparency = clamp(w.transparency - 0.15, 0.05, 0.95);
      // 塞がれた才能は謀反の入力になる
      for (const p of w.people.values()) {
        if (p.bureau || p.age < C.ADULT_AGE) continue;
        if (citizenPower(p) > 0.45 && !p.deeds.length) {
          const d = 0.10 * (0.5 + p.genes.野心);
          p.regimeGrudge = clamp01(p.regimeGrudge + d);
          applyDelta(w, p, '怨恨', d, base.id);
        }
      }
      break;
    case '抜擢':
      if (target) {
        target.titles.push({ kind: '抜擢', gen: w.gen });
        w.transparency = clamp(w.transparency + 0.10, 0.05, 0.95);
        for (const p of w.people.values()) {
          if (p.id === target.id) continue;
          p.grudges[target.id] = clamp01((p.grudges[target.id] || 0) + 0.05 * p.genes.序列意識);
        }
      }
      break;
    case '慰撫':
      if (target) {
        const d = -0.30;
        target.regimeGrudge = clamp01(target.regimeGrudge + d);
        applyDelta(w, target, '怨恨', d, base.id);
      }
      w.food = Math.max(0, w.food - Math.max(2, w.people.size * 0.3));
      break;
    case '叙勲要求':
      if (ch) {
        ch.titles.push({ kind: '叙勲', gen: w.gen });
        // 傲慢は称号だけで満たせるので安い。ただし他者の嫉妬を買う
        for (const p of w.people.values()) {
          if (p.id === ch.id) continue;
          const sn = sins(p);
          p.grudges[ch.id] = clamp01((p.grudges[ch.id] || 0) + 0.10 * sn.嫉妬);
        }
      }
      break;
    case '増産':
      for (const p of w.people.values()) {
        if (p.age < C.ADULT_AGE || p.bureau) continue;
        if (p.role === ROLE.HUNT || p.role === ROLE.DRILL) {
          p.role = ROLE.FARM;
          const sn = sins(p);
          if (sn.憤怒 > 0.4) p.regimeGrudge = clamp01(p.regimeGrudge + 0.06);
        }
      }
      break;
  }
  if (ch) ch.deeds.push({ kind: '具申通過', gen: w.gen });
  return events;
}
