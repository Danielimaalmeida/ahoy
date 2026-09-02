/**
 * The decision. One text box and three verbs, at plan_review and
 * delivery_gate only.
 *
 * The box is what tells the three buttons apart. Text in it means SEND BACK:
 * a revision with no reason is how the agent ends up revising the plan on its
 * own judgement instead of yours, which is a real failure this design works
 * around - so "send back" stays disabled until you have said what should
 * change. An approval carries no reason at all (approve.sh only attaches one
 * to a rejection), so approving is offered only while the box is empty, rather
 * than silently discarding what you typed. That rule is unusual enough that it
 * is written out in a sentence above the box as well as shown in the buttons -
 * it should never have to be inferred from a grey fill.
 *
 * CONSEQUENCES BEFORE THE CLICK. As soon as the box has text, a panel appears
 * between the box and the buttons saying what sending back will actually do:
 * which recorded approval it clears, which phase it returns to, and whether
 * this is the last revision available. Not a confirm dialog - a dialog arrives
 * after the decision is made and gets dismissed by reflex. This is physically
 * in the path to the click, and it names the specific things affected rather
 * than saying "this cannot be undone", which people have learned to skip.
 *
 * THE CEILING IS ALWAYS VISIBLE, as pips, from revision zero. Learning about a
 * limit at the moment it bites is the worst time to learn it.
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
import { panel, badge, quote, note, scriptResult, pips } from '../core/ui.js';
import { phases } from '../core/phases.service.js';
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
  let consequence = null;

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

    const used = story.revisions_used || 0;
    const ceiling = story.revision_ceiling ?? 4;

    box = el('textarea', {
      rows: '3',
      placeholder: 'A reason. Leave this empty to approve; write in it to send the work back or reject it.',
      'aria-label': 'reason for sending back or rejecting',
      onInput: sync,
    });
    box.value = reason;

    buttons = {
      approve: el('button', { class: 'approve', type: 'button',
                              text: `Approve ${story.gate.short}`,
                              onClick: () => run('approve') }),
      revise: el('button', { class: 'sendback', type: 'button', text: 'Send back',
                             onClick: () => run('revise') }),
      reject: el('button', { class: 'reject', type: 'button', text: 'Reject',
                             onClick: () => run('reject') }),
    };

    hint = el('div', { class: 'fine' });
    outcome = el('div');
    consequence = el('div');

    render(host, el('div', { class: 'decision' },
      el('div', { class: 'label' },
        el('h2', { text: `Your decision on this ${story.gate.short}` }),
        pips(used, ceiling)),
      el('p', { class: 'decision-lede', text: lede() }),
      story.decision && recorded(story.decision, story.gate),
      box,
      consequence,
      el('div', { class: 'btns' }, Object.values(buttons)),
      hint,
      outcome,
    ));

    sync();
  }

  /** What approving would set in motion, in one sentence. */
  function lede() {
    const next = phases.row(story.state?.phase)?.on_pass;
    const repos = [...new Set((story.state?.work_packages || [])
      .map((pkg) => pkg.repo).filter(Boolean))];
    const where = repos.length ? ` across ${repos.join(' and ')}` : '';
    return next
      ? `Approving sends the story to ${words(next)}${where}. Leaving this page changes nothing.`
      : 'Leaving this page changes nothing.';
  }

  /** The only place button state, the consequence panel and the hint are decided. */
  function sync() {
    reason = box.value;

    const hasReason = reason.trim().length > 0;
    const decided = !!story.decision;
    const used = story.revisions_used || 0;
    const ceiling = story.revision_ceiling ?? 4;
    const atCeiling = used >= ceiling;
    const lastOne = used === ceiling - 1;

    box.disabled = busy;

    arm(buttons.approve, !busy && !hasReason && !decided,
      decided ? 'a decision is already recorded'
              : 'clear the box to approve — an approval records no reason');
    arm(buttons.revise, !busy && hasReason && !atCeiling,
      atCeiling ? `the revision ceiling of ${ceiling} is reached`
                : 'say what should change first');
    arm(buttons.reject, !busy && hasReason && !decided,
      decided ? 'a decision is already recorded' : 'say why first');

    // At the last available round the button says so. That is the one number
    // that changes what a person would choose.
    buttons.revise.textContent = lastOne && !atCeiling
      ? 'Send back — last revision' : 'Send back';

    render(consequence, hasReason && !busy && consequencePanel({ used, ceiling, atCeiling, lastOne }));

    hint.textContent = hintText({ hasReason, decided, atCeiling, used, ceiling });
  }

  /**
   * The three things sending back will do, in the order they happen, each
   * naming the specific thing it affects rather than the general shape of it.
   */
  function consequencePanel({ used, ceiling, atCeiling, lastOne }) {
    if (atCeiling) {
      return el('div', { class: 'consequence' },
        el('h2', { text: `All ${ceiling} revision rounds are used` }),
        el('ul', {},
          el('li', {}, el('span', {}, 'Send back is no longer available at this gate. '
            + 'The ways out are approving what you have, or fixing the ticket and '
            + 'starting the story again.')),
          el('li', {}, el('span', {}, 'Reject records this text as the reason and sends '
            + 'the story to blocked.'))));
    }

    const back = phases.producerOf(story.state?.phase);
    const actor = back ? phases.row(back)?.actor : null;
    const items = [];

    if (story.decision) {
      items.push(el('li', {}, el('span', {},
        `The ${words(story.decision.status || 'decision')} you recorded`,
        story.decision.timestamp ? ` at ${stamp(story.decision.timestamp)}` : '',
        ' is cleared. This gate becomes undecided again.')));
    }
    if (back) {
      items.push(el('li', {}, el('span', {},
        `The story returns to ${words(back)}`,
        actor && actor !== '-' ? ` and ${actor} works again` : '',
        ', with your text as its instruction.')));
    }
    items.push(el('li', {}, lastOne
      ? el('span', {}, el('strong', { text: 'This is the last revision.' }),
        ` After it, Send back is gone: the only ways out of this gate are approving `
        + `the work or starting the story over.`)
      : el('span', { text: `This is revision ${used + 1} of ${ceiling}.` })));

    const NUMBER = ['', 'one thing happens', 'two things happen', 'three things happen'];
    return el('div', { class: 'consequence' },
      el('h2', { text: `If you send this back, ${NUMBER[items.length] || 'this happens'}` }),
      el('ul', {}, items));
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
      return 'You have written a reason, so Send back and Reject are armed and Approve is not. '
           + 'Clear the box to approve instead.';
    }
    return 'Send back and Reject need a reason in the box. '
         + 'No decision is recorded until you press one.' + rounds;
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
