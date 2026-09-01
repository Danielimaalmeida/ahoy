'use strict';
// state.json keeps its exact shape.
//
// A running story must survive the port with no migration. The file is the
// control flow — not an agent's conversation history — which is why a story
// survives a crashed session, a closed laptop, or a week's gap. Rewriting its
// shape would have meant every in-flight delivery needing a hand edit before it
// could be resumed.
//
// jq wrote this file with a two-space indent and a trailing newline. So do we.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { newWorkspace, SRC_ROOT } = require('../lib/harness');
const state = require('../../bin/lib/state');

function withWS(fn) {
  const ws = newWorkspace();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('a round trip through the writer is byte-identical to jq', () => {
  withWS((ws) => {
    const original = path.join(SRC_ROOT, 'knowledge', 'process', 'state.example.json');
    const p = ws.path('rt.json');
    fs.copyFileSync(original, p);
    // jq '.' is the canonical formatting every previous writer produced.
    const viaJq = execFileSync('jq', ['.', p], { encoding: 'utf8' });
    state.write(p, state.read(p));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), viaJq);
  });
});

test('key order is preserved, so a diff shows only what changed', () => {
  withWS((ws) => {
    const p = ws.path('order.json');
    fs.writeFileSync(p, '{"story_id":"X","phase":"intake","plan_path":null,"rework_ceiling":3}\n');
    const s = state.read(p);
    s.phase = 'planning';
    state.write(p, s);
    assert.deepStrictEqual(Object.keys(state.read(p)),
      ['story_id', 'phase', 'plan_path', 'rework_ceiling']);
  });
});

test('every real story in specs/ round-trips unchanged', () => {
  const specs = path.join(SRC_ROOT, 'specs');
  const stories = fs.readdirSync(specs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(specs, d.name, 'state.json'))
    .filter((p) => fs.existsSync(p));
  assert.ok(stories.length > 0, 'there are stories to check');
  for (const storyPath of stories) {
    const viaJq = execFileSync('jq', ['.', storyPath], { encoding: 'utf8' });
    assert.strictEqual(state.serialise(state.read(storyPath)), viaJq,
      `${storyPath} survives the port with no migration`);
  }
});

// The timestamp every writer in this harness uses, and the one gates/lib.sh
// produces with `date -u +%Y-%m-%dT%H:%M:%SZ`. Not cosmetic: gate_results
// entries written by the bash gates sit in the same array as entries written
// here, and credits.js compares ledger timestamps as text.
test('timestamps match the shape the bash gates write', () => {
  assert.match(state.nowISO(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// A half-written state.json is a story the router can no longer read. The
// write goes to a temp file beside the original and is renamed over it, so a
// crash mid-write leaves the previous version intact.
test('a failed write leaves the original untouched', () => {
  withWS((ws) => {
    const p = ws.path('guard.json');
    const before = '{\n  "phase": "planning"\n}\n';
    fs.writeFileSync(p, before);
    const circular = { phase: 'x' };
    circular.self = circular;
    assert.throws(() => state.write(p, circular, 'test'), /refused to write invalid state/);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
  });
});

test('the temp file does not survive a refused write', () => {
  withWS((ws) => {
    const p = ws.path('leak.json');
    fs.writeFileSync(p, '{}\n');
    const circular = {};
    circular.self = circular;
    try { state.write(p, circular, 'test'); } catch { /* expected */ }
    const strays = fs.readdirSync(ws.dir).filter((f) => f.includes('leak.json.'));
    assert.deepStrictEqual(strays, []);
  });
});

// updateQuiet is the bookkeeping path: it must never be able to stop a
// delivery, so a failure is reported as false rather than thrown.
test('a quiet update reports failure instead of throwing', () => {
  assert.strictEqual(state.updateQuiet('/nonexistent/state.json', (s) => s), false);
});
