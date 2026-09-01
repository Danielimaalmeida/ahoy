#!/usr/bin/env node
'use strict';
// bin/approve.js <STORY-ID> <gate> [--reject [reason]] [--no-continue]
//
// Records a human decision at a human gate, then continues the loop.
//
//   bin/approve.sh R3DA-13709 plan
//   bin/approve.sh R3DA-13709 delivery
//   bin/approve.sh R3DA-13709 plan --reject "AC coverage is incomplete"
//
// <gate> is the short name: `plan` for plan_accepted, `delivery` for
// delivery_accepted. The full key works too. The mapping is derived from
// knowledge/process/phases.tsv rather than hardcoded here, so a new human gate
// added to the table is approvable without editing this script.
//
// WHY THIS EXISTS. Before it, approving meant hand-editing state.json with jq,
// and hand-editing is how R3DA-13709 reached `done` without its delivery gate
// ever opening: a bare `true` was written where an object was expected, the
// router correctly refused it, and the phase was then set directly. The gate did
// its job and was walked around. One writer, one shape, and that stops being
// possible.
//
// The gate is checked BEFORE the decision is written. Approving delivery for a
// story still in planning is an error, not a field set early — an approval that
// predates the thing it approves is not evidence of anything.
//
// Exit codes:
//   0 decision recorded (and the loop continued, unless --no-continue)
//   1 the story is not at that gate, or the decision was already recorded
//   2 environment or usage error

const fs = require('fs');
const path = require('path');
const { root, statePath, tablePath, makeLog, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const table = require('./lib/table');
const proc = require('./lib/proc');

const ROOT = root();
const TABLE = tablePath(ROOT);

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
const GATE_ARG = argv.shift() || '';
if (!STORY_ID || !GATE_ARG) {
  die(2, 'usage: bin/approve.sh <STORY-ID> <plan|delivery> [--reject [reason]] [--no-continue]');
}

let REJECT = false;
let REASON = '';
let CONTINUE = true;
while (argv.length) {
  const a = argv.shift();
  if (a === '--reject') {
    REJECT = true;
    // An optional positional reason, but only if it is not itself a flag.
    if (argv.length && !argv[0].startsWith('--')) REASON = argv.shift();
  } else if (a === '--no-continue') {
    CONTINUE = false;
  } else {
    die(2, `unknown option: ${a}`);
  }
}

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `approve: no state file at ${STATE}`);
if (!fs.existsSync(TABLE)) die(2, `approve: no phase table at ${TABLE}`);
if (!haveCommand('jq')) die(2, 'approve: jq is required');

const log = makeLog('approve', STORY_ID);

// ----------------------------------------- resolve the gate from the table
const rows = table.load(TABLE);
const resolved = table.resolveGate(rows, GATE_ARG);
if (!resolved) {
  err(`approve: '${GATE_ARG}' is not a human gate in ${TABLE}`);
  err('approve: known gates:');
  for (const r of table.humanRows(rows)) err(`  ${r.human_gate_key}  (phase ${r.phase})`);
  process.exit(2);
}
const { phase: gatePhase, key: gateKey } = resolved;

// -------------------------------------------------- the story must be there
const story = state.read(STATE);
const phase = story.phase || '';
if (!phase) die(2, 'approve: state.json has no .phase');

if (phase !== gatePhase) {
  err(`approve: ${STORY_ID} is at phase '${phase}', not '${gatePhase}'.`);
  err('approve: refusing to record a decision for a gate the story has not reached.');
  if (phase === 'done' || phase === 'blocked') {
    err('approve: the story is already at a terminal phase.');
  } else {
    err(`approve: run  bin/run.sh ${STORY_ID}  to advance it.`);
  }
  process.exit(1);
}

// An existing decision is not overwritten. Re-approving after a rejection is a
// real thing a human might want, but it should be a deliberate edit with a
// reason attached, not a repeated command that quietly replaces the record.
//
// `pending` is not a decision. It is a placeholder meaning nobody has decided
// yet, which is precisely the state this command exists to leave — so it counts
// as empty rather than as something to protect.
//
// Agents write it despite their profiles forbidding any write to human_gates,
// and treating it as an existing decision made the harness refuse its own gate:
// `already recorded as 'pending'`, at both gates, on the one story that got
// this far. Two hand-edits to approve something nobody had approved.
const raw = (story.human_gates || {})[gateKey];
let existing = '';
if (raw === undefined || raw === null) {
  existing = '';
} else if (typeof raw === 'object' && !Array.isArray(raw)) {
  const s = raw.status || '';
  existing = s === 'pending' ? '' : s;
} else {
  existing = 'malformed';
}
if (existing) {
  err(`approve: human_gates.${gateKey} is already recorded as '${existing}'.`);
  err(`approve: not overwriting. Edit ${STATE} deliberately if that is what you mean.`);
  process.exit(1);
}

// -------------------------------------------------------------- record it
const status = REJECT ? 'rejected' : 'approved';
const logType = REJECT ? 'human_rejection' : 'human_approval';
const ts = state.nowISO();

// The object shape is the contract's: {status, timestamp}. The timestamp is the
// half a boolean cannot carry, and rework is where that matters — a plan
// approved three rounds of change ago is not self-evidently still approved.
story.human_gates = {
  ...(story.human_gates || {}),
  [gateKey]: { status, timestamp: ts, ...(REASON ? { reason: REASON } : {}) },
};
story.decision_log = [
  ...(story.decision_log || []),
  {
    timestamp: ts,
    actor: 'human',
    type: logType,
    summary: `${gateKey} ${status} at phase ${gatePhase}${REASON ? ': ' + REASON : ''}`,
  },
];

// A rejection has no route in the phase table — every human row lists only an
// on_pass. Send it to `blocked`, which is honest: a human stopped this, and a
// human decides what happens next.
if (REJECT) story.phase = 'blocked';

try {
  state.write(STATE, story, 'approve');
} catch (e) {
  die(2, e instanceof state.StateWriteError ? e.message : `approve: ${e.message}`);
}

log(`human_gates.${gateKey} = ${status} at ${ts}`);

if (REJECT) {
  log(`phase -> blocked (${gateKey} rejected)`);
  if (REASON) log(`reason: ${REASON}`);
  process.exit(0);
}

if (!CONTINUE) {
  log('decision recorded; --no-continue, so stopping here.');
  process.exit(0);
}

log('continuing the loop');
const tick = proc.run(process.execPath, [path.join(ROOT, 'bin', 'tick.js'), STORY_ID, '--wait']);
process.exit(tick.code);
