'use strict';
// Derived values, recomputed wherever they are read.
//
// Nothing in here is a field written once and trusted afterwards. A
// repository's status is a fold over its work packages; whether a story can
// move is a fold over the same list. Both used to be written at one point in
// one script, and both went stale the moment anything else changed a package:
// a story with every package `done` sat in `implementation` for good, because
// child_repos[].status still said `in_progress` and gates/child_ready.sh
// requires `ready`.
//
// These live in one module because bin/dispatch.js, bin/decide.js and
// bin/tick.js all need them and must agree. The tests import them from here
// too, so the assertion is against the shipping code rather than a copy of it.

// The statuses dispatch never picks up. Kept in ONE place: if the dispatcher's
// list and the decider's list diverge, a package becomes undecidable from one
// side and invisible from the other.
const STUCK_STATUSES = ['unverified', 'stalled', 'blocked', 'failed'];

// The contract's child status vocabulary, for reference at the routing sites.
const CHILD_STATUSES = ['ready', 'in_progress', 'blocked', 'unverified'];

function statusOf(wp) {
  return wp.status || 'pending';
}

function workPackages(state) {
  return state.work_packages || [];
}

// A repository reaches `ready` only when its last work package returns `ready`.
//
// `waiting_on_handback` and `stalled` are deliberately not `done`, so a
// repository waiting on a handback correctly stays `in_progress`. `ready` here
// is still only a claim — gates/child_ready.sh verifies it against GitHub, so a
// `ready` that is not true fails there rather than travelling further.
function repoStatus(state, repo) {
  const open = workPackages(state).filter((w) => w.repo === repo && statusOf(w) !== 'done');
  return open.length === 0 ? 'ready' : 'in_progress';
}

// Recompute every repository's status. Called wherever the value is read, not
// only where a package happens to have just finished.
function recomputeRepoStatuses(state) {
  state.child_repos = (state.child_repos || []).map((r) => ({
    ...r,
    status: repoStatus(state, r.repo),
  }));
  return state;
}

function stuckPackages(state) {
  return workPackages(state).filter((w) => STUCK_STATUSES.includes(statusOf(w)));
}

function isStuck(status) {
  return STUCK_STATUSES.includes(status);
}

// Distinguish "waiting for something that will happen" from "waiting for
// something that will not".
//
// A package left `pending` is genuinely waiting on a dependency still being
// worked, and re-running will eventually pick it up: that is `dispatch`, and
// the router may poll on it.
//
// A package in `unverified`, `blocked`, `stalled`, `waiting_on_handback` or
// `failed` is never dispatched — dispatch only picks up `pending` — so nothing
// the harness does will ever move it. Polling produced the same line every
// thirty seconds for the full half-hour budget while a work package sat
// `unverified` because a browser check could not run. That is `halt`.
function movability(state) {
  const wps = workPackages(state);
  const dispatchable = wps.filter((w) => statusOf(w) === 'pending');
  const immovable = wps.filter((w) => !['done', 'pending'].includes(statusOf(w)));
  if (dispatchable.length === 0 && immovable.length > 0) return 'halt';
  if (dispatchable.length > 0) return 'dispatch';
  return 'complete';
}

// Ready = not yet dispatched, and every id in depends_on is done.
function nextPackage(state) {
  const done = workPackages(state).filter((w) => w.status === 'done').map((w) => w.id);
  return workPackages(state).find((w) =>
    statusOf(w) === 'pending' && (w.depends_on || []).every((d) => done.includes(d))) || null;
}

// Same reasoning as gates/rework_ceiling.sh: an agent that has reported the
// same thing twice is not about to report something different on the third.
function atCeiling(rounds, ceiling) {
  return Number(rounds) >= Number(ceiling);
}

// A pull request already open for this repository overrides the plan's flag.
//
// `open_pr` is decided once, at planning time, and every rework round hands the
// same instruction to the agent again: open a pull request, request Copilot
// review. The agent has no way to know one already exists, so it obliges — and
// three rework rounds leave a repository with a pile of pull requests and a
// review thread nobody can read. The harness does know, from
// child_repos[].pr_number, so it answers the question rather than asking.
function resolveOpenPr(state, repo, planned) {
  const existing = (state.child_repos || [])
    .filter((r) => r.repo === repo)
    .map((r) => r.pr_number)
    .find((n) => n !== undefined && n !== null && n !== '');
  return existing === undefined ? planned : false;
}

// Reopen a repository's delivered work, with the gate's report attached.
//
// A gate branched during `implementation` — CI is red on a pull request the
// harness opened. Nothing external will fix that, and the agent that wrote the
// code is the one that can. So its packages go back to `pending` carrying what
// the gate reported, so the fixer is told what is broken rather than left to
// rediscover it, and the repository leaves `ready`.
//
// A repository whose build is green is left entirely alone.
function reopenRepoPackages(state, repo, note) {
  state.work_packages = workPackages(state).map((w) =>
    (w.repo === repo && w.status === 'done'
      ? { ...w, status: 'pending', rework_note: note, in_progress_rounds: 0 }
      : w));
  state.child_repos = (state.child_repos || []).map((r) =>
    (r.repo === repo ? { ...r, status: 'in_progress' } : r));
  return state;
}

// One shape, checked strictly: human_gates.<key> is an OBJECT with a `status`
// string, per knowledge/process/child-dispatch-contract.md. A bare boolean is
// rejected loudly rather than read as approval.
//
// This is not pedantry. A boolean records that someone said yes but not WHEN,
// and rework makes that difference matter: a plan approved before three rounds
// of change is not obviously still approved. It is also the shape
// bin/approve.js writes, so any other shape in the file got there by hand —
// which is exactly the case worth refusing. R3DA-13709 reached `done` with its
// delivery gate never opening, because a bare `true` was written where an
// object belonged, the router correctly refused it, and the phase was then set
// directly.
//
// `pending` counts as unset, not as a decision — see bin/approve.js.
function humanGateStatus(state, key) {
  const g = (state.human_gates || {})[key];
  if (g === undefined || g === null) return 'unset';
  if (typeof g === 'object' && !Array.isArray(g)) return g.status || 'unset';
  return `MALFORMED:${Array.isArray(g) ? 'array' : typeof g}`;
}

module.exports = {
  STUCK_STATUSES, CHILD_STATUSES,
  statusOf, workPackages, repoStatus, recomputeRepoStatuses,
  stuckPackages, isStuck, movability, nextPackage, atCeiling,
  reopenRepoPackages, resolveOpenPr, humanGateStatus,
};
