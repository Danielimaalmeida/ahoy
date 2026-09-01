'use strict';
// agent sessions — a revision that remembers the earlier rounds.
//
// `copilot --resume=<id> --prompt` is one-shot: it answers with the earlier
// turns in context and returns to the shell. So the harness can drive a
// conversation instead of restarting one every round.
//
// The bash suite copied tick.sh's two helpers into the test file. These import
// them.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');
const session = require('../../bin/lib/session');
const derive = require('../../bin/lib/derive');

function sessWS() {
  const ws = newWorkspace();
  ws.writeState({ story_id: STORY, phase: 'planning' });
  return ws;
}

function withWS(fn) {
  const ws = sessWS();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('a story with no session yet reports none', () => {
  withWS((ws) => assert.strictEqual(session.idFor(ws.statePath, 'planning'), ''));
});

test('the session id is recorded against its phase', () => {
  withWS((ws) => {
    session.remember(ws.statePath, 'planning', 'abc-123');
    assert.strictEqual(session.idFor(ws.statePath, 'planning'), 'abc-123');
  });
});

// The fallback that keeps a pruned session from costing a round. Sessions live
// under ~/.copilot, outside the repo — they expire, and they do not follow you
// to another machine. Clearing the id must leave the story workable.
test('clearing a dead session falls back to a cold prompt, not a failure', () => {
  withWS((ws) => {
    session.remember(ws.statePath, 'planning', 'abc-123');
    session.remember(ws.statePath, 'planning', '');
    assert.strictEqual(session.idFor(ws.statePath, 'planning'), '');
  });
});

// Two phases can hold sessions independently.
test('each phase keeps its own session', () => {
  withWS((ws) => {
    session.remember(ws.statePath, 'planning', 'p-1');
    session.remember(ws.statePath, 'pr_review', 'r-1');
    assert.strictEqual(session.idFor(ws.statePath, 'planning'), 'p-1');
    assert.strictEqual(session.idFor(ws.statePath, 'pr_review'), 'r-1');
  });
});

// An unreadable state file must not throw: the id is an optimisation, and the
// plan on disk is the source of truth.
test('a missing state file reports no session rather than exploding', () => {
  assert.strictEqual(session.idFor('/nonexistent/state.json', 'planning'), '');
});

// --------------------------------------------------------------------------
// red CI routes back to implementation, it is not polled
// --------------------------------------------------------------------------
// A failing check used to be exit 1, the same code as "still running". With
// --wait the router polled a permanently red build until the budget ran out,
// printing the same two check names every thirty seconds. Nothing outside was
// ever going to turn it green: the code has to change. gates/child_ready.sh now
// returns 3 for that (gates-child-ready.test.js), and this is what the router
// does with it — done packages go back to pending WITH the gate's report
// attached, so the fixer is told what broke rather than left to rediscover it.

test('the failing repo reopens with the gate report attached', () => {
  const s = {
    work_packages: [
      { id: 'WP1', repo: 'svc', status: 'done' },
      { id: 'WP2', repo: 'web', status: 'done' },
    ],
    child_repos: [{ repo: 'svc', status: 'ready' }, { repo: 'web', status: 'ready' }],
  };
  derive.reopenRepoPackages(s, 'svc', 'PR #42 has failing check(s): lint');

  const wp = (id) => s.work_packages.find((w) => w.id === id);
  const repo = (r) => s.child_repos.find((x) => x.repo === r);

  assert.strictEqual(wp('WP1').status, 'pending', "the failing repo's package reopens");
  assert.strictEqual(wp('WP1').rework_note, 'PR #42 has failing check(s): lint',
    'with what the gate reported, so the fixer is not guessing');
  assert.strictEqual(repo('svc').status, 'in_progress', 'and the repository leaves ready');
  assert.strictEqual(wp('WP2').status, 'done', 'a repository whose build is green is left alone');
  assert.strictEqual(repo('web').status, 'ready');
});

// The counter resets, or the in_progress ceiling would fire on the fixer's
// first report and read as the ceiling working when it is refusing to let the
// rework happen at all.
test('reopening resets the in_progress round counter', () => {
  const s = {
    work_packages: [{ id: 'WP1', repo: 'svc', status: 'done', in_progress_rounds: 2 }],
    child_repos: [{ repo: 'svc', status: 'ready' }],
  };
  derive.reopenRepoPackages(s, 'svc', 'red build');
  assert.strictEqual(s.work_packages[0].in_progress_rounds, 0);
});

// Only `done` packages reopen. One still `pending` is already going to be
// dispatched, and overwriting its note would replace a live instruction.
test('a package that is not done is untouched', () => {
  const s = {
    work_packages: [{ id: 'WP1', repo: 'svc', status: 'pending', rework_note: 'fix the empty state' }],
    child_repos: [{ repo: 'svc', status: 'in_progress' }],
  };
  derive.reopenRepoPackages(s, 'svc', 'red build');
  assert.strictEqual(s.work_packages[0].rework_note, 'fix the empty state');
});
