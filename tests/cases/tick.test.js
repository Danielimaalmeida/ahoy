'use strict';
// bin/tick.sh — the router.
//
// Nothing else moves phase. The exit code of a gate is the routing decision,
// and these assert that the router reads it as one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { newWorkspace, STORY } = require('../lib/harness');

function tickWS(phase, patch) {
  const ws = newWorkspace();
  ws.installBin('tick', 'approve', 'revise', 'decide', 'dispatch', 'review', 'credits').installTable();
  ws.writeState({ story_id: STORY, phase, human_gates: {} });
  if (patch) ws.patchState(patch);
  return ws;
}

function withWS(phase, patch, fn) {
  const ws = tickWS(phase, patch);
  try { return fn(ws); } finally { ws.destroy(); }
}

// --once and --wait ask for opposite things; the pair is refused rather than
// silently resolved in favour of whichever the code tests first. Checked before
// anything else, so it does not depend on a runnable environment.
test('--once and --wait together are refused', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('tick.sh', STORY, '--once', '--wait').code, 2);
  });
});

test('an unknown option is a usage error', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('tick.sh', STORY, '--sideways').code, 2);
  });
});

test('no story id at all is a usage error', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('tick.sh').code, 2);
  });
});

test('a story with no state file is an environment error, not a failure', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('tick.sh', 'NOPE-1').code, 2);
  });
});

// A malformed human gate is NOT approval. A bare boolean has no .status, and
// reading it as anything but a refusal is how R3DA-13709 reached `done`.
// HARNESS_NO_MENU keeps this headless: the check must happen before the menu.
test('a malformed human gate stops the router with exit 2', () => {
  withWS('plan_review', (s) => { s.human_gates.plan_accepted = true; }, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /not an object/);
    assert.match(r.out, /a malformed gate is NOT approval/);
  });
});

// Silence is never approval. With no decision recorded and no terminal, the
// router prints the command and stops rather than blocking or advancing.
test('an undecided human gate stops without advancing', () => {
  withWS('plan_review', null, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /Silence is never approval/);
    assert.strictEqual(ws.readState().phase, 'plan_review', 'the phase did not move');
  });
});

// `pending` is a placeholder an agent wrote, and it is not a decision either.
test('a pending human gate does not open it', () => {
  withWS('plan_review', (s) => { s.human_gates.plan_accepted = { status: 'pending' }; }, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(ws.readState().phase, 'plan_review');
  });
});

// The router may advance on a recorded decision: it was written by
// bin/approve.sh in response to an explicit human choice, so reading it is not
// an agent declaring its own success.
test('an approved gate advances to the on_pass phase from the table', () => {
  withWS('plan_review', (s) => {
    s.human_gates.plan_accepted = { status: 'approved', timestamp: 't' };
  }, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY, '--once'], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(ws.readState().phase, 'implementation');
  });
});

test('a terminal phase stops, touching nothing', () => {
  withWS('done', null, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(ws.readState().phase, 'done');
  });
});

test('a phase that is not in the table is an environment error', () => {
  withWS('invented', null, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /is not in/);
  });
});

// An empty child_repos[] means no work package has been dispatched yet, not
// that every repo is ready. Without the guard the per-repo gate iterates
// nothing, returns 0, and pr.sh is asked to verify a delivery that never
// started — it fails safe, but records a misleading `fail` in gate_results.
test('implementation with no dispatched repos stays put rather than running pr.sh', () => {
  withWS('implementation', (s) => { s.child_repos = []; }, (ws) => {
    const r = ws.run(ws.path('bin', 'tick.sh'), [STORY, '--no-agent'], { env: { HARNESS_NO_MENU: '1' } });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /child_repos\[\] is empty/);
    assert.strictEqual(ws.readState().phase, 'implementation');
    assert.ok(!(ws.readState().gate_results || []).some((g) => g.gate === 'pr.sh'),
      'pr.sh was never asked about a delivery that has not started');
  });
});

// --------------------------------------------------------------------------
// an interactive read must come from /dev/tty
// --------------------------------------------------------------------------
// The stuck-package menu iterates a list of rows. A read of inherited stdin
// inside that loop consumed the package list rather than the keystroke, hit
// EOF, and the menu printed its options and gave up in the same breath — which
// is exactly what it did the first time a package needed a decision.
//
// In bash the fix was `read -r x < /dev/tty` at every prompt; the bash suite
// grepped tick.sh for a bare `read`. Here every prompt goes through one
// function that opens /dev/tty itself, so the equivalent check is that the
// router never reaches for stdin to ask a human a question.

test('no interactive read in tick.js relies on inherited stdin', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bin', 'tick.js'), 'utf8');
  const stdinReads = src.split('\n').filter((l) =>
    /process\.stdin/.test(l) && !/isTTY/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(stdinReads, [],
    'tick.js touches process.stdin only to ask whether it is a terminal');
  assert.match(src, /readLineFromTTY/, 'and asks its questions through the /dev/tty reader');
});

test('the tty reader is the only place the harness opens a prompt', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'proc.js'), 'utf8');
  assert.match(src, /openSync\('\/dev\/tty', 'r'\)/,
    'readLineFromTTY names its source rather than inheriting one');
});
