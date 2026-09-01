/**
 * Start a story.
 *
 * Everything else in this app acts on a story that already exists — the list
 * shows what is under specs/, and every panel to the right of it decides
 * something about one. Getting a story into that list at all meant leaving the
 * page for a terminal, which made the first step of the workflow the only step
 * the UI could not do.
 *
 * WHY run.sh AND NOT start.sh. run.sh is the harness's documented entry point,
 * and it already answers the question this panel would otherwise have to: a key
 * with no state file is created, a key with one is resumed. Calling start.sh
 * directly would mean deciding here which of the two a typed key deserves, and
 * getting that wrong means either refusing to resume or refusing to create.
 * One box, one verb, and run.sh works out which case it is.
 *
 * WHY THE KEY IS CHECKED HERE TOO. The regex below is start.sh's, copied. That
 * duplication is deliberate and it is the only kind that is safe: it decides
 * whether a BUTTON is enabled, never whether a story is created. start.sh
 * remains the authority, and if the two ever disagree the script wins — the
 * worst this can do is make you press a button that then explains itself.
 *
 * WHY THE ROUTER IS NOT STARTED HERE. run.sh ends by exec'ing the router, and
 * the server passes --no-continue so the request returns while a refusal is
 * still legible. Starting the router is main.js's job, on the streamed terminal
 * the chat panel already knows how to attach to.
 *
 * Holds the typed key, an in-flight flag and whether the box is open, so it is
 * a factory for the same reason the decision panel is: rebuilding on every
 * keystroke would throw away the caret.
 */
import { el, render } from '../core/dom.js';
import { note, scriptResult } from '../core/ui.js';

// bin/start.sh's rule, verbatim. See the note above on why this is copied.
const KEY_RE = /^[A-Z][A-Z0-9]+-[0-9]+$/;

export function createNewStoryPanel({ onStart }) {
  const host = el('div', { class: 'card newstory' });

  let key = '';
  let busy = false;
  let open = false;

  // Live nodes, replaced by build().
  let box = null;
  let submit = null;
  let hint = null;
  let outcome = null;

  function build() {
    hint = el('div', { class: 'fine' });
    outcome = el('div');

    render(host, el('div', { class: 'newstory-body' },
      open ? form() : opener(),
      open && hint,
      outcome,
    ));

    if (open) sync();
  }

  /** Step one: out of the way until wanted. */
  function opener() {
    box = null;
    submit = null;
    return el('button', {
      class: 'newstory-open', type: 'button', text: '+ New story', disabled: busy,
      onClick: () => { open = true; build(); box.focus(); },
    });
  }

  /** Step two: name the ticket. */
  function form() {
    box = el('input', {
      type: 'text',
      placeholder: 'R3DA-14022',
      'aria-label': 'Jira issue key',
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: normalise,
      onKeyDown: (event) => {
        if (event.key === 'Enter' && submit && !submit.disabled) run();
        else if (event.key === 'Escape') cancel();
      },
    });
    box.value = key;

    submit = el('button', { class: 'primary', type: 'button', text: 'Start', onClick: run });

    return [
      box,
      el('div', { class: 'btns' },
        submit,
        el('button', { type: 'button', text: 'Cancel', disabled: busy, onClick: cancel })),
    ];
  }

  function cancel() {
    open = false;
    key = '';
    build();
  }

  /**
   * Jira keys are upper case and start.sh refuses anything else, so typing one
   * in lower case should not be a refusal — it should just work. The caret is
   * put back because assigning to value moves it to the end, which would make
   * correcting a typo mid-key impossible.
   */
  function normalise() {
    const upper = box.value.toUpperCase();
    if (upper !== box.value) {
      const at = box.selectionStart;
      box.value = upper;
      box.setSelectionRange(at, at);
    }
    sync();
  }

  /** The only place button state and the hint line are decided. */
  function sync() {
    if (box) {
      key = box.value;
      box.disabled = busy;
    }

    const typed = key.trim();
    const valid = KEY_RE.test(typed);

    if (submit) {
      const enabled = !busy && valid;
      submit.disabled = !enabled;
      if (enabled) submit.removeAttribute('title');
      else submit.setAttribute('title',
        busy ? 'starting…' : 'enter a Jira issue key, like R3DA-14022');
    }

    hint.textContent = hintText({ typed, valid });
  }

  function hintText({ typed, valid }) {
    if (busy) return 'Running bin/run.sh…';
    if (!typed) {
      return 'The key of a ticket that already exists. This creates the story here, '
           + 'never in Jira.';
    }
    if (!valid) return `‘${typed}’ is not a Jira issue key — expected something like R3DA-14022.`;
    return 'Creates the story and hands it to the router, which plans it with you and '
         + 'stops at plan review.';
  }

  async function run() {
    busy = true;
    render(outcome);
    sync();

    let result;
    try {
      result = await onStart(key.trim());
    } catch (error) {
      result = { exit_code: null, stderr: error.message, command: 'bin/run.sh', ok: false };
    }

    busy = false;
    // On success the box is cleared and closed: the story now exists, and what
    // happens next is on the right, not in this corner of the sidebar.
    if (result && result.ok) {
      key = '';
      open = false;
    }
    build();

    render(outcome,
      scriptResult(result),
      result && result.ok && note(result.existed
        ? 'That story already existed — the router is picking it up from where it stopped.'
        : 'Created at phase ‘intake’. The router is planning it now.'));

    if (open) sync();
  }

  build();
  return { host };
}
