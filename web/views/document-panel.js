/**
 * The plan and the ticket.
 *
 * These were previously shown as plain text, on the argument that at
 * plan_review the question is whether the plan says what you think it says,
 * and a renderer that quietly swallows a malformed heading or a stray list
 * marker is answering that question for you. That argument is right about the
 * risk and wrong about the remedy: these documents are mostly tables - a
 * hundred and sixty rows of them across the corpus - and a pipe-delimited
 * table read as raw text is its own kind of unreadable. Refusing to render was
 * trading one comprehension failure for another.
 *
 * So both are offered, Rendered first and Source one click away, and the
 * renderer in core/markdown.js is written to never drop input: anything it
 * cannot parse comes through as the characters the author typed. The toggle is
 * what makes that trustworthy. If a heading looks wrong, the file itself is
 * right there to check it against, and the check costs one click instead of a
 * trip to the filesystem.
 */
import { el, render } from '../core/dom.js';
import { markdown } from '../core/markdown.js';

export function documentPanel(story) {
  return [
    document_('plan', 'Implementation plan', story.plan),
    document_('ticket', 'Ticket source', story.ticket),
  ];
}

/**
 * What the reader has done to these documents, as plain data.
 *
 * The detail view is rebuilt whenever the story changes on disk, which now
 * happens *while* the router is running - the plan arrives mid-session. A
 * rebuild that collapsed the document, flipped it back to Rendered and threw
 * away the scroll position would punish you for reading it at the moment it
 * became worth reading. So the state travels across the rebuild.
 *
 * Read from the live DOM rather than tracked in a variable: the panel is a
 * plain function, not a factory, and the DOM is already the only record of
 * which `details` you opened.
 */
export function documentState(root) {
  const state = {};
  for (const node of root.querySelectorAll('details[data-doc]')) {
    const on = node.querySelector('.doc-view.is-on');
    const body = node.querySelector('.doc-body');
    state[node.dataset.doc] = {
      open: node.open,
      view: on ? on.dataset.view : 'rendered',
      scroll: body && body.firstChild ? body.firstChild.scrollTop : 0,
    };
  }
  return state;
}

/**
 * Put it back, after the new nodes are mounted.
 *
 * Scroll has to be applied post-mount: a detached element has no layout, so
 * assigning scrollTop to it silently does nothing.
 */
export function applyDocumentState(root, state) {
  if (!state) return;
  for (const node of root.querySelectorAll('details[data-doc]')) {
    const saved = state[node.dataset.doc];
    if (!saved) continue;

    node.open = saved.open;
    if (saved.view === 'source') {
      const button = node.querySelector('.doc-view[data-view="source"]');
      if (button) button.click();
    }
    const body = node.querySelector('.doc-body');
    if (body && body.firstChild && saved.scroll) body.firstChild.scrollTop = saved.scroll;
  }
}

function document_(name, label, doc) {
  if (!doc) return null;

  if (!doc.text) {
    return el('details', { dataset: { doc: name } },
      el('summary', { text: `${label} — ${missing(doc)}` }),
      el('div', { class: 'doc muted', text: 'Nothing to show.' }),
    );
  }

  const body = el('div', { class: 'doc-body' });
  const rendered = el('button', { class: 'doc-view is-on', type: 'button',
                                  dataset: { view: 'rendered' }, text: 'Reading' });
  const source = el('button', { class: 'doc-view', type: 'button',
                                dataset: { view: 'source' }, text: 'Source' });

  const show = (view) => {
    const on = view === 'rendered';
    rendered.classList.toggle('is-on', on);
    source.classList.toggle('is-on', !on);
    rendered.setAttribute('aria-pressed', String(on));
    source.setAttribute('aria-pressed', String(!on));
    render(body, on
      ? el('div', { class: 'md' }, markdown(doc.text))
      : el('div', { class: 'doc' }, doc.text));
  };

  rendered.addEventListener('click', () => show('rendered'));
  source.addEventListener('click', () => show('source'));
  show('rendered');

  return el('details', { dataset: { doc: name } },
    el('summary', { text: `${label} — ${doc.path}` }),
    el('div', { class: 'doc-views' }, rendered, source),
    body,
  );
}

function missing(doc) {
  if (doc.error === 'not found') return `no file at ${doc.path || 'the recorded path'}`;
  return doc.error || 'unavailable';
}
