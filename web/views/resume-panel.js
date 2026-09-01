/**
 * Pick a stalled story back up.
 *
 * A story between gates has nothing to decide, so the decision panel draws
 * nothing; it is not finished, so the rework panel draws nothing either. If the
 * router that was carrying it has stopped - the terminal was closed, the
 * machine slept, tick.sh exited on an error - the story sits mid-phase with
 * every control on the page hidden and no way forward but the command line.
 * That is the state this exists for.
 *
 * It is not a new verb. bin/run.sh has always had a resume branch: given a
 * story that exists, it reports the phase and continues the router. The UI
 * could already reach it, but only by typing the key into the box labelled
 * "new story", which is not a discoverable way to say "carry on with this one".
 *
 * WHEN IT SHOWS. Only when nothing else can move the story: no live router, not
 * terminal, and either no gate or a gate that has already been decided. That
 * last case matters - an approval that was recorded while the router was not
 * running leaves the story approved and stationary, with the decision panel
 * correctly refusing to approve it twice.
 *
 * Holds an in-flight flag and the script's output, so it is a factory like its
 * neighbours.
 */
import { el, render } from '../core/dom.js';
import { scriptResult } from '../core/ui.js';
import { phases } from '../core/phases.service.js';
import { words } from '../core/format.js';

export function createResumePanel({ onResume }) {
  const host = el('div');

  let story = null;
  let storyId = null;
  let busy = false;
  let outcome = null;
  let button = null;

  function setStory(next) {
    if (next.dir !== storyId) {
      storyId = next.dir;
      busy = false;
    }
    story = next;
    build();
  }

  function build() {
    if (!stalled()) {
      button = null;
      render(host);
      return;
    }

    const phase = story.state?.phase;
    outcome = el('div');
    button = el('button', { class: 'primary', type: 'button',
                            text: 'Continue', disabled: busy, onClick: run });

    render(host, el('div', { class: 'decision' },
      el('div', { class: 'label' },
        el('span', { text: 'Stalled' }),
        el('span', { class: 'mono muted', text: words(phase || 'unknown') })),
      el('div', { class: 'fine', text: busy
        ? 'Starting the router…'
        : `Nothing is running. Continue picks ${story.dir} up at ${words(phase)} and carries on.` }),
      el('div', { class: 'btns' }, button),
      outcome,
    ));
  }

  /**
   * Is this story stopped with no other way to move it?
   *
   * A gate with no decision is deliberately excluded: that story is not
   * stalled, it is waiting on you, and the decision panel below already
   * continues the router once you press one of its buttons.
   */
  function stalled() {
    if (!story || story.running) return false;
    if (phases.isTerminal(story.state?.phase)) return false;
    return !story.gate || !!story.decision;
  }

  async function run() {
    busy = true;
    build();

    let result;
    try {
      result = await onResume(story.dir);
    } catch (error) {
      result = { ok: false, stderr: String(error.message || error) };
    }

    busy = false;
    // On success the router is live, so the next story load hides this panel
    // and the conversation takes its place. Only a refusal has to be read here.
    build();
    if (outcome && result && !result.ok) render(outcome, scriptResult(result));
  }

  return { host, setStory };
}
