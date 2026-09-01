/**
 * The presentational vocabulary: panels, badges, chips and tables.
 *
 * el() from dom.js is the primitive, and building a four-column table out of
 * it directly costs fifteen lines of nesting that nobody can scan. Everything
 * this app draws repeatedly gets a name here instead, so a component says what
 * it wants rather than how to assemble it.
 */
import { el } from './dom.js';

export const badge = (cls, text, props = {}) =>
  el('span', { ...props, class: `badge ${cls}`, text });

export const chip = (text, props = {}) => el('span', { ...props, class: 'chip', text });

export const mono = (text, props = {}) => el('span', { ...props, class: 'mono', text });

export const muted = (text, props = {}) => el('span', { ...props, class: 'muted', text });

export const empty = (text) => el('div', { class: 'empty', text });

export const note = (text) => el('div', { class: 'note', text });

export const quote = (text) => el('div', { class: 'quote', text: `“${text}”` });

/**
 * What a bin/ script said, verbatim.
 *
 * A refusal is exit 1 and it explains itself on stderr; that explanation is the
 * useful part, so it is shown in full and coloured as information rather than
 * as breakage. Shared by every panel that runs a script, so the ceiling notice
 * you get from revise.sh reads the same wherever you triggered it from.
 */
export function scriptResult(result) {
  const code = result.exit_code;
  const kind = code === 0 ? 'ok' : code === 1 ? 'warn' : 'bad';
  const heading = code === 0 ? 'Recorded.'
                : code === 1 ? 'Refused — nothing was written.'
                : code === null ? 'The script did not finish.'
                : 'Could not run.';

  const output = [result.stderr, result.stdout].filter((s) => s && s.trim()).join('\n');

  return el('div', { class: `result ${kind}`, role: 'status' },
    el('h2', { text: heading }),
    el('div', { class: 'cmd', text: `$ ${result.command}   → exit ${code ?? 'none'}` }),
    output && el('pre', { text: output }),
    // bin/tick.sh is the router. Seeing it here means --no-continue was lost,
    // which in the real repository runs agents for minutes.
    /\[tick /.test(output)
      && note('That is bin/tick.sh — the server called the script without --no-continue.'),
  );
}

/**
 * A titled section.
 *
 *   panel({ title: 'Gate results', aside: badge('b-ok', 'pass') }, table, note)
 */
export function panel({ title, aside, flat = false } = {}, ...body) {
  return el('div', { class: ['panel', flat && 'flat'] },
    (title || aside) && el('div', { class: 'label' },
      title ? el('span', { text: title }) : el('span'),
      aside || null),
    body);
}

/**
 * A table described rather than constructed.
 *
 *   dataTable({
 *     columns: ['gate', 'result', 'when'],
 *     rows: gateResults,
 *     cells: (entry) => [mono(entry.gate), badge(...), muted(stamp(entry.timestamp))],
 *     empty: 'Nothing has run.',
 *   })
 *
 * `columns` takes strings or nodes. `cells` returns one entry per column;
 * each may be a node, a string, or an array of either. `rowClass` is optional
 * and receives the row, for highlighting.
 */
export function dataTable({ columns, rows, cells, empty: emptyText, rowClass }) {
  if (!rows.length) return empty(emptyText || 'Nothing here.');

  return el('table', {},
    el('thead', {}, el('tr', {}, columns.map((column) => el('th', {}, column)))),
    el('tbody', {}, rows.map((row, index) =>
      el('tr', { class: rowClass ? rowClass(row, index) : null },
        cells(row, index).map((content) => el('td', {}, content))))),
  );
}
