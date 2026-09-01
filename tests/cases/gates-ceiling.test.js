'use strict';
// rework_ceiling.sh — terminal escalation must not look like 'poll again'.
//
// It returned "poll again" on reaching the ceiling, which is precisely the loop
// a ceiling exists to stop.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

function ceilingState(ws, retryCount) {
  ws.writeState({
    story_id: STORY,
    phase: 'rework',
    rework_ceiling: 3,
    child_repos: [{ repo: 'svc', retry_count: retryCount }],
  });
}

test('below ceiling, round allowed', () => {
  const ws = newWorkspace();
  try {
    ceilingState(ws, 0);
    assert.strictEqual(ws.gate('rework_ceiling.sh', STORY, 'svc').code, 0);
  } finally { ws.destroy(); }
});

test('at ceiling -> halt for a human (was: 1)', () => {
  const ws = newWorkspace();
  try {
    ceilingState(ws, 3);
    assert.strictEqual(ws.gate('rework_ceiling.sh', STORY, 'svc').code, 4);
  } finally { ws.destroy(); }
});

// One gate writes state, deliberately. If the gate checks the counter and the
// caller increments it, a caller that forgets loops forever — and the
// participant guaranteed to run is the gate.
test('the gate owns the counter and it persisted', () => {
  const ws = newWorkspace();
  try {
    ceilingState(ws, 1);
    ws.gate('rework_ceiling.sh', STORY, 'svc');
    assert.strictEqual(ws.readState().child_repos[0].retry_count, 2);
  } finally { ws.destroy(); }
});
