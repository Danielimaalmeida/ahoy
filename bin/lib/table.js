'use strict';
// knowledge/process/phases.tsv — the state machine.
//
// This file is READ, never reproduced. The phase names, their actors, their
// gates and their routes live in the TSV; nothing here hardcodes a phase.
// delivery-phases.md stays authoritative for humans, and
// tests/check-phase-table.sh fails if the two disagree.
//
// Columns, in order (the header comment in the TSV itself is the reference):
//   1 phase  2 kind  3 actor  4 gate  5 on_pass  6 on_branch  7 on_fail
//   8 human_gate_key  9 log  10 interactive

const fs = require('fs');

const COLUMNS = [
  'phase', 'kind', 'actor', 'gate', 'on_pass',
  'on_branch', 'on_fail', 'human_gate_key', 'log', 'interactive',
];

function parse(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    // `$0 !~ /^#/` in the awk this replaces: comment lines carry the column
    // documentation, and one of them is the column header itself.
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (!fields[0]) continue;
    const row = {};
    COLUMNS.forEach((name, i) => { row[name] = fields[i] ?? ''; });
    // The TSV's last column is sometimes absent on a short line; `no` is the
    // safe default, because an actor wrongly marked interactive would hand the
    // terminal to an agent nobody is sitting in front of.
    row.interactive = row.interactive || 'no';
    rows.push(row);
  }
  return rows;
}

function load(tablePath) {
  return parse(fs.readFileSync(tablePath, 'utf8'));
}

function rowFor(rows, phase) {
  return rows.find((r) => r.phase === phase) || null;
}

// Every human-gate row, for the callers that resolve a gate name against the
// table rather than against a list of their own.
function humanRows(rows) {
  return rows.filter((r) => r.kind === 'human');
}

// Accept the short name (`plan`), the key (`plan_accepted`), or the phase
// (`plan_review`). Whichever the operator types, the table decides what is
// real — so a new human gate added to the TSV is approvable without editing
// approve.js or revise.js.
function resolveGate(rows, arg) {
  for (const r of humanRows(rows)) {
    if (r.human_gate_key === arg || r.human_gate_key === `${arg}_accepted` || r.phase === arg) {
      return { phase: r.phase, key: r.human_gate_key };
    }
  }
  return null;
}

// The phase whose on_pass leads to this gate — i.e. what produced the artifact
// under review. Derived from the table rather than hardcoded, so a reordered
// pipeline cannot silently send a revision to the wrong actor.
function producerOf(rows, gatePhase) {
  const r = rows.find((x) => x.on_pass === gatePhase && x.kind !== 'human');
  return r ? r.phase : '';
}

module.exports = { COLUMNS, parse, load, rowFor, humanRows, resolveGate, producerOf };
