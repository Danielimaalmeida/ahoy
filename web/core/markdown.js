/**
 * Markdown to DOM, for the plan and the ticket.
 *
 * The rule this renderer is built around comes from the panel it feeds: at
 * plan_review the question is whether the plan says what you think it says,
 * so a renderer that quietly swallows a malformed heading or a stray list
 * marker is answering that question for you. Every branch here therefore ends
 * in "emit the source text verbatim" rather than in dropping something. An
 * unterminated fence, a table without a delimiter row and a `<div>` typed into
 * a paragraph all survive to the screen as the characters the author wrote.
 * Rendering is a reading aid layered over the file; the file is still one
 * click away in the Source view, which is what makes that aid safe to trust.
 *
 * Output is nodes built with el(), never markup. Plans are agent-written, so
 * this module is a parser boundary as much as a formatter: it is the thing
 * standing between generated text and the DOM, and it never grows an innerHTML.
 *
 * `_underscore_` is deliberately not italic. These documents are full of
 * snake_case identifiers - `human_gates.delivery_accepted`, `plan_review`,
 * `state_json` - and treating underscores as emphasis silently eats the middle
 * of them, which is exactly the failure mode above. `*asterisks*` only.
 */
import { el } from './dom.js';

/** Render markdown source into an array of block nodes. */
export function markdown(source) {
  return blocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

/* ----------------------------------------------------------------- blocks */

function blocks(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Fenced code. An unclosed fence runs to the end of the file rather than
    // being abandoned, so the tail of a truncated document is still readable.
    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      const [, marker, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence, or past the end when there wasn't one
      out.push(el('pre', { class: 'md-code', dataset: lang ? { lang } : {} },
        el('code', { text: body.join('\n') })));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      out.push(el(`h${Math.min(depth + 1, 6)}`, { class: 'md-h', dataset: { level: String(depth) } },
        inline(heading[2].replace(/\s+#+\s*$/, ''))));
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push(el('hr', { class: 'md-hr' }));
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (quoted.length && lines[i].trim()))) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(el('blockquote', { class: 'md-quote' }, blocks(quoted)));
      continue;
    }

    // A table needs its delimiter row. Without one this is just a paragraph
    // that happens to contain pipes, and pretending otherwise would invent
    // structure the author did not write.
    if (line.trim().startsWith('|') && isDelimiter(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++; }
      out.push(table(rows));
      continue;
    }

    if (listItem(line)) {
      const items = [];
      while (i < lines.length && (listItem(lines[i]) || (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])))) {
        items.push(lines[i]);
        i++;
      }
      out.push(list(items));
      continue;
    }

    const text = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { text.push(lines[i].trim()); i++; }
    out.push(el('p', { class: 'md-p' }, inline(text.join(' '))));
  }

  return out;
}

/** Does this line begin a block that must interrupt an open paragraph? */
function startsBlock(line) {
  return /^\s*(`{3,}|~{3,})/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^\s*>/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || Boolean(listItem(line));
}

function isDelimiter(line) {
  return Boolean(line) && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

/* ------------------------------------------------------------------ lists */

function listItem(line) {
  const m = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line || '');
  if (!m) return null;
  return { indent: m[1].length, ordered: Boolean(m[3]), start: m[3], text: m[4] };
}

/**
 * Build a list, nesting by indentation.
 *
 * Indent is compared against the enclosing item rather than snapped to a fixed
 * step, so a document that indents with three spaces nests the same as one
 * that indents with two instead of collapsing flat.
 */
function list(lines) {
  const items = [];
  for (const line of lines) {
    const item = listItem(line);
    if (item) items.push({ ...item, lines: [item.text] });
    else if (items.length) items[items.length - 1].lines.push(line.trim());
  }

  const build = (from, indent) => {
    const ordered = items[from].ordered;
    const node = el(ordered ? 'ol' : 'ul', {
      class: 'md-list',
      start: ordered && items[from].start !== '1' ? items[from].start : null,
    });

    let i = from;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {                 // deeper: recurse, attach to the last item
        const [child, next] = build(i, items[i].indent);
        (node.lastChild || node).appendChild(child);
        i = next;
        continue;
      }
      if (items[i].ordered !== ordered) break;        // a different marker starts a different list
      node.appendChild(el('li', { class: 'md-item' }, inline(items[i].lines.join(' '))));
      i++;
    }
    return [node, i];
  };

  const [node] = build(0, items[0].indent);
  return node;
}

/* ----------------------------------------------------------------- tables */

function table(rows) {
  const cells = (row) => {
    const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  };

  const head = cells(rows[0]);
  const align = isDelimiter(rows[1])
    ? cells(rows[1]).map((spec) => (/^:-+:$/.test(spec) ? 'center' : /-+:$/.test(spec) ? 'right' : null))
    : [];

  // Ragged rows are padded, never truncated: a row with an extra cell is a
  // mistake worth seeing, not one worth hiding.
  const width = Math.max(head.length, ...rows.slice(2).map((row) => cells(row).length));
  const pad = (row) => Array.from({ length: width }, (_, n) => row[n] ?? '');

  return el('div', { class: 'md-table-wrap' },
    el('table', { class: 'md-table' },
      el('thead', {}, el('tr', {}, pad(head).map((cell, n) =>
        el('th', { style: align[n] ? `text-align:${align[n]}` : null }, inline(cell))))),
      el('tbody', {}, rows.slice(2).map((row) =>
        el('tr', {}, pad(cells(row)).map((cell, n) =>
          el('td', { style: align[n] ? `text-align:${align[n]}` : null }, inline(cell)))))),
    ));
}

/* ----------------------------------------------------------------- inline */

// Escapes first so a backslashed marker never opens a span, then code, so the
// backticks in `**not bold**` win as they do in markdown.
const INLINE = /\\([\\`*_[\]()#+\-.!>|~])|(`+)([\s\S]*?)\2|\*\*(\S[\s\S]*?\S|\S)\*\*|\*(\S[^*\n]*?\S|\S)\*|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

/** Render inline markup to an array of nodes and strings. */
function inline(source) {
  const out = [];
  let rest = String(source ?? '');

  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) break;

    if (match.index) out.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);

    const [whole, escaped, , code, bold, italic, label, href] = match;
    if (escaped !== undefined) out.push(escaped);
    else if (code !== undefined) out.push(el('code', { class: 'md-inline-code', text: code.trim() }));
    else if (bold !== undefined) out.push(el('strong', {}, inline(bold)));
    else if (italic !== undefined) out.push(el('em', {}, inline(italic)));
    else out.push(link(label, href, whole));
  }

  if (rest) out.push(rest);
  return out;
}

/**
 * A link, if the target is one we are willing to make clickable.
 *
 * Hrefs come out of generated text, so anything that isn't plainly http(s),
 * mailto or a relative path is not made live. Such a link renders as its own
 * source text, brackets and all: the reader sees precisely what was written,
 * including the target that was refused, rather than a label that quietly
 * lost its destination.
 */
function link(label, href, source) {
  const safe = /^(https?:\/\/|mailto:|[./#?])/i.test(href);
  if (!safe) return el('span', { class: 'md-link-blocked', title: `unsupported link target: ${href}` }, source);
  return el('a', { class: 'md-link', href, target: '_blank', rel: 'noopener noreferrer' }, inline(label));
}
