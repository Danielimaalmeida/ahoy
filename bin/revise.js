#!/usr/bin/env node
'use strict';
// bin/revise.js <STORY-ID> <gate> [--no-continue] [-- <reason>]
//
//   bin/revise.sh R3DA-13674 plan
//   bin/revise.sh R3DA-13674 plan -- "the frontend criteria miss the empty state"
//   bin/revise.sh R3DA-13674 delivery -- "manual testing: the divider jumps at the minimum"
//
// The last form works on a story already at `done`: manual testing found a bug.
//
// Sends a story BACK from a human gate to the phase that produced the artifact,
// so you can change it interactively instead of only saying yes or no.
//
// WHY. `plan_review` was a one-way gate: approve and the plan is final, reject
// and the story lands in `blocked`, which needs a hand-edit to leave. But the
// thing under review is a file, and the agent that wrote it can be run again.
// Rejecting a plan you want changed by 10% was the wrong shape.
//
// What it does, and the order matters:
//
//   1. Clears any recorded decision at the gate. A plan revised after approval
//      is exactly the case the approval timestamp exists to catch — leaving a
//      stale `approved` in place would let the next tick walk a changed plan
//      straight past the gate on a decision made about the old one.
//   2. Increments a revision counter and refuses past a ceiling.
//   3. Sets the phase back and logs the round.
//   4. Re-runs the loop, which re-runs the actor interactively and re-gates.
//
// The plan file is left alone. Cartographer sees its own previous work and
// revises it; this is a revision, not a restart.
//
// THE CEILING. Like gates/rework_ceiling.sh, and for the same reason. A plan
// that has not converged after several interactive rounds is not going to
// converge on the next one — something upstream is wrong, usually the ticket,
// and going round again just costs another session. Default 4; override with
// `.revision_ceiling` in state.json.
//
// Exit codes:
//   0 phase reset (and the loop continued, unless --no-continue)
//   1 the story is not at that gate, or the revision ceiling is reached
//   2 environment or usage error

const fs = require('fs');
const path = require('path');
const { root, statePath, tablePath, makeLog, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const table = require('./lib/table');
const derive = require('./lib/derive');
const proc = require('./lib/proc');

const ROOT = root();
const TABLE = tablePath(ROOT);

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
const GATE_ARG = argv.shift() || '';
if (!STORY_ID || !GATE_ARG) {
  die(2, 'usage: bin/revise.sh <STORY-ID> <plan|delivery> [--no-continue]');
}

let CONTINUE = true;
let REASON = '';
while (argv.length) {
  const a = argv.shift();
  if (a === '--no-continue') { CONTINUE = false; continue; }
  if (a === '--') { REASON = argv.shift() || ''; continue; }
  die(2, `unknown option: ${a}`);
}

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `revise: no state file at ${STATE}`);
if (!fs.existsSync(TABLE)) die(2, `revise: no phase table at ${TABLE}`);
if (!haveCommand('jq')) die(2, 'revise: jq is required');

const log = makeLog('revise', STORY_ID);

// ----------------------------------------- resolve the gate from the table
const rows = table.load(TABLE);
const resolved = table.resolveGate(rows, GATE_ARG);
if (!resolved) {
  err(`revise: '${GATE_ARG}' is not a human gate in ${TABLE}`);
  for (const r of table.humanRows(rows)) err(`  ${r.human_gate_key}  (phase ${r.phase})`);
  process.exit(2);
}
const { phase: gatePhase, key: gateKey } = resolved;

// ---------------------------------------- what phase produced the artifact
// The phase whose on_pass leads to this gate. Derived from the table rather than
// hardcoded, so a reordered pipeline does not silently send a revision to the
// wrong actor.
let producer = table.producerOf(rows, gatePhase);
if (!producer) {
  die(2,
    `revise: no phase in ${TABLE} routes to '${gatePhase}' on pass,`,
    'revise: so there is nothing to send this story back to.');
}
const producerRow = table.rowFor(rows, producer) || {};
const interactive = producerRow.interactive || '';
const actor = producerRow.actor || '';

// -------------------------------------------------- the story must be there
const story = state.read(STATE);
const phase = story.phase || '';
if (!phase) die(2, 'revise: state.json has no .phase');

// A story that has been ACCEPTED can still be sent back.
//
// "I tested it and found a bug" is the most ordinary thing that happens to a
// delivery, and there was no verb for it: `done` is terminal, so revise refused,
// and reopening meant five lines of jq pasted from a chat window.
//
// Reopening a delivered story is a bigger step than revising one under review —
// a pull request exists and may be merged — so it is named rather than implied,
// and the recorded approval is cleared like any other.
let reopened = false;
if (phase !== gatePhase) {
  const gateRow = table.rowFor(rows, gatePhase) || {};
  const terminalAfter = gateRow.on_pass || '';
  if (phase === terminalAfter && terminalAfter) {
    reopened = true;
    log(`${STORY_ID} is '${phase}'; reopening it`);
  } else {
    err(`revise: ${STORY_ID} is at phase '${phase}', not '${gatePhase}'.`);
    err('revise: there is nothing under review to revise.');
    if (terminalAfter) {
      err(`revise: this gate can be revised at '${gatePhase}', or reopened from '${terminalAfter}'.`);
    }
    process.exit(1);
  }
}

// ------------------------------------------------------------- the ceiling
const ceiling = story.revision_ceiling ?? 4;
const rounds = (story.revisions || {})[gateKey] ?? 0;
const nextRound = rounds + 1;

if (rounds >= ceiling) {
  die(1,
    `revise: ${gateKey} has already been revised ${rounds} time(s), at the ceiling of ${ceiling}.`,
    `revise: a plan that has not converged in ${rounds} interactive rounds is`,
    'revise: usually telling you something upstream is wrong — most often the',
    'revise: ticket itself. Another round costs a session and changes little.',
    'revise: fix the ticket and start a new story, approve what you have, or',
    `revise: raise .revision_ceiling in ${STATE} deliberately.`);
}

// ------------------------------------------------------------------- do it
const ts = state.nowISO();

// The decision is CLEARED, not left in place. This is the whole safety property:
// an approval records a judgement about a specific artifact, and the artifact is
// about to change. Leaving `approved` behind would let the next tick carry a
// revised plan past the gate on a decision nobody made about it.
const gates = { ...(story.human_gates || {}) };
delete gates[gateKey];
story.human_gates = gates;
story.revisions = { ...(story.revisions || {}), [gateKey]: nextRound };
story.revision_reason = REASON;
story.phase = producer;
story.decision_log = [
  ...(story.decision_log || []),
  {
    timestamp: ts,
    actor: 'human',
    type: 'revision',
    summary: `${gateKey} sent back to ${producer} for revision, round ${nextRound}`
      + (REASON ? `: ${REASON}` : ''),
  },
];

// Reopening from a terminal phase means the delivered work itself is wrong, so
// the packages that produced it go back to `pending` with the reason attached.
// Revising at the gate does not: the artifact under review has not been built
// yet, and the producer phase rebuilds it.
if (reopened && producer === 'pr_review') {
  story.work_packages = derive.workPackages(story).map((w) =>
    (w.status || '') === 'done'
      ? { ...w, status: 'pending', in_progress_rounds: 0, ...(REASON ? { rework_note: REASON } : {}) }
      : w);
  story.child_repos = (story.child_repos || []).map((r) => ({ ...r, status: 'in_progress' }));
  producer = 'implementation';
  story.phase = producer;
  log('delivered work packages reopened; going back to implementation');
}

try {
  state.write(STATE, story, 'revise');
} catch (e) {
  die(2, e instanceof state.StateWriteError ? e.message : `revise: ${e.message}`);
}

log(`revision round ${nextRound} of ${ceiling}`);
if (REASON) log(`reason: ${REASON}`);
log(`cleared human_gates.${gateKey} — the artifact is changing, so the decision about it no longer holds`);
log(`phase -> ${producer}`);

if (interactive === 'yes') {
  log(`'${producer}' is interactive: ${actor} will get this terminal.`);
  log('Its previous work is still on disk — tell it what to change, not what to build.');
}

// A revision with no reason is how the agent ends up improving the plan by its
// own judgement instead of yours. That happened: sent back with the same prompt
// as a first run, Cartographer rewrote the plan without asking anything, because
// nothing told it there was a human with an opinion waiting.
if (!REASON) {
  log('no reason given — the agent will revise on its own judgement, not yours.');
  log(`next time: bin/revise.sh ${STORY_ID} ${GATE_ARG} -- "what should change"`);
}

if (!CONTINUE) {
  log('phase reset; --no-continue, so stopping here.');
  process.exit(0);
}

log('continuing the loop');
const tick = proc.run(process.execPath, [path.join(ROOT, 'bin', 'tick.js'), STORY_ID, '--wait']);
process.exit(tick.code);
