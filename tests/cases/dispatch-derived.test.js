'use strict';
// The derived values bin/dispatch.js routes on.
//
// Every one of these was a jq filter the bash suite pasted into itself and then
// asserted against the paste. They are imported here, so what is under test is
// the code that ships.

const test = require('node:test');
const assert = require('node:assert');
const derive = require('../../bin/lib/derive');

// --------------------------------------------------------------------------
// repo status is derived from its work packages
// --------------------------------------------------------------------------
// It was hardcoded to "in_progress" on every package completion, including the
// last one. gates/child_ready.sh requires "ready", so it could never pass: both
// packages finished and the story sat in `implementation` reporting not-yet.

const wps = (arr) => ({ work_packages: arr });

test('one package still open keeps the repo in_progress', () => {
  assert.strictEqual(derive.repoStatus(wps([
    { id: 'WP1', repo: 'svc', status: 'done' },
    { id: 'WP2', repo: 'svc', status: 'pending' },
  ]), 'svc'), 'in_progress');
});

test('the last package finishing makes the repo ready', () => {
  assert.strictEqual(derive.repoStatus(wps([
    { id: 'WP1', repo: 'svc', status: 'done' },
    { id: 'WP2', repo: 'svc', status: 'done' },
  ]), 'svc'), 'ready');
});

// waiting_on_handback is deliberately not done: something else must land first.
test('a package waiting on a handback is not done', () => {
  assert.strictEqual(derive.repoStatus(wps([
    { id: 'WP1', repo: 'svc', status: 'done' },
    { id: 'WP2', repo: 'svc', status: 'waiting_on_handback' },
  ]), 'svc'), 'in_progress');
});

test('a stalled package does not make the repo ready', () => {
  assert.strictEqual(derive.repoStatus(wps([
    { id: 'WP1', repo: 'svc', status: 'done' },
    { id: 'WP2', repo: 'svc', status: 'stalled' },
  ]), 'svc'), 'in_progress');
});

test("another repository's open package does not hold this one back", () => {
  assert.strictEqual(derive.repoStatus(wps([
    { id: 'WP1', repo: 'svc', status: 'done' },
    { id: 'WP2', repo: 'web', status: 'pending' },
  ]), 'svc'), 'ready');
});

// recomputeRepoStatuses is what decide.js and dispatch.js both call, so a
// repository left stale by one is corrected by the other.
test('recomputing rewrites every repository, not only the one that changed', () => {
  const s = {
    work_packages: [
      { id: 'WP1', repo: 'svc', status: 'done' },
      { id: 'WP2', repo: 'web', status: 'pending' },
    ],
    child_repos: [{ repo: 'svc', status: 'in_progress' }, { repo: 'web', status: 'ready' }],
  };
  derive.recomputeRepoStatuses(s);
  assert.strictEqual(s.child_repos.find((r) => r.repo === 'svc').status, 'ready');
  assert.strictEqual(s.child_repos.find((r) => r.repo === 'web').status, 'in_progress');
});

// --------------------------------------------------------------------------
// a package nothing can dispatch must halt, not be polled
// --------------------------------------------------------------------------
// dispatch only picks up `pending`. A package sitting in `unverified` is
// therefore never dispatched — but the repository never reaches `ready` either,
// so child_ready.sh reported not-yet and --wait polled it for the full
// half-hour budget while nothing on earth was going to change.

test('an unverified package halts for a human rather than being waited on', () => {
  assert.strictEqual(derive.movability(wps([
    { id: 'WP1', status: 'done' }, { id: 'WP2', status: 'unverified' },
  ])), 'halt');
});

test('a pending package is dispatched, dependencies permitting', () => {
  assert.strictEqual(derive.movability(wps([
    { id: 'WP1', status: 'done' }, { id: 'WP2', status: 'pending' },
  ])), 'dispatch');
});

test('everything done is complete, not stuck', () => {
  assert.strictEqual(derive.movability(wps([
    { id: 'WP1', status: 'done' }, { id: 'WP2', status: 'done' },
  ])), 'complete');
});

test('one movable package is enough to keep going', () => {
  assert.strictEqual(derive.movability(wps([
    { id: 'WP1', status: 'pending' }, { id: 'WP2', status: 'unverified' },
  ])), 'dispatch');
});

for (const st of ['blocked', 'stalled', 'waiting_on_handback', 'failed']) {
  test(`'${st}' alone also halts — dispatch never picks it up`, () => {
    assert.strictEqual(derive.movability(wps([
      { id: 'WP1', status: 'done' }, { id: 'WP2', status: st },
    ])), 'halt');
  });
}

// A package with no status at all is `pending`, not stuck. The bash spelled
// this `(.status // "pending")` in nine separate filters.
test('a package with no status defaults to pending', () => {
  assert.strictEqual(derive.movability(wps([{ id: 'WP1' }])), 'dispatch');
});

// --------------------------------------------------------------------------
// dependency order
// --------------------------------------------------------------------------
// Ready = not yet dispatched, and every id in depends_on is done.

test('a package whose dependency is unfinished is not selected', () => {
  assert.strictEqual(derive.nextPackage(wps([
    { id: 'WP1', status: 'pending' },
    { id: 'WP2', status: 'pending', depends_on: ['WP1'] },
  ])).id, 'WP1');
});

test('a package becomes selectable once its dependency is done', () => {
  assert.strictEqual(derive.nextPackage(wps([
    { id: 'WP1', status: 'done' },
    { id: 'WP2', status: 'pending', depends_on: ['WP1'] },
  ])).id, 'WP2');
});

test('nothing is selectable when every dependency is still outstanding', () => {
  assert.strictEqual(derive.nextPackage(wps([
    { id: 'WP1', status: 'unverified' },
    { id: 'WP2', status: 'pending', depends_on: ['WP1'] },
  ])), null);
});

// --------------------------------------------------------------------------
// in_progress — an agent that cannot finish must not loop forever
// --------------------------------------------------------------------------
// A review-only package found a real defect it had no tool to fix. `ready` was
// untrue and `in_progress` means "dispatch me again", so it reported the latter
// every round: ten minutes and 3M tokens each, indefinitely.

test('one round is not a stall', () => {
  assert.strictEqual(derive.atCeiling(1, 2), false);
});

test('two identical rounds is; running it again changes nothing', () => {
  assert.strictEqual(derive.atCeiling(2, 2), true);
});

test('a deliberately raised ceiling is honoured', () => {
  assert.strictEqual(derive.atCeiling(2, 4), false);
});

// --------------------------------------------------------------------------
// an existing pull request overrides the plan's open_pr flag
// --------------------------------------------------------------------------
// open_pr is decided once, at planning time. Rework re-dispatches the same
// package with the same instruction, so the agent opens another pull request and
// requests Copilot review again — three rounds and the repository has a pile of
// them with a review thread nobody can read.

test('with no pull request open, the plan decides', () => {
  assert.strictEqual(derive.resolveOpenPr({ child_repos: [] }, 'svc', true), true);
});

test('with one already open, the flag is overridden', () => {
  assert.strictEqual(
    derive.resolveOpenPr({ child_repos: [{ repo: 'svc', pr_number: 401 }] }, 'svc', true), false);
});

test('and false stays false', () => {
  assert.strictEqual(
    derive.resolveOpenPr({ child_repos: [{ repo: 'svc', pr_number: 401 }] }, 'svc', false), false);
});

test("another repository's pull request is not this one's", () => {
  assert.strictEqual(
    derive.resolveOpenPr({ child_repos: [{ repo: 'web', pr_number: 401 }] }, 'svc', true), true);
});

// --------------------------------------------------------------------------
// a stuck package is a decision, not a jq incantation
// --------------------------------------------------------------------------
// Resetting a failed/stalled/unverified package meant pasting jq from an error
// message — four or five times in one evening. It is the same shape as the two
// human gates (accept, or send it round again), so it belongs in the same menu.

test('packages nothing can dispatch are the ones offered', () => {
  const ids = derive.stuckPackages(wps([
    { id: 'WP1', repo: 'svc', status: 'done', agent: 'impl' },
    { id: 'WP2', repo: 'svc', status: 'unverified', agent: 'a11y' },
    { id: 'WP3', repo: 'svc', status: 'stalled', agent: 'rev' },
  ])).map((w) => w.id);
  assert.deepStrictEqual(ids, ['WP2', 'WP3']);
});

test('nothing is stuck once both are decided', () => {
  assert.deepStrictEqual(derive.stuckPackages(wps([
    { id: 'WP1', status: 'done' }, { id: 'WP2', status: 'done' }, { id: 'WP3', status: 'pending' },
  ])), []);
});
