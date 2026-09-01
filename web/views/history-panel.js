/**
 * Gate results and the decision log.
 *
 * `recorded_by` gets a column of its own because a gate writes its own result:
 * an entry means the script actually ran, and a phase with no entry means it
 * did not. That is a fact you can read off the file rather than asking an agent
 * and hoping for an honest answer, so it is worth the width.
 */
import { panel, dataTable, badge, mono, muted } from '../core/ui.js';
import { words, list, stamp, statusClass } from '../core/format.js';

/** Approvals read green, rejections and blocks read red, the rest are neutral. */
function logClass(type) {
  if (type === 'human_approval') return 'b-ok';
  if (type === 'human_rejection' || type === 'blocked') return 'b-bad';
  return 'b-mute';
}

export function historyPanel(state) {
  return [gateResults(state), decisionLog(state)];
}

function gateResults(state) {
  return panel({ title: 'Gate results' }, dataTable({
    columns: ['gate', 'result', 'recorded by', 'when'],
    rows: list(state.gate_results),
    cells: (entry) => [
      mono(entry.gate || '—'),
      badge(statusClass(entry.result), entry.result || 'unknown'),
      muted(entry.recorded_by || '—'),
      muted(stamp(entry.timestamp)),
    ],
    empty: 'No gate has recorded a result. Nothing has run.',
  }));
}

function decisionLog(state) {
  return panel({ title: 'Decision log' }, dataTable({
    columns: ['when', 'actor', 'type', 'summary'],
    rows: list(state.decision_log),
    cells: (entry) => [
      muted(stamp(entry.timestamp)),
      entry.actor || '—',
      badge(logClass(entry.type), words(entry.type || 'note')),
      entry.summary || '',
    ],
    empty: 'Nothing decided yet.',
  }));
}
