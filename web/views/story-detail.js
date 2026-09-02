/**
 * One story, top to bottom.
 *
 * The order is an argument: everything you would need in order to judge the
 * story comes above the three buttons - criteria, the plan itself, the
 * reviewer verdicts, the work. The log comes after. Putting the buttons first
 * would make it easy to approve something you have not read, and this gate
 * exists precisely because nothing upstream can do that reading for you.
 *
 * THE RAIL DOES NOT CHANGE THAT. At a gate a sticky strip sits at the foot of
 * the page carrying the phase, how long it has waited, and a scroll link. It
 * carries no verb. A sticky Approve was considered and rejected: a control
 * permanently under the cursor is exactly the nudge the harness forbids, and
 * here "hard to reach" and "hard to make carelessly" are the same property.
 * The scroll IS the friction, and it is the good kind. You can always reach
 * the decision in one click; you can never make it from the rail.
 *
 * WHY THE JUMP IS A BUTTON AND NOT AN ANCHOR. This app routes on the hash
 * (#/R3DA-14022), so an `href="#decision"` would blow the route away and land
 * the reader on an empty page. It scrolls the node directly instead.
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
import { badge, terminalBlock, copyButton } from '../core/ui.js';
import { phases } from '../core/phases.service.js';
import { words, list, clock, duration, ageMs } from '../core/format.js';

import { phaseStrip } from './phase-strip.js';
import { criteriaPanel } from './criteria-panel.js';
import { documentPanel } from './document-panel.js';
import { reviewVerdicts } from './review-verdicts.js';
import { workPanel } from './work-panel.js';
import { creditsPanel } from './credits-panel.js';
import { historyPanel } from './history-panel.js';

export function storyDetail(story, { chatHost, decisionHost, reworkHost, resumeHost }) {
  const state = story.state || {};
  const waiting = !!story.gate && !story.decision;

  return el('div', { class: 'card pad' },
    header(story, state),
    waiting && gateBar(story, state, decisionHost),
    phaseStrip(state),
    chatHost,
    criteriaPanel(state, story.plan),
    documentPanel(story),
    reviewVerdicts(state),
    workPanel(state),
    creditsPanel(state),
    waiting && summaryStrip(state),
    decisionHost,
    reworkHost,
    resumeHost,
    historyPanel(state),
    waiting && rail(story, state, decisionHost),
  );
}

/**
 * Answers "why am I here" before any content, and repeats the two facts that
 * matter most about a gate: nothing expires, and nothing happens if you leave.
 */
function gateBar(story, state, decisionHost) {
  const since = waitingSince(state, story.gate);
  const age = ageMs(since);

  return el('div', { class: 'gate-bar' },
    el('span', { class: 'diamond', text: '◆' }),
    el('div', {},
      el('h2', { text: `This story is stopped at ${words(state.phase)} and only you can move it.` }),
      el('p', { text: (age === null ? '' : `It has been here since ${clock(since)}. `)
        + 'There is no timeout and nothing happens if you leave — the work is below, the '
        + 'decision is at the end of it.' })),
    jumpButton(decisionHost, 'Jump to the decision ↓'));
}

/**
 * The sticky rail. States the phase and the wait; offers a scroll and nothing
 * else.
 */
function rail(story, state, decisionHost) {
  const since = waitingSince(state, story.gate);
  const age = ageMs(since);

  return el('div', { class: 'rail' },
    el('span', { class: 'diamond', text: '◆' }),
    el('div', { class: 'rail-what' },
      el('b', { text: words(state.phase) }),
      age === null ? ' · waiting on you' : ` · waiting on you for ${duration(age)}`,
      ' · no timeout, no default'),
    jumpButton(decisionHost, 'Go to the decision ↓'));
}

function jumpButton(target, label) {
  return el('button', {
    class: 'small', type: 'button', text: label,
    onClick: () => target.scrollIntoView({ block: 'center' }),
  });
}

/**
 * When the story arrived at this gate.
 *
 * The gate itself records nothing until it is decided, so the honest answer is
 * the last thing that DID get written - the gate result that let the story
 * through. Falls back to nothing rather than to a guess.
 */
function waitingSince(state, gate) {
  const stamps = [];
  for (const entry of list(state.gate_results)) {
    if (entry && entry.timestamp && entry.result === 'pass') stamps.push(entry.timestamp);
  }
  for (const entry of list(state.decision_log)) {
    if (entry && entry.timestamp) stamps.push(entry.timestamp);
  }
  return stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
}

/**
 * The story in a few numbers, immediately above the decision.
 *
 * By the delivery gate the page above is very long and you have often read it
 * yesterday. This is a recap and not a substitute — the criteria, the plan and
 * the verdicts all still sit above it, in that order.
 */
function summaryStrip(state) {
  const reviews = list(state.lookout_reviews);
  const parts = [];

  if (reviews.length) {
    const ids = new Set();
    for (const review of reviews) {
      for (const id of Object.keys(review.criteria_verdicts || {})) ids.add(id);
    }
    const met = [...ids].filter((id) =>
      reviews.every((review) => (review.criteria_verdicts || {})[id] === 'met'));
    parts.push(el('span', {}, el('b', { text: `${met.length} of ${ids.size}` }),
      ' criteria met by both reviewers'));
  }

  const rounds = list(state.child_repos).reduce((n, repo) => n + (repo.retry_count || 0), 0);
  if (rounds) {
    parts.push(el('span', {}, el('b', { text: String(rounds) }),
      ` rework ${rounds === 1 ? 'round' : 'rounds'}`));
  }

  const prs = list(state.child_repos).filter((repo) => repo.pr_number);
  for (const repo of prs) {
    parts.push(repo.pr_url
      ? el('a', { href: repo.pr_url, target: '_blank', rel: 'noreferrer',
                  text: `${repo.repo} PR #${repo.pr_number} ↗` })
      : el('span', { text: `${repo.repo} PR #${repo.pr_number}` }));
  }

  return parts.length ? el('div', { class: 'summary-strip' }, parts) : null;
}

export function detailPlaceholder(message) {
  return el('div', { class: 'card pad empty', text: message });
}

/**
 * A story whose state.json will not parse.
 *
 * Nothing but the error: no partial phases, no last-known values, and above
 * all no buttons. Everything else on this page would be a guess, and a UI that
 * offers Approve over stale state is the exact bug class this codebase is
 * shaped to avoid — a page that had reimplemented "has this gate been decided?"
 * and got it subtly wrong. The page is allowed to say it does not know.
 *
 * Copy the PATH, not the error: the fix happens in a terminal, and the path is
 * what gets pasted there.
 */
export function unreadableDetail(storyId, message) {
  const relPath = `specs/${storyId}/state.json`;

  return el('div', { class: 'card pad' },
    el('div', { class: 'unreadable' },
      el('div', { class: 'unreadable-say' },
        el('h2', { text: `Ahoy cannot read ${storyId}’s state.` }),
        el('p', { text: 'Everything below would be a guess, so nothing is shown and no buttons '
          + 'are offered. The story may well be running — this page just cannot tell you '
          + 'about it.' })),
      terminalBlock(`${relPath}\n${message}`),
      el('div', { class: 'unreadable-acts' },
        copyButton(relPath, 'Copy the path'),
        el('button', { class: 'small', type: 'button', text: 'Re-read',
                       onClick: () => window.location.reload() }))));
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
        waiting && badge('b-acc is-human', 'waiting on you', { style: 'margin-left:5px' })),
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
