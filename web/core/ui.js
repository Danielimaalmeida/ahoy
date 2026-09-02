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
 * A tinted block of prose. Four kinds and only four:
 *
 *   accent  something wants your decision
 *   warn    something is uncertain, or costs something
 *   bad     something failed, or is disputed
 *   halt    the filled red surface — reviewers split, and nothing else, ever
 *
 * The moment a second thing uses `halt`, the split stops being unmissable.
 */
export function callout(kind, ...body) {
  return el('div', { class: `callout c-${kind}` }, body);
}

export const calloutTitle = (text) => el('div', { class: 'callout-title', text });

/**
 * The revision ceiling as filled and empty pips, plus the count in words.
 *
 * Always drawn, from revision zero — learning about a limit at the moment it
 * bites is the worst possible time to learn it.
 */
export function pips(used, ceiling) {
  const marks = [];
  for (let i = 0; i < ceiling; i += 1) {
    marks.push(el('span', { class: ['pip', i < used && 'on'] }));
  }
  return el('span', { class: 'pips', title: `${used} of ${ceiling} revision rounds used` },
    el('span', { class: 'pip-row' }, marks),
    el('span', { class: 'mono', text: `${used} of ${ceiling} used` }));
}

/**
 * Terminal output, on the one dark surface in the product.
 *
 * It is a terminal. Dressing it as anything else makes the colours an agent
 * emits look like a rendering bug.
 */
export const terminalBlock = (text, props = {}) =>
  el('pre', { ...props, class: ['term', props.class], text });

/**
 * What a bin/ script said, verbatim. One shape, used everywhere something
 * failed: a sentence in plain English, then the command and its exit code,
 * then stderr on the dark surface, unabridged.
 *
 * The stderr is never paraphrased or silently truncated. If the sentence above
 * it is wrong, the raw text is still there to be believed instead.
 */
export function scriptResult(result) {
  const code = result.exit_code;
  const kind = code === 0 ? 'ok' : code === 1 ? 'warn' : 'bad';
  const heading = code === 0 ? 'Recorded.'
                : code === 1 ? 'The harness refused. Nothing was written.'
                : code === null ? 'The script did not finish.'
                : 'The harness could not run this.';

  const output = [result.stderr, result.stdout].filter((s) => s && s.trim()).join('\n');

  return el('div', { class: `result ${kind}`, role: 'status' },
    el('div', { class: 'result-head' },
      el('h2', { text: heading }),
      el('div', { class: 'cmd', text: `${result.command} → exit ${code ?? 'none'}` })),
    output && terminalBlock(output),
    output && el('div', { class: 'result-acts' }, copyButton(output, 'Copy output')),
    // bin/tick.sh is the router. Seeing it here means --no-continue was lost,
    // which in the real repository runs agents for minutes.
    /\[tick /.test(output)
      && note('That is bin/tick.sh — the server called the script without --no-continue.'),
  );
}

/**
 * Copy to the clipboard, saying so briefly.
 *
 * The label reverts on its own; nothing about the page depends on the result,
 * and a browser that refuses the clipboard says so in the label rather than
 * throwing into a poll.
 */
export function copyButton(text, label = 'Copy') {
  const button = el('button', {
    type: 'button', class: 'small', text: label,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Could not copy';
      }
      setTimeout(() => { button.textContent = label; }, 1600);
    },
  });
  return button;
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
