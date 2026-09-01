/**
 * Rework a delivered story.
 *
 * `done` is terminal, but "I tested it and found a bug" is the most ordinary
 * thing that happens to a delivery. revise.sh has always accepted that case —
 * it calls it reopening — yet there was no way to reach it from here: the
 * decision panel draws nothing once a story leaves its gate, so the only route
 * back into an accepted story was a hand-edited state.json, which is precisely
 * what the gate scripts exist to prevent.
 *
 * This runs the same script the decision panel's "Send back" runs, at the same
 * gate key, through the same endpoint. It is a second door onto one verb, not a
 * second way to move a story.
 *
 * WHY IT IS TWO STEPS. The button reveals the box rather than sending
 * anything, because what is being reopened has a pull request behind it and may
 * be merged. Reopening is a bigger step than revising a plan under review, so
 * revise.sh names it rather than implying it — and a control that only arms
 * itself once you have said what is wrong keeps that shape in the UI.
 *
 * WHY THE REASON IS REQUIRED. For a stronger version of the reason "send back"
 * demands one. The reason is written to state.json and is the only thing the
 * phase this returns to is told about the bug you found; reopening without one
 * asks the agents to rediscover it. The button stays disabled until the box has
 * something in it.
 *
 * Holds the typed reason, an in-flight flag and whether the box is open, so it
 * is a factory for the same reason the decision panel is: rebuilding on every
 * keystroke would throw away the caret.
 */
import { el, render } from '../core/dom.js';
import { note, scriptResult } from '../core/ui.js';
import { words } from '../core/format.js';

export function createReworkPanel({ onRework }) {
  const host = el('div');

  let story = null;
  let storyId = null;
  let reason = '';
  let busy = false;
  let open = false;

  // Live nodes, replaced by build() on each story.
  let box = null;
  let submit = null;
  let hint = null;
  let outcome = null;

  function setStory(next) {
    if (next.dir !== storyId) {
      storyId = next.dir;
      reason = '';
      open = false;
    }
    story = next;
    build();
  }

  function build() {
    // `gate` and `reopen` are mutually exclusive server-side, but the guard is
    // explicit: a story at a live gate is sent back with the decision panel's
    // three buttons, and two panels offering the same verb would be a bug.
    if (!story || !story.reopen || story.gate) {
      box = null;
      submit = null;
      render(host);
      return;
    }

    hint = el('div', { class: 'fine' });
    outcome = el('div');

    render(host, el('div', { class: 'decision' },
      el('div', { class: 'label' },
        el('span', { text: `Rework · ${words(story.reopen.short)}` }),
        el('span', { class: 'mono muted', text: story.reopen.key })),
      open ? form() : opener(),
      hint,
      outcome,
    ));

    sync();
  }

  /** Step one: the story is finished, and this is the only thing on offer. */
  function opener() {
    box = null;
    submit = null;
    return el('div', { class: 'btns' },
      el('button', { type: 'button', text: 'Rework', disabled: busy,
                     onClick: () => { open = true; build(); box.focus(); } }));
  }

  /** Step two: say what is wrong, then send it back. */
  function form() {
    box = el('textarea', {
      rows: '3',
      placeholder: 'What did you find? This is what the story is sent back with.',
      'aria-label': 'what should be reworked',
      onInput: sync,
    });
    box.value = reason;

    submit = el('button', { class: 'primary', type: 'button',
                            text: 'Send back for rework', onClick: run });

    return [
      box,
      el('div', { class: 'btns' },
        submit,
        el('button', { type: 'button', text: 'Cancel', disabled: busy,
                       onClick: () => { open = false; reason = ''; build(); } })),
    ];
  }

  /** The only place button state and the hint line are decided. */
  function sync() {
    if (box) {
      reason = box.value;
      box.disabled = busy;
    }

    const hasReason = reason.trim().length > 0;
    const used = story.revisions_used || 0;
    const ceiling = story.revision_ceiling ?? 4;
    const atCeiling = used >= ceiling;

    if (submit) {
      const enabled = !busy && hasReason && !atCeiling;
      submit.disabled = !enabled;
      if (enabled) submit.removeAttribute('title');
      else submit.setAttribute('title',
        atCeiling ? `the revision ceiling of ${ceiling} is reached`
                  : 'say what should be reworked first');
    }

    hint.textContent = hintText({ hasReason, atCeiling, used, ceiling });
  }

  function hintText({ hasReason, atCeiling, used, ceiling }) {
    const rounds = used ? ` Revision ${used} of ${ceiling} used.`
                        : ` Up to ${ceiling} revision rounds.`;

    if (busy) return 'Running the script…';
    if (atCeiling) {
      return `This gate has used all ${ceiling} revision rounds. `
           + 'Fix the ticket and start a new story.';
    }
    if (!open) {
      return `This story is accepted and finished. Reworking it clears that acceptance `
           + `and sends the work back to be redone.${rounds}`;
    }
    if (hasReason) {
      return 'The recorded acceptance is cleared — the work is about to change, so a '
           + 'decision made about the old version cannot stand.' + rounds;
    }
    return 'Nothing is sent until you say what should change.' + rounds;
  }

  async function run() {
    busy = true;
    render(outcome);
    sync();

    let result;
    try {
      result = await onRework(reason.trim(), story.reopen.key);
    } catch (error) {
      result = { exit_code: null, stderr: error.message, command: 'bin/revise.sh', ok: false };
    }

    busy = false;
    // A story that reopened is no longer at a terminal phase, so onRework's
    // reload has already emptied this panel; build() below then renders nothing
    // and `outcome` is detached. Mount the report on the host instead, so what
    // the script said survives the panel that asked for it.
    const detached = !story || !story.reopen || story.gate;
    if (result && result.ok) {
      open = false;
      reason = '';
    }
    build();
    render(detached ? host : outcome, scriptResult(result),
      detached && result && result.ok
        && note('The story is back in the pipeline; the conversation above is the router '
              + 'picking it up.'));
    if (!detached) sync();
  }

  return { host, setStory };
}
