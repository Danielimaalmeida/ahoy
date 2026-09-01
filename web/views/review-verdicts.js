/**
 * Reviewer verdicts - two models, two lenses, one criterion per row.
 *
 * The layout exists for one job: make disagreement impossible to miss. Where
 * the reviewers agree a criterion is unmet, that is work and the router can
 * handle it. Where they disagree, the story stops for a human, because sending
 * it to rework would tell a fixer to change something a competent reviewer says
 * is already correct. So a split row is coloured AND called out above the table
 * rather than left for you to spot by comparing two cells.
 *
 * Returns null when there are no reports.
 */
import { el } from '../core/dom.js';
import { panel, dataTable, badge, chip, muted } from '../core/ui.js';
import { words, list, statusClass, severityClass, shortSha } from '../core/format.js';

export function reviewVerdicts(state) {
  const reviews = list(state.lookout_reviews);
  if (!reviews.length) return null;

  const rows = buildRows(state, reviews);
  const split = rows.filter((row) => row.split);
  const unmet = rows.filter((row) => row.agreed && row.agreed !== 'met');

  return [
    split.map((row) => splitCallout(row, reviews)),
    unmet.length && unmetCallout(unmet),
    panel({ title: `Reviewer verdicts · ${reviews.length} reports`,
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

function verdictTable(rows, reviews) {
  return dataTable({
    columns: ['', ...reviews.map(reviewerHeading), ''],
    rows,
    rowClass: (row) => ['verdict-row', row.split && 'split'],
    cells: (row) => [
      [el('div', { class: 'mono', text: row.id }), row.text && muted(row.text)],
      ...row.verdicts.map((verdict) => verdict
        ? badge(statusClass(verdict), words(verdict))
        : badge('b-mute', 'no verdict')),
      row.split && el('span', { class: 'split-flag', text: 'they disagree' }),
    ],
    empty: 'No criteria were reviewed.',
  });
}

function splitCallout(row, reviews) {
  const said = row.verdicts
    .map((verdict, i) => `${reviewerName(reviews[i], i)} `
      + (verdict ? `says ${words(verdict)}` : 'gave no verdict'))
    .join(' · ');

  return el('div', { class: 'callout' },
    el('h2', { text: `The reviewers disagree on ${row.id}` }),
    row.text && el('p', { text: row.text }),
    el('p', { text: said }),
    el('p', { text: 'This is why the story stopped here. Sending it to rework would tell a '
                  + 'fixer to change something a competent reviewer says is already correct — '
                  + 'so the call is yours.' }),
  );
}

function unmetCallout(rows) {
  return el('div', { class: 'callout agreed' },
    el('h2', { text: 'Both reviewers agree these are not met' }),
    el('p', { text: rows.map((row) => `${row.id} (${words(row.agreed)})`).join(', ') }),
    el('p', { text: 'Agreement is not a judgement call — that is work, not a decision.' }),
  );
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
  return el('div', {},
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
