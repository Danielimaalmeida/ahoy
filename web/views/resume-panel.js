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
 * IT READS AS RECOVERABLE, NOT AS FAILURE. Amber, and the copy says outright
 * that nothing is wrong with the work. A stalled story is a closed laptop, not
 * a broken delivery, and a red panel would send someone hunting for a fault
 * that is not there. The button names the phase it will resume from so the
 * click is cheap to make.
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
import { words, duration, ageMs, clock } from '../core/format.js';

export function createResumePanel({ onResume }) {
  const host = el('div');

  let story = null;
  let storyId = null;
  let busy = false;
  let outcome = null;

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
      render(host);
      return;
    }

    const phase = story.state?.phase;
    const last = lastWrite();
    const age = ageMs(last);
    outcome = el('div');

    render(host, el('div', { class: 'stalled' },
      el('div', { class: 'stalled-head' },
        el('span', { class: 'chat-mark' }),
        el('div', {},
          el('h2', { text: age === null
            ? 'This story has stopped moving.'
            : `This story stopped moving ${duration(age)} ago.` }),
          el('p', { text: explanation(phase, last) }))),
      el('div', { class: 'stalled-act' },
        el('button', {
          class: 'primary', type: 'button', disabled: busy,
          text: busy ? 'Starting the router…' : `Continue from ${words(phase)}`,
          onClick: run,
        }),
        el('span', { class: 'fine', style: 'margin-top:0',
                     text: `Runs bin/run.sh ${story.dir}. Work already finished stays finished; `
                         + 'the router picks up from where the story actually is.' })),
      outcome,
    ));
  }

  function explanation(phase, last) {
    const when = last ? ` — the last write to state.json was at ${clock(last)}` : '';
    return `It is part-way through ${words(phase)} with no router process attached${when}. `
         + 'Nothing is wrong with the work; something stopped carrying it. '
         + 'Continuing picks it up from where it stopped.';
  }

  /** The most recent timestamp the story recorded, whatever wrote it. */
  function lastWrite() {
    const stamps = [];
    for (const entry of story.state?.decision_log || []) {
      if (entry && entry.timestamp) stamps.push(entry.timestamp);
    }
    for (const entry of story.state?.gate_results || []) {
      if (entry && entry.timestamp) stamps.push(entry.timestamp);
    }
    return stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
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
