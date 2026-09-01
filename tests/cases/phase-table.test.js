'use strict';
// knowledge/process/phases.tsv stays the state machine.
//
// The router READS this table; it does not reproduce it. Nothing in bin/
// hardcodes a phase name, an actor or a route — which is the property that lets
// the table be edited without editing the harness, and the reason
// bin/approve.js can resolve a gate nobody wrote into it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const table = require('../../bin/lib/table');
const { SRC_ROOT } = require('../lib/harness');

const TABLE = path.join(SRC_ROOT, 'knowledge', 'process', 'phases.tsv');
const rows = table.load(TABLE);

test('the real table parses into rows', () => {
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.phase && r.kind, `${r.phase}: has a phase and a kind`);
});

// The comment block at the top of the TSV documents the columns, and one of
// those comment lines IS the column header. Reading it as a row would put a
// phase called "# phase" into the state machine.
test('comment lines are not rows', () => {
  assert.ok(!rows.some((r) => r.phase.startsWith('#')));
});

test('every route names a phase that exists, or is a sentinel', () => {
  const names = new Set(rows.map((r) => r.phase));
  for (const r of rows) {
    for (const field of ['on_pass', 'on_branch', 'on_fail']) {
      const target = r[field];
      if (!target || target === '-' || target === 'stay') continue;
      assert.ok(names.has(target), `${r.phase}.${field} -> ${target} exists`);
    }
  }
});

// Only agent actors can be interactive; a bin/ actor owns its own I/O.
test('no bin/ actor is marked interactive', () => {
  for (const r of rows) {
    if (r.actor.startsWith('bin/')) {
      assert.strictEqual(r.interactive, 'no', `${r.phase} runs a harness script, which owns its own I/O`);
    }
  }
});

// `planning` is the only interactive phase. Everywhere else the actor runs
// under --no-ask-user, where a question becomes a silent denial rather than a
// prompt.
test('planning is the only interactive phase', () => {
  const interactive = rows.filter((r) => r.interactive === 'yes').map((r) => r.phase);
  assert.deepStrictEqual(interactive, ['planning']);
});

// on_fail for `planning` is `stay`, not `blocked`. An interactive planning
// session that ends without a plan is UNFINISHED, not failed — the human closed
// the terminal, or the agent ran out of turns mid-question. Routing that to a
// terminal phase throws away a session you can simply resume, and `blocked`
// needs a hand-edit to leave.
test('planning stays rather than blocking when it ends without a plan', () => {
  assert.strictEqual(table.rowFor(rows, 'planning').on_fail, 'stay');
});

test('every human row names a gate key, and no other row does', () => {
  for (const r of rows) {
    if (r.kind === 'human') assert.ok(r.human_gate_key && r.human_gate_key !== '-', `${r.phase}`);
    else assert.strictEqual(r.human_gate_key, '-', `${r.phase} has no human gate key`);
  }
});

// Whichever the operator types — the short name, the key, or the phase — the
// table decides what is real. A hardcoded list in approve.js would have to be
// edited for every new gate; this does not.
test('a human gate resolves from its short name, key and phase alike', () => {
  for (const r of table.humanRows(rows)) {
    const short = r.human_gate_key.replace(/_accepted$/, '');
    for (const alias of [short, r.human_gate_key, r.phase]) {
      assert.deepStrictEqual(table.resolveGate(rows, alias), { phase: r.phase, key: r.human_gate_key },
        `'${alias}' resolves to ${r.phase}`);
    }
  }
});

test('a name that is not a human gate resolves to nothing', () => {
  assert.strictEqual(table.resolveGate(rows, 'nonsense'), null);
  // A real phase that is not a human gate is still not approvable.
  assert.strictEqual(table.resolveGate(rows, 'implementation'), null);
});

// The producer is what revise.js sends a story back to. Derived from the table
// rather than hardcoded, so a reordered pipeline cannot silently send a
// revision to the wrong actor.
test('every human gate has a producer phase to send a revision back to', () => {
  for (const r of table.humanRows(rows)) {
    const producer = table.producerOf(rows, r.phase);
    assert.ok(producer, `${r.phase} has a producer`);
    assert.notStrictEqual(table.rowFor(rows, producer).kind, 'human');
  }
});

// tests/check-phase-table.sh asserts the prose doc and the TSV agree. This
// asserts the harness reads the same file that document projects to.
test('the router reads the TSV the prose table points at', () => {
  const doc = fs.readFileSync(
    path.join(SRC_ROOT, 'knowledge', 'process', 'delivery-phases.md'), 'utf8');
  assert.match(doc, /phases\.tsv/);
  for (const r of rows) {
    if (['done', 'blocked', 'rework'].includes(r.phase)) continue;
    assert.ok(doc.includes(`\`${r.phase}\``), `delivery-phases.md documents ${r.phase}`);
  }
});
