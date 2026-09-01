'use strict';
// bin/credits.sh — bookkeeping that must never be able to stop a delivery.
//
// The bash suite did not cover this script at all. These are the properties its
// comments claim, which is the part worth holding onto through a port: a
// missing ledger is not a failure, the total is derived rather than
// accumulated, and a resumed session keeps the phase it was opened for.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

function creditsWS(patch) {
  const ws = newWorkspace();
  ws.installBin('credits');
  ws.writeState({ story_id: STORY, phase: 'implementation' });
  if (patch) ws.patchState(patch);
  return ws;
}

function withWS(patch, fn) {
  const ws = creditsWS(patch);
  try { return fn(ws); } finally { ws.destroy(); }
}

// The ledger is written by another process on its own schedule, and agents run
// where the CLI keeps no store at all. Stopping a delivery over that would be
// worse bookkeeping than having none.
test('a missing ledger is not a failure', () => {
  withWS(null, (ws) => {
    const r = ws.run(ws.path('bin', 'credits.sh'), [STORY, 'record', '--session', 'abc'], {
      env: { HARNESS_USAGE_DB: ws.path('nope.db') },
    });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /no usage ledger/);
  });
});

// A cwd sweep with no time floor would bill this story for every run that ever
// happened in that directory, including other stories' work in the same repo.
test('--cwd without --since is refused', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('credits.sh', STORY, 'record', '--cwd', '/tmp').code, 2);
  });
});

test('record needs --session or --cwd', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('credits.sh', STORY, 'record').code, 2);
  });
});

test('an unknown command is a usage error', () => {
  withWS(null, (ws) => {
    assert.strictEqual(ws.bin('credits.sh', STORY, 'sideways').code, 2);
  });
});

// `now` is passed straight back as --since, and the ledger compares timestamps
// as TEXT — so this must match its shape exactly rather than being any correct
// rendering of the same instant.
test('now prints the ledger timestamp shape, with milliseconds', () => {
  withWS(null, (ws) => {
    const r = ws.bin('credits.sh', STORY, 'now');
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout.trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  });
});

// A story whose spend predates the bookkeeping shows no panel at all rather
// than a fabricated zero, so `show --json` must report the empty shape.
test('a story with no credits shows the empty shape, not an error', () => {
  withWS(null, (ws) => {
    const r = ws.bin('credits.sh', STORY, 'show', '--json');
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), { total_aiu: 0, sessions: {} });
  });
});

test('show renders recorded sessions grouped by phase', () => {
  withWS((s) => {
    s.credits = {
      total_aiu: 4.25,
      sessions: {
        'a-1': { aiu: 3.0, phase: 'planning', actor: 'cartographer' },
        'b-2': { aiu: 1.25, phase: 'implementation', actor: 'backend-implementer' },
      },
    };
  }, (ws) => {
    const r = ws.bin('credits.sh', STORY, 'show');
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /story total: 4.3 AIU across 2 session\(s\)/);
    // Sorted by spend, so the expensive phase is the one you read first.
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[1], /planning/);
    assert.match(lines[2], /implementation/);
  });
});
