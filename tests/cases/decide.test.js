'use strict';
// bin/decide.sh — one writer for a stuck package, two front ends.
//
// The terminal menu and the web UI both resolve a stuck package. A decision
// written in two places drifts, which is the failure the single-writer rule for
// human_gates exists to prevent — so the menu calls this too.
//
// Three of these assertions were unreachable in the bash suite: `expect` deleted
// the sandbox, so the two cases after the first one ran `cd` into a directory
// that no longer existed. One exited 1, which happened to be the code it wanted,
// and reported a green line meaning "nothing ran". All three run here.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

function decideWS(patch) {
  const ws = newWorkspace();
  ws.installBin('decide');
  ws.writeState({
    story_id: STORY,
    phase: 'implementation',
    work_packages: [
      { id: 'WP1', repo: 'svc', agent: 'impl', status: 'done' },
      { id: 'WP2', repo: 'svc', agent: 'a11y', status: 'unverified', in_progress_rounds: 2 },
    ],
    child_repos: [{ repo: 'svc', status: 'in_progress' }],
  });
  if (patch) ws.patchState(patch);
  return ws;
}

function withWS(patch, fn) {
  const ws = decideWS(patch);
  try { return fn(ws); } finally { ws.destroy(); }
}

const pkg = (s, id) => s.work_packages.find((w) => w.id === id);
const repo = (s, name) => s.child_repos.find((r) => r.repo === name);

test('accepting a stuck package is recorded', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('decide.sh', STORY, 'WP2', 'accept').code, 0);
    const s = ws.readState();
    assert.strictEqual(pkg(s, 'WP2').status, 'done', 'the package is marked delivered');
    // Derived, not written once: a repo left in_progress with everything done is
    // how a story sat in implementation reporting not-yet forever.
    assert.strictEqual(repo(s, 'svc').status, 'ready', 'and the repository status is recomputed');
  });
});

test('retrying sends it round again', () => {
  withWS(null, (ws) => {
    const r = ws.bin('decide.sh', STORY, 'WP2', 'retry', '--', 'three elements share the #resizer reference');
    assert.strictEqual(r.code, 0);
    const s = ws.readState();
    assert.strictEqual(pkg(s, 'WP2').status, 'pending', 'the package reopens');
    assert.strictEqual(pkg(s, 'WP2').rework_note, 'three elements share the #resizer reference',
      "with the reason, which is what makes it the human's retry and not the agent's");
    // A package retried after hitting the ceiling would stall again on its first
    // report, which reads as the ceiling working when it is refusing to let the
    // decision take effect.
    assert.strictEqual(pkg(s, 'WP2').in_progress_rounds, 0, 'and the round counter reset');
  });
});

// Accepting must not leave the note behind: an instruction already carried out
// reads as fresh to the next agent.
test('accepting clears a stale rework note', () => {
  withWS((s) => { pkg(s, 'WP2').rework_note = 'old instruction'; }, (ws) => {
    assert.strictEqual(ws.bin('decide.sh', STORY, 'WP2', 'accept').code, 0);
    assert.strictEqual(pkg(ws.readState(), 'WP2').rework_note, undefined,
      'so the next dispatch is not handed an instruction already followed');
  });
});

test('a package that is not stuck is refused', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('decide.sh', STORY, 'WP1', 'accept').code, 1);
  });
});

test('an unknown package is refused', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('decide.sh', STORY, 'WP9', 'accept').code, 1);
  });
});

test('an action that is neither accept nor retry is a usage error', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('decide.sh', STORY, 'WP2', 'maybe').code, 2);
  });
});

// --list is what the UI calls to decide whether to render anything at all.
test('--list reports the stuck package as JSON', () => {
  withWS(null, (ws) => {
    const r = ws.bin('decide.sh', STORY, '--list');
    assert.strictEqual(r.code, 0);
    const listed = JSON.parse(r.stdout);
    assert.strictEqual(listed[0].id, 'WP2');
    assert.strictEqual(listed.length, 1, 'and only the stuck one');
  });
});
