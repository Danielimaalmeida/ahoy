/**
 * The pipeline as a strip, so the whole route is visible at once and the two
 * places it stops for a human are obvious without reading anything.
 */
import { el } from '../core/dom.js';
import { phases } from '../core/phases.service.js';
import { words } from '../core/format.js';

export function phaseStrip(state) {
  const offPath = !phases.mainline.includes(state.phase);

  return el('div', {},
    el('div', { class: 'strip' },
      phases.steps(state).map((step) => el('span', {
        class: ['step', step.status !== 'ahead' && step.status, step.human && 'human'],
        text: words(step.phase),
        title: step.human ? 'a human moves this one' : null,
      })),
      // A story that left the happy path still has a phase, and it is the most
      // important word on the screen. It goes on the end of the strip.
      offPath && el('span', {
        class: `step ${phases.isTerminal(state.phase) ? 'fail' : 'now'}`,
        text: words(state.phase),
      })),

    el('div', { class: 'strip-note' },
      '◆ marks the two phases only a human can move.',
      offPath && `  This story is at ${words(state.phase)}, off the main route.`),
  );
}
