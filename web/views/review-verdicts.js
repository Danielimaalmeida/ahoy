/**
 * Reviewer verdicts - two models, two lenses, one criterion per row.
 *
 * The criterion is the unit of agreement, so it is the unit of layout. Two
 * reviewer columns side by side means a split is a horizontal mismatch you can
 * see without reading a word.
 *
 * WHERE THEY AGREE, there is nothing to decide: agreement that a criterion is
 * unmet is work, and the router sends it to rework on its own. That screen
 * opens by saying so, because three red rows look like a summons and are not
 * one - and a person who cannot find the button that does not exist will go
 * looking for it.
 *
 * WHERE THEY DISAGREE, the story has stopped and only a person can move it. So
 * this is the one view in the app that breaks the page's reading order: the
 * disputed criteria are lifted above the table, because they are the reason
 * you were called and everything else is context for them. The banner is the
 * only filled red surface in the product, reserved for exactly this so it can
 * never be mistaken for a validation error.
 *
 * NEITHER REVIEWER IS RANKED. No "1 of 2 reviewers", no majority language, no
 * ordering that puts one lens first. Ahoy must not imply a winner; the split is
 * presented as a split.
 *
 * WHAT IS NOT HERE. There is no control to settle the disagreement. The
 * harness has no verb for it - gates/consensus.sh exits 4, bin/tick.js stops
 * without changing phase, and approve/revise/decide each own a different
 * decision. A button here would be the browser deciding something no script
 * owns, which is the failure this whole codebase is shaped to avoid. So the
 * screen makes the split legible and says where the decision is actually made.
 *
 * Returns null when there are no reports.
 */
import { el } from '../core/dom.js';
import { panel, dataTable, badge, chip, muted, callout, calloutTitle } from '../core/ui.js';
import { words, list, statusClass, severityClass, shortSha } from '../core/format.js';

export function reviewVerdicts(state) {
  const reviews = list(state.lookout_reviews);
  if (!reviews.length) return null;

  const rows = buildRows(state, reviews);
  const split = rows.filter((row) => row.split);
  const unmet = rows.filter((row) => row.agreed && row.agreed !== 'met');
  const met = rows.filter((row) => row.agreed === 'met');

  return [
    split.length ? haltBanner(split, unmet, met) : agreedBanner(unmet),
    split.map((row) => disputeCard(row, reviews)),
    split.length
      ? el('details', {},
        el('summary', { text: `The ${rows.length - split.length} criteria the reviewers agree on `
          + `— ${met.length} met, ${unmet.length} unmet and bound for rework` }),
        verdictTable(rows.filter((row) => !row.split), reviews))
      : panel({ title: `Reviewer verdicts · ${reviews.length} reports`,
                aside: muted(reviewedShas(reviews)) },
        verdictTable(rows, reviews)),
    reviews.map(findingsPanel),
  ];
}

/**
 * One row per criterion: every reviewer's verdict side by side, plus whether
 * they split. A verdict on a criterion the plan no longer lists still gets a
 * row - dropping it would hide a review of something that has been removed.
 */
function buildRows(state, reviews) {
  const criteria = list(state.acceptance_criteria);
  const ids = criteria.map((criterion) => criterion.id).filter(Boolean);

  for (const review of reviews) {
    for (const id of Object.keys(review.criteria_verdicts || {})) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  const texts = new Map(criteria.map((criterion) => [criterion.id, criterion.text]));

  return ids.map((id) => {
    const verdicts = reviews.map((review) => (review.criteria_verdicts || {})[id]);
    const distinct = new Set(verdicts.filter(Boolean));
    return {
      id,
      text: texts.get(id) || '',
      verdicts,
      split: distinct.size > 1,
      agreed: distinct.size === 1 ? [...distinct][0] : null,
    };
  });
}

/** The halt. Filled red, and the only one in the product. */
function haltBanner(split, unmet, met) {
  return [
    callout('halt',
      calloutTitle(`The two reviewers disagree about ${split.length} `
        + `${split.length === 1 ? 'criterion' : 'criteria'}. The story has stopped here.`),
      el('p', { text: 'Ahoy will not send a fixer to change something one competent reviewer '
        + 'already calls correct — that is a loop with no way out. Nothing moves, in either '
        + 'direction, until a person says which reading holds.' })),
    el('div', { class: 'halt-counts' },
      el('span', {}, el('b', { text: String(split.length) }), ' disputed — waiting on you'),
      el('span', {}, el('b', { text: String(unmet.length) }),
        ' agreed unmet — goes to rework once the dispute is settled'),
      el('span', {}, el('b', { text: String(met.length) }), ' agreed met')),
  ];
}

/**
 * The reviewers agree. Opens by saying nothing is being asked of you, because
 * that is the fact a page full of red rows otherwise hides.
 */
function agreedBanner(unmet) {
  if (!unmet.length) return null;
  return callout('accent',
    calloutTitle('Nothing is being asked of you. This is running.'),
    el('p', { text: `Both reviewers say the same ${unmet.length} `
      + `${unmet.length === 1 ? 'criterion is' : 'criteria are'} not met, so there is nothing to `
      + 'settle. Agreement is not a judgement call — that is work, not a decision, and the '
      + 'router routes it to rework on its own. You will be called back at the delivery gate.' }));
}

/**
 * A disputed criterion, with each reviewer's reading beside the other.
 *
 * The schema records a verdict per criterion and nothing else - there is no
 * field for why a reviewer reached it. Rather than leave an empty box or
 * invent a rationale by grepping the findings for a criterion id, the card
 * says plainly that the reasoning was not recorded and points at the full
 * report, which is the honest version of what we actually have.
 */
function disputeCard(row, reviews) {
  return el('div', { class: 'dispute' },
    el('div', { class: 'dispute-head' },
      el('span', { class: 'mono', text: row.id }),
      el('span', { class: 'ac-text', text: row.text || '(this criterion is no longer in the plan)' }),
      el('span', { class: 'dispute-tag', text: 'DISPUTED' })),
    el('div', { class: 'dispute-sides' },
      reviews.map((review, i) => side(review, row.verdicts[i], i))),
  );
}

function side(review, verdict, index) {
  const shas = Object.entries(review.reviewed_shas || {});

  return el('div', { class: 'dispute-side' },
    el('div', { class: 'dispute-who' },
      verdict ? badge(statusClass(verdict), words(verdict)) : badge('b-mute', 'no verdict'),
      el('b', { text: reviewerName(review, index) }),
      muted(words(review.lens || ''))),
    el('p', { class: 'muted', text: 'No per-criterion reasoning is recorded — state.json keeps a '
      + 'verdict and no note against it. This reviewer’s full findings are below.' }),
    shas.length && el('div', { class: 'dispute-files',
      text: `read ${shas.map(([repo, sha]) => `${repo} @ ${shortSha(sha)}`).join(' · ')}` }),
  );
}

function verdictTable(rows, reviews) {
  return dataTable({
    columns: ['', 'criterion', ...reviews.map(reviewerHeading), 'what happens'],
    rows,
    rowClass: (row) => [
      'verdict-row',
      row.split && 'split',
      row.agreed && row.agreed !== 'met' && 'unmet',
    ],
    cells: (row) => [
      el('div', { class: 'mono', text: row.id }),
      row.text ? el('div', { text: row.text }) : muted('(no longer in the plan)'),
      ...row.verdicts.map((verdict) => verdict
        ? badge(statusClass(verdict), words(verdict))
        : badge('b-mute', 'no verdict')),
      consequence(row),
    ],
    empty: 'No criteria were reviewed.',
  });
}

/**
 * The fifth column, and the point of the table. Verdicts are the input; what
 * happens next is what the reader came for. A met row says "nothing" rather
 * than being left blank - a blank cell reads as missing data.
 */
function consequence(row) {
  if (row.split) {
    return el('div', { class: 'v-consequence is-rework', text: 'waiting on you' });
  }
  if (row.agreed === 'met') {
    return el('div', { class: 'v-consequence is-none', text: 'nothing' });
  }
  if (row.agreed) {
    return el('div', { class: 'v-consequence is-rework', text: 'goes to rework' });
  }
  return el('div', { class: 'v-consequence is-none', text: 'not reviewed' });
}

function findingsPanel(review) {
  const findings = list(review.findings);
  const ready = review.consensus_status === 'CONSENSUS_READY';

  return panel({
    title: `Findings — ${reviewerName(review)}`,
    aside: badge(ready ? 'b-ok' : 'b-bad',
                 words((review.consensus_status || 'unknown').toLowerCase())),
  }, findings.length ? findings.map(finding) : el('div', { class: 'empty', text: 'Nothing raised.' }));
}

function finding(item) {
  const files = list(item.files);

  return el('div', { class: 'finding' },
    el('div', { class: 'finding-head' },
      badge(severityClass(item.severity), item.severity || 'unrated'),
      item.repo && chip(item.repo)),
    item.evidence && el('p', { text: item.evidence }),
    item.recommendation && el('p', { class: 'rec', text: `→ ${item.recommendation}` }),
    files.length && el('div', { class: 'chips' }, files.map((file) => chip(file))),
  );
}

function reviewerName(review, index = 0) {
  return review.model || `reviewer ${index + 1}`;
}

function reviewerHeading(review) {
  return el('div', { class: 'v-reviewer' },
    el('div', { text: review.model || 'unknown model' }),
    el('div', { class: 'muted', text: words(review.lens || '') }));
}

/** The shas the reports were written against - a review of a stale head is not a review. */
function reviewedShas(reviews) {
  const shas = new Set();
  for (const review of reviews) {
    for (const sha of Object.values(review.reviewed_shas || {})) shas.add(shortSha(sha));
  }
  return shas.size ? `reviewed ${[...shas].join(', ')}` : '';
}
