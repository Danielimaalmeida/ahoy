'use strict';
// bin/approve.sh — the only writer of a human decision.
//
// The router reads .human_gates[key].status. A bare boolean has no .status, so
// the gate could not open — and the phase was then set by hand instead, which
// is how R3DA-13709 reached `done` with its delivery gate never exercised.
// These assert the half of the fix that lives here: approve is the one thing
// that writes the shape. (The router's half is in human-gates.test.js.)

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');
const { humanGateStatus } = require('../../bin/lib/derive');

// approveWS(phase, patch) — a sandbox holding the harness scripts and the real
// phase table, with the story sitting at `phase`.
function approveWS(phase, patch) {
  const ws = newWorkspace();
  ws.installBin('approve', 'tick').installTable();
  ws.writeState({ story_id: STORY, phase, human_gates: {} });
  if (patch) ws.patchState(patch);
  return ws;
}

function withWS(phase, patch, fn) {
  const ws = approveWS(phase, patch);
  try { return fn(ws); } finally { ws.destroy(); }
}

test('approving a gate the story has not reached is refused', () => {
  withWS('delivery_gate', null, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

test('approving at the right phase is recorded', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 0);
    const s = ws.readState();
    assert.strictEqual(humanGateStatus(s, 'plan_accepted'), 'approved',
      'approve writes the object shape the router accepts');
    // The timestamp is the half a boolean cannot carry: a plan approved three
    // rounds of change ago is not self-evidently still approved.
    assert.ok(s.human_gates.plan_accepted.timestamp,
      'the decision carries a timestamp a boolean could not');
  });
});

// Runs against a workspace that now holds a recorded decision. Under the bash
// suite's `expect` this ran against a deleted directory and passed on the exit
// code of a failed `cd` rather than on anything approve.sh did.
test('a recorded decision is not silently overwritten', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 0);
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

// `pending` is a placeholder, not a decision. Agents write it despite their
// profiles forbidding it, and treating it as recorded made the harness reject
// the human's real approval with "already recorded as 'pending'" — at both
// gates, on the one story that got that far.
test('a pending marker does not block approval', () => {
  withWS('plan_review', (s) => { s.human_gates.plan_accepted = { status: 'pending' }; }, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 0);
    assert.strictEqual(humanGateStatus(ws.readState(), 'plan_accepted'), 'approved',
      'and the real decision replaces it');
  });
});

// A genuine decision is still protected.
test('a recorded rejection is still not overwritten', () => {
  withWS('plan_review', (s) => { s.human_gates.plan_accepted = { status: 'rejected', timestamp: 't' }; }, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

test('rejecting is recorded too', () => {
  withWS('plan_review', null, (ws) => {
    const r = ws.bin('approve.sh', STORY, 'plan', '--reject', 'AC coverage is incomplete', '--no-continue');
    assert.strictEqual(r.code, 0);
    const s = ws.readState();
    assert.strictEqual(s.phase, 'blocked', 'a rejection routes to blocked, not onward');
    assert.strictEqual(s.human_gates.plan_accepted.reason, 'AC coverage is incomplete',
      'the reason is kept with the decision');
  });
});

test('an unknown gate name is a usage error', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('approve.sh', STORY, 'nonsense', '--no-continue').code, 2);
  });
});

// The short name, the key, and the phase all resolve to the same gate, because
// the table decides what is real rather than a hardcoded list in the script.
for (const alias of ['plan', 'plan_accepted', 'plan_review']) {
  test(`'${alias}' resolves to the plan gate`, () => {
    withWS('plan_review', null, (ws) => {
      assert.strictEqual(ws.bin('approve.sh', STORY, alias, '--no-continue').code, 0);
    });
  });
}
