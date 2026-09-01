#!/usr/bin/env node
'use strict';
// bin/run.js <JIRA-KEY> [--no-wait] [--no-agent] [--no-continue]
//
// The single entry point. Creates the story if it does not exist, then drives it
// until it reaches a human gate, a terminal phase, or a genuine stop.
//
//   bin/run.sh R3DA-14022                 # plans with you, stops at plan_review
//   bin/approve.sh R3DA-14022 plan        # implements, reviews, stops at delivery_gate
//   bin/approve.sh R3DA-14022 delivery    # done
//
// Three commands, two decisions. Both stops are decisions only a human can make:
// whether the plan covers the ticket, and whether this ships.
//
// RESUMABLE, NOT LONG-LIVED. Every re-run reads specs/<KEY>/state.json and
// continues from wherever the story actually is. Nothing is held in memory
// between runs, so a closed laptop or a dropped connection costs one command,
// not the story. That is why this is a script you re-run rather than a daemon
// you keep alive.
//
// Waiting is on by default: when a gate reports that CI is still running, this
// polls instead of exiting. --no-wait restores the old behaviour of stopping so
// you can re-run by hand.
//
// --no-continue does the state change and stops: it creates the story if it is
// missing, and never hands to the router. The UI runs this over HTTP, where a
// request that blocks for the length of an agent run is a request that times
// out; the browser then starts the router itself on a terminal it can stream.
// It is consumed here rather than forwarded, because tick does not know it
// and refuses options it does not know.
//
// Exit codes are bin/tick.js's, unchanged.

const fs = require('fs');
const path = require('path');
const { root, statePath, err, die } = require('./lib/cli');
const state = require('./lib/state');
const proc = require('./lib/proc');

const ROOT = root();

const argv = process.argv.slice(2);
const KEY = argv.shift() || '';
if (!KEY) {
  die(2,
    'usage: bin/run.sh <JIRA-KEY> [--no-wait] [--no-agent] [--no-continue]',
    '  e.g. bin/run.sh R3DA-14022');
}

let WAIT_ARG = ['--wait'];
let CONTINUE = true;
const PASS = [];
while (argv.length) {
  const a = argv.shift();
  if (a === '--no-wait') { WAIT_ARG = []; continue; }
  if (a === '--no-agent') { PASS.push('--no-agent'); continue; }
  if (a === '--no-continue') { CONTINUE = false; continue; }
  die(2, `unknown option: ${a}`);
}

const STATE = statePath(ROOT, KEY);

function handOff(script, args) {
  // The bash ended in `exec`. Node has no exec, so run with this terminal
  // inherited and exit on the child's code — which is the part callers depend
  // on, including bin/serve.py, which reads it over HTTP.
  const r = proc.run(process.execPath, [path.join(ROOT, 'bin', script), ...args]);
  process.exit(r.code);
}

if (!fs.existsSync(STATE)) {
  err(`[run ${KEY}] no story yet; creating it`);
  // start validates the key shape, runs preflight, writes state.json from the
  // template, and hands to tick. Passing the wait flag through means a brand-new
  // story gets the same polling behaviour as a resumed one.
  //
  // Under --no-continue there is no tick to configure, so the wait and agent
  // flags would be noise: start is being asked for the state file alone.
  if (!CONTINUE) handOff('start.js', [KEY, '--no-continue']);
  handOff('start.js', [KEY, ...WAIT_ARG, ...PASS]);
}

const story = state.readQuiet(STATE);
err(`[run ${KEY}] resuming at phase '${(story && story.phase) || '?'}'`);
if (!CONTINUE) {
  err(`[run ${KEY}] --no-continue, so stopping here.`);
  process.exit(0);
}
handOff('tick.js', [KEY, ...WAIT_ARG, ...PASS]);
