/**
 * The decision. One text box and three buttons, at plan_review and
 * delivery_gate only.
 *
 * The box is what tells the three buttons apart. Text in it means SEND BACK:
 * a revision with no reason is how the agent ends up revising the plan on its
 * own judgement instead of yours, which is a real failure this design works
 * around - so "send back" stays disabled until you have said what should
 * change. An approval carries no reason at all (approve.sh only attaches one
 * to a rejection), so approving is offered only while the box is empty, rather
 * than silently discarding what you typed.
 *
 * No default and no timeout. Nothing approves itself.
 *
 * This one really does hold state - the typed reason, an in-flight flag, and
 * live references to the three buttons - so it is a factory. The panel is
 * built once per story and typing only flips button states through sync();
 * rebuilding on every keystroke would throw away the caret and the field's own
 * undo history.
 */
import { el, render } from '../core/dom.js';
import { panel, badge, quote, note, scriptResult } from '../core/ui.js';
import { words, stamp } from '../core/format.js';

const RECORDED = { approved: 'b-ok', rejected: 'b-bad' };

export function createDecisionPanel({ onDecide }) {
  const host = el('div');

  let story = null;
  let storyId = null;
  let reason = '';
  let busy = false;

  // Live nodes, replaced by build() on each story.
  let box = null;
  let buttons = null;
  let hint = null;
  let outcome = null;

  function setStory(next) {
    if (next.dir !== storyId) {
      storyId = next.dir;
      reason = '';
    }
    story = next;
    build();
  }

  function build() {
    if (!story || !story.gate) {
      render(host);
      return;
    }

    box = el('textarea', {
      rows: '3',
      placeholder: 'What should change? Leave empty to approve as is.',
      'aria-label': 'reason for sending back or rejecting',
      onInput: sync,
    });
    box.value = reason;

    buttons = {
      approve: el('button', { class: 'primary', type: 'button',
                              text: `Approve ${story.gate.short}`,
                              onClick: () => run('approve') }),
      revise: el('button', { type: 'button', text: 'Send back',
                             onClick: () => run('revise') }),
      reject: el('button', { class: 'danger', type: 'button', text: 'Reject',
                             onClick: () => run('reject') }),
    };

    hint = el('div', { class: 'fine' });
    outcome = el('div');

    render(host, el('div', { class: 'decision' },
      el('div', { class: 'label' },
        el('span', { text: `Your decision · ${words(story.gate.phase)}` }),
        el('span', { class: 'mono muted', text: story.gate.key })),
      story.decision && recorded(story.decision, story.gate),
      box,
      el('div', { class: 'btns' }, Object.values(buttons)),
      hint,
      outcome,
    ));

    sync();
  }

  /** The only place button state and the hint line are decided. */
  function sync() {
    reason = box.value;

    const hasReason = reason.trim().length > 0;
    const decided = !!story.decision;
    const used = story.revisions_used || 0;
    const ceiling = story.revision_ceiling ?? 4;
    const atCeiling = used >= ceiling;

    box.disabled = busy;

    arm(buttons.approve, !busy && !hasReason && !decided,
      decided ? 'a decision is already recorded'
              : 'clear the box to approve — an approval records no reason');
    arm(buttons.revise, !busy && hasReason && !atCeiling,
      atCeiling ? `the revision ceiling of ${ceiling} is reached`
                : 'say what should change first');
    arm(buttons.reject, !busy && !decided, 'a decision is already recorded');

    hint.textContent = hintText({ hasReason, decided, atCeiling, used, ceiling });
  }

  function hintText({ hasReason, decided, atCeiling, used, ceiling }) {
    const rounds = used ? ` Revision ${used} of ${ceiling} used.`
                        : ` Up to ${ceiling} revision rounds.`;

    if (busy) return 'Running the script…';
    if (decided) {
      return 'A decision is recorded. approve.sh will not overwrite it — sending the story '
           + 'back clears it, because the artifact is about to change.' + rounds;
    }
    if (atCeiling && hasReason) {
      return `This gate has used all ${ceiling} revision rounds. `
           + 'Approve what you have, or fix the ticket and start a new story.';
    }
    if (hasReason) {
      return 'Text in the box means send back. Reject also records it as the reason.' + rounds;
    }
    return 'No decision is recorded until you press one.' + rounds;
  }

  /** Enable a button, or disable it and say why on hover. */
  function arm(button, enabled, why) {
    button.disabled = !enabled;
    if (enabled) button.removeAttribute('title');
    else button.setAttribute('title', why);
  }

  function recorded(decision, gate) {
    return panel({
      title: `${gate.key} is already recorded`,
      aside: badge(RECORDED[decision.status] || 'b-warn', words(decision.status || 'unknown')),
    },
      decision.timestamp && el('div', { class: 'sub', text: stamp(decision.timestamp) }),
      decision.reason && quote(decision.reason),
      decision.status === 'malformed'
        && note('That slot does not hold {status, timestamp}. Something wrote it by hand, '
              + 'which is exactly what approve.sh exists to prevent.'));
  }

  async function run(action) {
    busy = true;
    render(outcome);
    sync();

    let result;
    try {
      result = await onDecide(action, reason.trim(), story.gate.key);
      // A recorded decision is spent; the box should not still be armed.
      if (result && result.ok) box.value = '';
    } catch (error) {
      result = { exit_code: null, stderr: error.message, command: `bin/${action}.sh`, ok: false };
    }

    busy = false;
    // onDecide re-reads the story, so setStory() has already rebuilt this panel
    // by now. `outcome` points at whichever slot is currently mounted.
    render(outcome, scriptResult(result));
    sync();
  }

  return { host, setStory };
}
