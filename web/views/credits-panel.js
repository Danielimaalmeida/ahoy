/**
 * What the story cost.
 *
 * The number comes from `bin/credits.sh`, which reads the Copilot CLI's own
 * usage ledger and writes the result into state.json. This view does no
 * arithmetic beyond grouping: if the figure here disagreed with the recorded
 * one, there would be two answers to a question that must have exactly one.
 *
 * Grouped by phase rather than listed by session, because a story can hold
 * dozens of sessions - one per work package, per lookout, per resumed round -
 * and "which part of delivery spent this" is the question the number is
 * actually asked in aid of. The session ids are kept in state.json for anyone
 * who needs to go further.
 *
 * Absent when nothing has been recorded. A story that has not run yet has no
 * cost, and an empty panel claiming 0 AIU would read as a measurement rather
 * than the absence of one.
 */
import { el } from '../core/dom.js';
import { words, list } from '../core/format.js';

export function creditsPanel(state) {
  const credits = state.credits;
  const sessions = credits && credits.sessions ? Object.entries(credits.sessions) : [];
  if (!sessions.length) return null;

  const byPhase = new Map();
  for (const [, entry] of sessions) {
    const key = entry.phase || 'unattributed';
    const row = byPhase.get(key) || { aiu: 0, runs: 0, models: new Set() };
    row.aiu += Number(entry.aiu) || 0;
    row.runs += 1;
    if (entry.model) row.models.add(entry.model);
    byPhase.set(key, row);
  }

  const rows = [...byPhase.entries()].sort((a, b) => b[1].aiu - a[1].aiu);
  const total = Number(credits.total_aiu) || 0;

  return el('details', { class: 'doc', 'data-doc': 'credits' },
    el('summary', { text: `Credits — ${aiu(total)} AIU across ${sessions.length} agent run${sessions.length === 1 ? '' : 's'}` }),
    el('table', { class: 'credits' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Phase' }),
        el('th', { text: 'Runs' }),
        el('th', { text: 'AIU' }),
        el('th', { text: 'Share' }))),
      el('tbody', {}, ...rows.map(([phase, row]) => el('tr', {},
        el('td', { text: words(phase) }),
        el('td', { class: 'num', text: String(row.runs) }),
        el('td', { class: 'num', text: aiu(row.aiu) }),
        el('td', {}, bar(total ? row.aiu / total : 0))))),
      el('tfoot', {}, el('tr', {},
        el('td', { text: 'Total' }),
        el('td', { class: 'num', text: String(sessions.length) }),
        el('td', { class: 'num', text: aiu(total) }),
        el('td', {})))),
    tokens(credits),
  );
}

/** One decimal is the resolution the underlying figure deserves. */
function aiu(value) {
  return (Math.round((Number(value) || 0) * 10) / 10).toLocaleString();
}

function tokens(credits) {
  const input = Number(credits.total_input_tokens) || 0;
  const output = Number(credits.total_output_tokens) || 0;
  if (!input && !output) return null;
  return el('div', { class: 'sub',
    text: `${input.toLocaleString()} tokens in · ${output.toLocaleString()} out`
        + (credits.updated ? ` · last recorded ${credits.updated}` : '') });
}

/** A share is easier to read as a length than as another number in a column. */
function bar(fraction) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return el('span', { class: 'cbar', title: `${pct.toFixed(1)}%` },
    el('span', { class: 'cbar-fill', style: `width:${pct.toFixed(1)}%` }));
}
