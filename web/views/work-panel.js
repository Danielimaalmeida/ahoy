/**
 * Work packages and the child repositories they land in - including the pull
 * request links, which are the point of the whole pipeline.
 *
 * Returns null when a story has neither, so a young story shows nothing rather
 * than two empty tables.
 */
import { el } from '../core/dom.js';
import { panel, dataTable, badge, chip, mono, muted } from '../core/ui.js';
import { words, list, statusClass, shortSha } from '../core/format.js';

export function workPanel(state) {
  const packages = list(state.work_packages);
  const repos = list(state.child_repos);
  if (!packages.length && !repos.length) return null;

  return [
    packages.length && workPackages(packages),
    repos.length && repositories(repos),
  ];
}

function workPackages(packages) {
  return panel({ title: 'Work packages' }, dataTable({
    columns: ['id', 'agent', 'repo', 'depends on', 'status'],
    rows: packages,
    cells: (pkg) => [
      mono(pkg.id || '—'),
      pkg.agent || '—',
      pkg.repo || '—',
      list(pkg.depends_on).length ? mono(list(pkg.depends_on).join(', ')) : muted('nothing'),
      [
        badge(statusClass(pkg.status), words(pkg.status || 'unknown')),
        pkg.open_pr && chip('opens a PR', { style: 'margin-left:5px' }),
      ],
    ],
  }));
}

function repositories(repos) {
  return panel({ title: 'Repositories and pull requests' }, dataTable({
    columns: ['repo', 'branch', 'head', 'pull request', 'status'],
    rows: repos,
    cells: (repo) => [
      [el('div', { text: repo.repo || '—' }),
       repo.slug && el('div', { class: 'mono muted', text: repo.slug })],
      mono(repo.branch || '—'),
      mono(shortSha(repo.head_sha) || '—', { title: repo.head_sha || '' }),
      pullRequest(repo),
      [
        badge(statusClass(repo.status), words(repo.status || 'unknown')),
        repo.retry_count && chip(retries(repo.retry_count), { style: 'margin-left:5px' }),
      ],
    ],
  }));
}

function pullRequest(repo) {
  if (!repo.pr_url) return muted('none yet');
  return el('a', {
    href: repo.pr_url, target: '_blank', rel: 'noreferrer',
    text: `#${repo.pr_number ?? '?'} ↗`,
  });
}

function retries(n) {
  return `${n} ${n === 1 ? 'retry' : 'retries'}`;
}
