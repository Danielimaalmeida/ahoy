#!/usr/bin/env node
'use strict';
// bin/decide.js <STORY-ID> <WORK-PACKAGE-ID> <accept|retry> [-- <reason>]
// bin/decide.js <STORY-ID> --list
//
//   bin/decide.sh R3DA-13674 WP2 accept
//   bin/decide.sh R3DA-13674 WP2 retry -- "three elements share the #resizer template reference"
//
// Records a human decision about a STUCK WORK PACKAGE, without a terminal.
//
// WHY THIS EXISTS. A package in `unverified`, `stalled`, `blocked` or `failed`
// is never dispatched — dispatch only picks up `pending` — so the story cannot
// move until somebody decides. bin/tick.js offers that as a menu, which works
// at a terminal and nowhere else: the web UI shells out over HTTP, where a
// process that prompts on /dev/tty simply blocks until the request times out.
//
// So the decision gets a verb, the same way approve and revise did. The menu
// calls this; the UI calls this; a script can call this. One writer, several
// front ends — which is the property that stopped the delivery gate being
// walked around, applied to the other decision the harness asks for.
//
// `unverified` is the one that carries weight. It means the work may well be
// correct but a check could not run, so nobody has evidence. Accepting it is a
// real choice with a real cost. This command will not let that happen by
// accident: the package must genuinely be stuck, and `retry` without a reason
// is reported as the guess it is.
//
// Exit codes:
//   0 decision recorded
//   1 no such package, or it is not stuck
//   2 environment or usage error

const fs = require('fs');
const { root, statePath, makeLog, err, out, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const derive = require('./lib/derive');

const USAGE = [
  'usage: bin/decide.sh <STORY-ID> <WP-ID> <accept|retry> [-- <reason>]',
  '       bin/decide.sh <STORY-ID> --list',
];

const ROOT = root();
const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
if (!STORY_ID) die(2, ...USAGE);

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `decide: no state file at ${STATE}`);
if (!haveCommand('jq')) die(2, 'decide: jq is required');

const log = makeLog('decide', STORY_ID);
const story = state.read(STATE);

// --list is what a UI calls to decide whether to render anything at all. JSON on
// stdout, so it needs no parsing on the other side.
if (argv[0] === '--list') {
  out(JSON.stringify(derive.stuckPackages(story).map((w) => ({
    id: w.id,
    status: w.status,
    repo: w.repo,
    agent: w.agent,
    rework_note: w.rework_note || '',
    blocker_question: w.blocker_question || '',
    in_progress_rounds: w.in_progress_rounds || 0,
  })), null, 2));
  process.exit(0);
}

const WP_ID = argv.shift() || '';
const ACTION = argv.shift() || '';
if (!WP_ID || !ACTION) die(2, USAGE[0]);

let REASON = '';
while (argv.length) {
  const a = argv.shift();
  if (a === '--') { REASON = argv.shift() || ''; continue; }
  die(2, `unknown option: ${a}`);
}

if (ACTION !== 'accept' && ACTION !== 'retry') {
  die(2, `decide: action must be 'accept' or 'retry', not '${ACTION}'`);
}

// ------------------------------------------------ the package must be stuck
//
// Not merely present. Accepting a package that is already `done` is a no-op
// dressed as a decision; accepting one still `pending` would mark undelivered
// work as delivered. Both are refused, and the message says which it is —
// "not stuck" is not a useful thing to read on its own.
const pkg = derive.workPackages(story).find((w) => w.id === WP_ID);
if (!pkg) {
  err(`decide: ${STORY_ID} has no work package '${WP_ID}'.`);
  err('decide: packages in this story:');
  for (const w of derive.workPackages(story)) err(`  ${w.id}  ${derive.statusOf(w)}`);
  process.exit(1);
}

const current = derive.statusOf(pkg);
if (!derive.isStuck(current)) {
  err(`decide: ${WP_ID} is '${current}', which the harness can move on its own.`);
  err('decide: this command is for packages nothing can dispatch —');
  err('decide: unverified, stalled, blocked or failed.');
  if (current === 'done') {
    err(`decide: to reopen delivered work: bin/revise.sh ${STORY_ID} delivery -- "what is wrong"`);
  }
  process.exit(1);
}

// ------------------------------------------------------------------ record it
const ts = state.nowISO();
const newStatus = ACTION === 'accept' ? 'done' : 'pending';
const verb = ACTION === 'accept' ? 'accepted as delivered from' : 'sent round again from';
const summary = `${WP_ID} ${verb} '${current}'${REASON ? ': ' + REASON : ''}`;

// in_progress_rounds resets on any decision. Without it a package retried after
// hitting the ceiling stalls again on its first report, which reads as the
// ceiling working when it is actually refusing to let the human's decision have
// an effect.
//
// The rework note is REPLACED on retry and CLEARED on accept: a stale note is
// an instruction the next agent will read as fresh, and one already carried out
// is worse than none.
story.work_packages = derive.workPackages(story).map((w) => {
  if (w.id !== WP_ID) return w;
  const next = { ...w, status: newStatus, in_progress_rounds: 0 };
  if (ACTION === 'accept') delete next.rework_note;
  else if (REASON) next.rework_note = REASON;
  return next;
});
story.decision_log = [
  ...(story.decision_log || []),
  { timestamp: ts, actor: 'human', type: 'package_decision', summary },
];

// Recompute the repository's status, for the same reason bin/dispatch.js does:
// it is DERIVED from the packages, and a derived value left stale is how a story
// with everything done sat in `implementation` reporting not-yet.
derive.recomputeRepoStatuses(story);

try {
  state.write(STATE, story, 'decide');
} catch (e) {
  die(2, e instanceof state.StateWriteError ? e.message : `decide: ${e.message}`);
}

log(summary);

if (ACTION === 'retry' && !REASON) {
  log('no reason given — the agent will work out for itself what to change,');
  log('which is how a retry produces the same result a second time.');
  log(`next time: bin/decide.sh ${STORY_ID} ${WP_ID} retry -- "what to fix"`);
}

for (const r of story.child_repos || []) {
  err(`[decide] ${r.repo} -> ${r.status || '?'}`);
}
log(`run bin/run.sh ${STORY_ID} to continue`);
process.exit(0);
