'use strict';
// bin/serve.sh — the browser version of the terminal menu.
//
// The UI is a second interface to the harness, not a second implementation of
// it. It reads state.json and phases.tsv and writes neither; every button
// shells out to the command that already owned that decision.
//
// The one bug this design caught the hard way was a UI that had reimplemented
// "has this gate been decided?" and got it subtly wrong, greying out the
// buttons for every story it was meant to serve. These cover that function and
// the two path guards, which are the places where the server can be wrong on
// its own rather than by relaying a script.
//
// serve.py had no tests at all. It does now.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const serve = require('../../bin/serve');
const { SRC_ROOT } = require('../lib/harness');

const rows = require('../../bin/lib/table').load(
  path.join(SRC_ROOT, 'knowledge', 'process', 'phases.tsv'));

// --------------------------------------------------------------------------
// the pipeline strip
// --------------------------------------------------------------------------
// Walked from the first row by following on_pass, so `rework` (reached only by
// a gate branching) and `blocked` (reached only by a failure) stay off the
// strip, and a reordered table reorders the UI without a code change.

test('the mainline is the happy path, in table order', () => {
  assert.deepStrictEqual(serve.mainline(rows),
    ['intake', 'planning', 'plan_review', 'implementation', 'pr_review', 'delivery_gate', 'done']);
});

test('rework and blocked stay off the strip', () => {
  const line = serve.mainline(rows);
  assert.ok(!line.includes('rework'));
  assert.ok(!line.includes('blocked'));
});

// A table whose on_pass loops back must not hang the page.
test('a cycle in on_pass terminates rather than looping forever', () => {
  const looped = [
    { phase: 'a', kind: 'auto', on_pass: 'b' },
    { phase: 'b', kind: 'auto', on_pass: 'a' },
  ];
  assert.deepStrictEqual(serve.mainline(looped), ['a', 'b']);
});

test('an empty table yields an empty strip, not a crash', () => {
  assert.deepStrictEqual(serve.mainline([]), []);
});

// --------------------------------------------------------------------------
// human gates, resolved from the table
// --------------------------------------------------------------------------

test('the human gates come from the table, with their short names', () => {
  const gates = serve.humanGates(rows);
  assert.strictEqual(gates.plan_review.key, 'plan_accepted');
  assert.strictEqual(gates.plan_review.short, 'plan');
  assert.strictEqual(gates.delivery_gate.short, 'delivery');
});

test('a client cannot name a gate the process does not have', () => {
  assert.strictEqual(serve.resolveGate('nonsense'), null);
  assert.strictEqual(serve.resolveGate(''), null);
  // A real phase that is not a human gate is still not approvable.
  assert.strictEqual(serve.resolveGate('implementation'), null);
});

test('the short name, the key and the phase all resolve alike', () => {
  for (const alias of ['plan', 'plan_accepted', 'plan_review']) {
    assert.strictEqual(serve.resolveGate(alias), 'plan_accepted');
  }
});

// --------------------------------------------------------------------------
// gateDecision — the function whose earlier version greyed out every button
// --------------------------------------------------------------------------
// `pending` is the template's placeholder for "nobody has decided yet", which
// is the opposite of a recorded decision. Reporting it as one makes the panel
// say "already recorded", then disable every button on a gate nobody has
// touched — which locks the story out of the UI that exists to decide it.
// bin/approve.js draws exactly this distinction and this has to agree with it.

test('a pending marker is not a decision', () => {
  assert.strictEqual(
    serve.gateDecision({ human_gates: { plan_accepted: { status: 'pending' } } }, 'plan_accepted'),
    null);
});

test('an empty or absent status is not a decision either', () => {
  assert.strictEqual(
    serve.gateDecision({ human_gates: { plan_accepted: { status: '' } } }, 'plan_accepted'), null);
  assert.strictEqual(
    serve.gateDecision({ human_gates: { plan_accepted: { timestamp: 't' } } }, 'plan_accepted'), null);
  assert.strictEqual(serve.gateDecision({ human_gates: {} }, 'plan_accepted'), null);
  assert.strictEqual(serve.gateDecision({}, 'plan_accepted'), null);
});

test('a real decision comes back with its timestamp and reason', () => {
  assert.deepStrictEqual(
    serve.gateDecision({
      human_gates: { plan_accepted: { status: 'rejected', timestamp: 't', reason: 'AC gap' } },
    }, 'plan_accepted'),
    { status: 'rejected', timestamp: 't', reason: 'AC gap' });
});

// A bare boolean is the hand-edit approve.js exists to prevent. It is reported
// as malformed rather than coerced into looking like a decision — the same
// refusal the router makes, so the page and the harness agree.
test('a bare boolean is reported as malformed, not as approval', () => {
  assert.deepStrictEqual(
    serve.gateDecision({ human_gates: { plan_accepted: true } }, 'plan_accepted'),
    { status: 'malformed', timestamp: null, reason: null });
});

// --------------------------------------------------------------------------
// reopening a delivered story
// --------------------------------------------------------------------------
// `done` is terminal, but "I tested it and found a bug" is the most common
// thing that happens to a delivery. Derived from on_pass exactly as revise.js
// derives it, so a reordered table cannot leave the page offering rework on a
// phase the script would refuse.

test('a terminal phase offers the gate it was reached through', () => {
  const gates = serve.humanGates(rows);
  assert.strictEqual(serve.reopenableGate(rows, gates, 'done').key, 'delivery_accepted');
});

test('a live gate is not reopenable — it goes through the decision panel', () => {
  const gates = serve.humanGates(rows);
  assert.strictEqual(serve.reopenableGate(rows, gates, 'plan_review'), null);
  assert.strictEqual(serve.reopenableGate(rows, gates, 'implementation'), null);
});

// `blocked` is terminal but nothing routes into it on pass, so there is no gate
// to take back. Offering one would send revise.js a story it would refuse.
test('blocked is terminal but has no gate to reopen', () => {
  const gates = serve.humanGates(rows);
  assert.strictEqual(serve.reopenableGate(rows, gates, 'blocked'), null);
});

// --------------------------------------------------------------------------
// the story list
// --------------------------------------------------------------------------

test('a story at a human gate with nothing recorded is awaiting a human', () => {
  const s = serve.summarise('PROJ-1', { phase: 'plan_review', human_gates: {} },
    serve.humanGates(rows), serve.mainline(rows));
  assert.strictEqual(s.awaiting, true);
  assert.strictEqual(s.gate.key, 'plan_accepted');
});

test('a decided gate is no longer awaiting', () => {
  const s = serve.summarise('PROJ-1', {
    phase: 'plan_review',
    human_gates: { plan_accepted: { status: 'approved', timestamp: 't' } },
  }, serve.humanGates(rows), serve.mainline(rows));
  assert.strictEqual(s.awaiting, false);
});

test('updated is the latest timestamp the story carries, from anywhere', () => {
  const s = serve.summarise('PROJ-1', {
    phase: 'implementation',
    gate_results: [{ timestamp: '2026-01-01T00:00:00Z' }],
    decision_log: [{ timestamp: '2026-03-01T00:00:00Z' }],
    human_gates: { plan_accepted: { status: 'approved', timestamp: '2026-02-01T00:00:00Z' } },
  }, serve.humanGates(rows), serve.mainline(rows));
  assert.strictEqual(s.updated, '2026-03-01T00:00:00Z');
});

test('a story with no timestamps reports none rather than a fabricated one', () => {
  const s = serve.summarise('PROJ-1', { phase: 'intake' },
    serve.humanGates(rows), serve.mainline(rows));
  assert.strictEqual(s.updated, null);
});

// --------------------------------------------------------------------------
// path safety
// --------------------------------------------------------------------------
// A story id becomes a path segment under specs/, and plan_path is read from
// state.json — which an agent writes. Neither may reach outside the repository.

test('a story id is refused before it reaches the filesystem', () => {
  for (const bad of ['../etc', 'a/b', '', '.', 'x'.repeat(65), '/abs', '-leading']) {
    assert.strictEqual(serve.storyStatePath(bad), null, `${JSON.stringify(bad)} is refused`);
  }
});

test('a plan_path pointing outside the repository is refused', () => {
  assert.strictEqual(serve.readRepoText('../secrets.md').error, 'path outside the repository');
  assert.strictEqual(serve.readRepoText('/etc/passwd').error, 'path outside the repository');
  assert.strictEqual(serve.readRepoText('specs/../../x').error, 'path outside the repository');
});

test('a plan_path inside the repository that does not exist says so', () => {
  assert.strictEqual(serve.readRepoText('specs/nope/plan.md').error, 'not found');
});

test('a real repo-relative file is read', () => {
  assert.match(serve.readRepoText('knowledge/process/phases.tsv').text, /^# Machine-readable/);
});

test('isInside rejects a sibling directory with a shared prefix', () => {
  assert.strictEqual(serve.isInside('/a/specs-evil/x', '/a/specs'), false);
  assert.strictEqual(serve.isInside('/a/specs/x', '/a/specs'), true);
  // A directory is not inside itself; there is no file to serve at that path.
  assert.strictEqual(serve.isInside('/a/specs', '/a/specs'), false);
});
