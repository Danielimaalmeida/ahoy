/**
 * One story, top to bottom.
 *
 * The order is an argument: everything you would need in order to judge the
 * story comes above the three buttons - criteria, the plan itself, the
 * reviewer verdicts, the work. The log comes after. Putting the buttons first
 * would make it easy to approve something you have not read, and this gate
 * exists precisely because nothing upstream can do that reading for you.
 *
 * `chatHost` sits directly under the phase strip, above all of it. When a
 * session is live it is the only thing on the page that is happening now -
 * everything below it is a record of what already happened - and buried under
 * the credits panel it took a scroll to find, so a running agent looked like a
 * still page. It draws nothing at all when there is no session, so the reading
 * order above is unchanged in the case the argument is about: at a gate the
 * router has exited, and the criteria are back at the top where they belong.
 *
 * `chatHost`, `decisionHost`, `reworkHost` and `resumeHost` are passed in rather
 * than built here: all four own state - a live connection, a typed reason, a
 * run in flight - that must survive this view being rebuilt. Only one of the
 * three action panels ever draws itself: a story at a gate has a decision to
 * make, a delivered one has an acceptance to take back, and one that has
 * stopped between the two has neither and needs picking back up.
 */
import { el } from '../core/dom.js';
import { badge } from '../core/ui.js';
import { phases } from '../core/phases.service.js';
import { words, list } from '../core/format.js';

import { phaseStrip } from './phase-strip.js';
import { criteriaPanel } from './criteria-panel.js';
import { documentPanel } from './document-panel.js';
import { reviewVerdicts } from './review-verdicts.js';
import { workPanel } from './work-panel.js';
import { creditsPanel } from './credits-panel.js';
import { historyPanel } from './history-panel.js';

export function storyDetail(story, { chatHost, decisionHost, reworkHost, resumeHost }) {
  const state = story.state || {};

  return el('div', { class: 'card pad' },
    header(story, state),
    phaseStrip(state),
    chatHost,
    criteriaPanel(state, story.plan),
    documentPanel(story),
    reviewVerdicts(state),
    workPanel(state),
    creditsPanel(state),
    decisionHost,
    reworkHost,
    resumeHost,
    historyPanel(state),
  );
}

export function detailPlaceholder(message) {
  return el('div', { class: 'card pad empty', text: message });
}

function header(story, state) {
  const waiting = !!phases.gate(state.phase) && !story.decision;

  return el('div', { class: 'head-bar' },
    el('div', {},
      el('h1', { text: state.story_id || story.dir }),
      el('div', { class: 'sub', style: 'margin-bottom:0',
                  text: [state.title || 'Untitled', repos(state).join(', ')]
                          .filter(Boolean).join(' · ') })),

    el('div', { style: 'text-align:right' },
      el('div', {},
        badge(phases.badgeClass(state.phase), words(state.phase || 'unknown')),
        waiting && badge('b-warn', 'waiting on you', { style: 'margin-left:5px' })),
      state.jira_url && el('div', {},
        el('a', { href: state.jira_url, target: '_blank', rel: 'noreferrer', text: 'Jira ↗' }))),
  );
}

/** Every repository this story touches, however it was recorded. */
function repos(state) {
  return [...new Set([
    ...list(state.work_packages).map((pkg) => pkg.repo),
    ...list(state.child_repos).map((repo) => repo.repo),
    ...list(state.acceptance_criteria).map((criterion) => criterion.repo),
  ].filter(Boolean))];
}
