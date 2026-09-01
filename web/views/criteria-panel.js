/**
 * Acceptance criteria, each with the quote it was drawn from and the test ids
 * that prove it.
 *
 * The source_quote is shown rather than hidden behind a hover: at plan_review
 * the question is whether these criteria COVER the ticket, and you cannot
 * answer that without seeing what each one claims to come from. A criterion
 * with no quote is called out for the same reason.
 */
import { el } from '../core/dom.js';
import { panel, badge, chip, quote, note, empty } from '../core/ui.js';
import { list, count } from '../core/format.js';

const COMPLETENESS = { FULL: 'b-ok', PARTIAL: 'b-warn', NOT_FOUND: 'b-bad' };

export function criteriaPanel(state, plan) {
  const criteria = list(state.acceptance_criteria);
  const packages = list(state.work_packages);

  const title = [
    `Acceptance criteria · ${criteria.length}`,
    packages.length ? count(packages.length, 'work package') : null,
  ].filter(Boolean).join(' · ');

  return panel({ title, aside: completeness(state.navigator) },
    criteria.length
      ? criteria.map(criterion)
      : empty('No acceptance criteria recorded yet.'),

    state.phase === 'plan_review'
      && note('Nothing upstream checks whether these cover the ticket. That is this gate.'),

    plan && plan.text && planLink(),
  );
}

/** How much of the ticket the navigator could resolve. */
function completeness(navigator) {
  const value = navigator && navigator.completeness;
  if (!value) return null;
  return badge(COMPLETENESS[value] || 'b-mute', `ticket ${value.toLowerCase().replace('_', ' ')}`,
               { title: 'how much of the ticket the navigator could resolve' });
}

function criterion(item) {
  const tests = list(item.test_ids);

  return el('div', { class: 'ac' },
    el('code', { text: item.id || '—' }),
    el('div', { class: 'ac-body' },
      el('span', { text: item.text || '(no text)' }),

      item.source_quote
        ? quote(item.source_quote)
        : el('div', { class: 'quote muted',
                      text: 'no source quote — nothing ties this to the ticket' }),

      el('div', { class: 'chips' },
        item.repo && chip(item.repo),
        tests.length
          ? tests.map((id) => chip(id, { title: 'greped in the PR diff' }))
          : chip('no test ids')),
    ),
  );
}

/** Scrolls to the plan rather than duplicating it — it is already on the page. */
function planLink() {
  return el('a', {
    href: '#', style: 'display:inline-block;margin-top:9px', text: 'Open full plan',
    onClick: (event) => {
      event.preventDefault();
      const details = document.querySelector('[data-doc="plan"]');
      if (!details) return;
      details.open = true;
      details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
}
