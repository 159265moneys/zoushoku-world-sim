// 「願い」（具申）。局の長からの要求。通す／断るの2つだけ。
// 中立な要望ではなく、その長にとって得のある手。誰が得をして誰が損をするかを出す。

import { el, clear, toast, mount } from '../dom.js';
import { PHASE } from '../../core/model.js';
import { portrait } from '../color.js';

export function renderPetitions(ctx, node, { compact = false } = {}) {
  const { world, api, rng } = ctx;
  clear(node);

  const hasChiefs = Object.values(world.bureaus || {}).some(v => v != null);
  if (world.phase === PHASE.VILLAGE || !hasChiefs) {
    node.appendChild(el('div', { class: 'empty' },
      world.phase === PHASE.VILLAGE
        ? 'まだ局はない。全員が目の前にいるので、誰かに頼まれるまでもない。'
        : '局の長が1人もいない。誰も何も言ってこない。「長を選ぶ」で先に長を据える。'));
    return;
  }

  const list = api.petitions(world, rng) || [];
  if (!list.length) {
    node.appendChild(el('div', { class: 'empty' }, 'いまは何も言われていない。'));
    return;
  }

  if (!compact) {
    node.appendChild(el('div', { class: 'lead-note' },
      'どちらを選んでも誰かが不満を持つ。断り続ければ長が腐り、通し続ければその局が肥る。'));
  }

  for (const p of list) {
    const chief = world.people.get(p.fromId);
    const card = el('div', { class: 'card' });
    mount(card,
      el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '7px' } },
        chief ? portrait(world, chief, 28) : null,
        el('div', { style: { flex: '1', minWidth: 0 } },
          el('h4', { style: { margin: 0, fontSize: '16px' } }, p.title),
          el('div', { class: 'mut', style: { fontSize: '13px' } }, `${p.bureauLabel}　${p.fromName}`)),
      ),
      el('p', { style: { fontSize: '14px', color: 'var(--tx)' } }, p.detail),
      el('div', { class: 'kv', style: { marginTop: '9px' } },
        el('div', { class: 'k' }, '得をする'), el('div', { class: 'v' }, p.gain),
        el('div', { class: 'k' }, '損をする'), el('div', { class: 'v' }, p.lose),
        el('div', { class: 'k' }, 'なぜ言うのか'), el('div', { class: 'v' }, p.motive),
      ),
      p.risk ? el('p', { class: 'hint', style: { color: 'var(--warn)' } }, p.risk) : null,
      el('div', { style: { display: 'flex', gap: '9px', marginTop: '11px' } },
        el('button', {
          class: 'btn primary big', style: { flex: 1 },
          onclick: () => { api.resolvePetition(world, p.id, true, rng); toast(`「${p.title}」を通した`); ctx.refresh(); },
        }, '通す'),
        el('button', {
          class: 'btn danger big', style: { flex: 1 },
          onclick: () => { api.resolvePetition(world, p.id, false, rng); toast(`「${p.title}」を断った`, 'warn'); ctx.refresh(); },
        }, '断る'),
      ),
    );
    node.appendChild(card);
  }
}

export function petitionCount(ctx) {
  const { world, api, rng } = ctx;
  if (!world || world.phase === PHASE.VILLAGE) return 0;
  if (!Object.values(world.bureaus || {}).some(v => v != null)) return 0;
  try { return (api.petitions(world, rng) || []).length; } catch { return 0; }
}
