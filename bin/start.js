#!/usr/bin/env node
'use strict';
// bin/start.js <JIRA-KEY> [--no-continue]
//
// Creates specs/<KEY>/state.json from the template and hands straight to
// bin/tick.js, so starting a story is one command.
//
// --no-continue creates the story and stops there instead of handing to tick.
// That is what the UI needs: it calls this over HTTP, and a request that blocks
// for the length of an agent run is a request that times out. The browser starts
// the router itself afterwards, on a terminal it can stream. Same flag, same
// meaning, as bin/approve.js and bin/revise.js.
//
// This is the "(no state file yet)" row of delivery-phases.md, minus the part
// that needs an agent. It checks the key's SHAPE, not that the issue exists —
// that needs a Jira call, which belongs to Navigator. A key that is well-formed
// but fictional produces a snapshot that gates/intake.sh rejects, so nothing
// reaches planning on an invented ticket.
//
// It refuses to touch an existing story. Resuming is `bin/tick.js <KEY>`.

const fs = require('fs');
const path = require('path');
const { root, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const proc = require('./lib/proc');

const ROOT = root();
const TEMPLATE = path.join(ROOT, 'knowledge', 'process', 'state.template.json');

const argv = process.argv.slice(2);
const KEY = argv.shift() || '';
if (!KEY) {
  die(2, 'usage: bin/start.sh <JIRA-KEY> [--no-continue]   e.g. bin/start.sh R3DA-14022');
}

let CONTINUE = true;
const PASS = [];
while (argv.length) {
  const a = argv.shift();
  if (a === '--no-continue') { CONTINUE = false; continue; }
  // Everything else belongs to tick, which is the authority on its own
  // options; forwarding them unread keeps this script out of that argument.
  PASS.push(a);
}

// The rule about what a Jira key looks like lives HERE, in one place. The
// browser deliberately does not validate it: a second opinion in JavaScript
// would eventually disagree with this one, and the refusal is written for a
// person to read.
if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(KEY)) {
  die(2,
    `start: '${KEY}' is not a Jira issue key (expected e.g. R3DA-14022).`,
    'start: this workspace never creates Jira stories; supply an existing key.');
}

// gates/*.sh are unchanged and every one of them needs jq, so a harness without
// it cannot enforce its gates — whatever language the router is written in.
if (!haveCommand('jq')) die(2, 'start: jq is required');
if (!fs.existsSync(TEMPLATE)) die(2, `start: template not found at ${TEMPLATE}`);

const STATE = path.join(ROOT, 'specs', KEY, 'state.json');
if (fs.existsSync(STATE)) {
  const existing = state.readQuiet(STATE);
  die(2,
    `start: ${KEY} already exists (phase: ${(existing && existing.phase) || '?'}).`,
    `start: to continue it, run: bin/tick.sh ${KEY}`);
}

// preflight before writing anything: a harness that cannot run its gates should
// not be creating stories it then cannot advance.
const GATES = path.join(ROOT, 'gates');
if (proc.runGate(GATES, 'preflight.sh', [], { capture: true }).code !== 0) {
  err('start: preflight failed; the harness cannot enforce its gates.');
  proc.runGate(GATES, 'preflight.sh', []);
  process.exit(2);
}

fs.mkdirSync(path.dirname(STATE), { recursive: true });
const template = state.read(TEMPLATE);
template.story_id = KEY;
template.phase = 'intake';
state.write(STATE, template, 'start');

process.stdout.write(`start: created ${STATE} at phase 'intake'\n`);
if (!CONTINUE) {
  process.stdout.write('start: story created; --no-continue, so stopping here.\n');
  process.exit(0);
}

// The bash ended in `exec`, replacing itself with the router. Node has no exec,
// so run the router with this terminal inherited and exit on its code — which
// is the part callers actually depend on.
const tick = proc.run(process.execPath, [path.join(ROOT, 'bin', 'tick.js'), KEY, ...PASS]);
process.exit(tick.code);
