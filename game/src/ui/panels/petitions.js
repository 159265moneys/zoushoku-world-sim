// 画面6：具申。局長からの要求。承認／却下の2ボタン。
// 「誰が誰に何を賭けているか」が読めること。具申は中立な要望ではなく、10人のゲームの手。

import { el, clear, toast } from '../dom.js';
import { PHASE } from '../../core/model.js';
import { portrait } from '../color.js';

export function renderPetitions(ctx, node, { compact = false } = {}) {
  const { world, api, rng } = ctx;
  clear(node);

  const hasChiefs = Object.values(world.bureaus || {}).some(v => v != null);
  if (world.phase === PHASE.VILLAGE || !hasChiefs) {
    node.appendChild(el('div', { class: 'empty' },
      world.phase === PHASE.VILLAGE
        ? 'まだ局はない。全員が目の前にいるので、誰かの報告を待つ必要がない。'
        : '局長が空位。誰も何も求めてこない。',
      el('br'), el('span', { class: 'mut' }, '（フェーズ2で局長を任命すると、ここに具申が湧く）'),
    ));
    return;
  }

  const list = api.petitions(world, rng) || [];
  if (!list.length) {
    node.appendChild(el('div', { class: 'empty' }, 'いまは何も求められていない。'));
    return;
  }

  if (!compact) {
    node.appendChild(el('p', { class: 'hint' },
      'どちらを選んでも誰かが不満を持つ。却下し続ければ局長が腐り、承認し続ければその局が肥大する。'));
  }

  for (const p of list) {
    const chief = world.people.get(p.fromId);
    const card = el('div', { class: 'card' });
    card.append(
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '5px' } },
        chief ? portrait(world, chief, 24) : null,
        el('div', { style: { flex: '1', minWidth: 0 } },
          el('h4', { style: { margin: 0 } }, p.title),
          el('div', { class: 'mut', style: { fontSize: '10.5px' } }, `${p.bureauLabel}　${p.fromName}`)),
      ),
      el('p', {}, p.detail),
      el('div', { class: 'kv', style: { marginTop: '7px' } },
        el('div', { class: 'k' }, '得をする'), el('div', { class: 'v', style: { fontWeight: '400' } }, p.gain),
        el('div', { class: 'k' }, '損をする'), el('div', { class: 'v', style: { fontWeight: '400' } }, p.lose),
        el('div', { class: 'k' }, '動機'), el('div', { class: 'v', style: { fontWeight: '400' } }, p.motive),
      ),
      p.risk ? el('p', { class: 'hint', style: { color: '#e8b24a' } }, p.risk) : null,
      el('div', { style: { display: 'flex', gap: '7px', marginTop: '9px' } },
        el('button', {
          class: 'btn primary', style: { flex: 1 },
          onclick: () => { api.resolvePetition(world, p.id, true, rng); toast(`「${p.title}」を承認した`); ctx.refresh(); },
        }, '承認'),
        el('button', {
          class: 'btn danger', style: { flex: 1 },
          onclick: () => { api.resolvePetition(world, p.id, false, rng); toast(`「${p.title}」を却下した`, 'warn'); ctx.refresh(); },
        }, '却下'),
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
