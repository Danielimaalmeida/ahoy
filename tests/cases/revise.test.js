'use strict';
// bin/revise.sh — a gate you can send back, not only yes or no.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

function reviseWS(phase, patch) {
  const ws = newWorkspace();
  ws.installBin('revise', 'approve', 'tick').installTable();
  ws.writeState({ story_id: STORY, phase, human_gates: {} });
  if (patch) ws.patchState(patch);
  return ws;
}

function withWS(phase, patch, fn) {
  const ws = reviseWS(phase, patch);
  try { return fn(ws); } finally { ws.destroy(); }
}

const pkg = (s, id) => s.work_packages.find((w) => w.id === id);

test('revising at the gate sends the story back', () => {
  withWS('plan_review', null, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 0);
    const s = ws.readState();
    assert.strictEqual(s.phase, 'planning', 'the phase returns to the producer, derived from the table');
    assert.strictEqual(s.revisions.plan_accepted, 1, 'the revision round is counted');
  });
});

// The safety property. An approval is a judgement about a specific artifact, and
// revising changes the artifact — so the decision must not survive it, or the
// next tick carries a revised plan past a gate nobody re-opened.
test('revising after approval is allowed, and the stale approval is cleared', () => {
  withWS('plan_review', (s) => {
    s.human_gates.plan_accepted = { status: 'approved', timestamp: 't' };
  }, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 0);
    assert.strictEqual(ws.readState().human_gates.plan_accepted, undefined,
      'a stale approval is cleared, not carried onto the new plan');
  });
});

// A pending marker written by the agent is not a decision, and must not block
// a revision either.
test('a pending marker does not block revision', () => {
  withWS('plan_review', (s) => {
    s.human_gates.plan_accepted = { status: 'pending' };
  }, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 0);
    assert.strictEqual(ws.readState().human_gates.plan_accepted, undefined,
      'the pending marker is cleared too');
  });
});

test('revising a story not at a gate is refused', () => {
  withWS('planning', null, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

// Same reasoning as gates/rework_ceiling.sh: a plan that has not converged in
// several interactive rounds is not converging on the next one.
test('the revision ceiling stops an endless loop', () => {
  withWS('plan_review', (s) => { s.revisions = { plan_accepted: 4 }; }, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

test('a deliberately raised ceiling is honoured', () => {
  withWS('plan_review', (s) => {
    s.revisions = { plan_accepted: 4 };
    s.revision_ceiling = 6;
  }, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 0);
  });
});

// The reason is what makes a revision the human's rather than the agent's.
test('a revision reason is recorded', () => {
  withWS('plan_review', null, (ws) => {
    const why = 'the frontend criteria miss the empty state';
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue', '--', why).code, 0);
    const s = ws.readState();
    assert.strictEqual(s.revision_reason, why, 'the reason is on state for tick to put in the prompt');
    assert.strictEqual(s.decision_log.at(-1).summary.replace(/^.*: /, ''), why,
      'and in the decision log, where three rounds later it explains itself');
  });
});

// "I tested it and found a bug" is the most ordinary thing that happens to a
// delivery, and `done` is terminal — so it used to mean five lines of jq.
test('a delivered story can be reopened', () => {
  withWS('done', (s) => {
    s.work_packages = [{ id: 'WP1', repo: 'svc', status: 'done', agent: 'impl' }];
    s.child_repos = [{ repo: 'svc', status: 'ready' }];
    s.human_gates.delivery_accepted = { status: 'approved', timestamp: 't' };
  }, (ws) => {
    const why = 'the divider jumps at the minimum';
    assert.strictEqual(ws.bin('revise.sh', STORY, 'delivery', '--no-continue', '--', why).code, 0);
    const s = ws.readState();
    assert.strictEqual(s.phase, 'implementation', 'reopening goes back to implementation, where the code is');
    assert.strictEqual(pkg(s, 'WP1').status, 'pending', 'the delivered package reopens');
    assert.strictEqual(pkg(s, 'WP1').rework_note, why, 'with what you found, so the fixer is not guessing');
    assert.strictEqual(s.human_gates.delivery_accepted, undefined,
      'and the acceptance is cleared — it was about code that is now changing');
  });
});

test('a story at done with no delivery gate to reopen is still refused', () => {
  withWS('done', null, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'plan', '--no-continue').code, 1);
  });
});

test('delivery can be sent back too', () => {
  withWS('delivery_gate', null, (ws) => {
    assert.strictEqual(ws.bin('revise.sh', STORY, 'delivery', '--no-continue').code, 0);
    assert.strictEqual(ws.readState().phase, 'pr_review',
      'delivery returns to pr_review, which is what produced the reviews');
  });
});
