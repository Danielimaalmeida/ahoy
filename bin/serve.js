#!/usr/bin/env node
'use strict';
// bin/serve.js — the browser version of Ahoy's terminal menu.
//
// Reads specs/*/state.json and knowledge/process/phases.tsv. It writes neither.
// Every human decision goes through bin/approve.sh or bin/revise.sh, which are
// the single writer of state.json — see README, "Delivery state".
//
// Node standard library only. Localhost only. Single user, no auth.
//
// THE INTERACTIVE SESSION NEEDS A REAL TERMINAL, because that is the interface
// the agent already has: phases.tsv marks `planning` interactive precisely so
// cartographer can ask questions, and tick.js runs it without capturing output.
// A pipe would make it look unattended, and under --no-ask-user an unanswerable
// question becomes a silent denial rather than a prompt.
//
// Node's standard library has no pty. `script(1)` does, it is POSIX and present
// on both macOS and Linux, and a child under it reports `isTTY: true` — so the
// terminal panel survives the port with no native dependency. See `Session`.

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const table = require('./lib/table');

const ROOT = path.resolve(__dirname, '..');
const SPECS = path.join(ROOT, 'specs');
const WEB = path.join(ROOT, 'web');
const TABLE = path.join(ROOT, 'knowledge', 'process', 'phases.tsv');
const APPROVE = path.join(ROOT, 'bin', 'approve.sh');
const REVISE = path.join(ROOT, 'bin', 'revise.sh');
const RUN = path.join(ROOT, 'bin', 'run.sh');

// A story id becomes a path segment under specs/. Anything outside this set is
// refused before it reaches the filesystem or an argv.
const STORY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The router. AHOY_TICK points the session at a stand-in instead — useful for
// trying the interactive panel before the real router is wired up.
const TICK = process.env.AHOY_TICK || path.join(ROOT, 'bin', 'tick.sh');

const SCRIPT_TIMEOUT = 60_000;      // ms; --no-continue means these return promptly
const SESSION_IDLE_POLL = 20_000;   // ms between SSE heartbeats while the agent thinks

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --------------------------------------------------------------- phase table

// Read on every request rather than cached: the table is nine lines, and a UI
// that shows a stale pipeline after someone edits the table is worse than one
// that re-reads it. The parser is bin/lib/table.js — the same one the router
// uses, so the page and the harness cannot disagree about what a phase is.
function loadTable() {
  try {
    return table.load(TABLE);
  } catch {
    return [];
  }
}

// The phases a story passes through on the happy path, in order.
//
// Walked from the first row by following on_pass, so `rework` (reached only by
// a gate branching) and `blocked` (reached only by a failure) stay off the
// strip, and a reordered table reorders the UI without a code change.
function mainline(rows) {
  if (rows.length === 0) return [];
  const byPhase = new Map(rows.map((r) => [r.phase, r]));
  const order = [];
  const seen = new Set();
  let cur = rows[0].phase;
  while (cur && cur !== '-' && byPhase.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    cur = byPhase.get(cur).on_pass || '';
  }
  return order;
}

// The phases only a human can move, keyed by phase.
function humanGates(rows) {
  const gates = {};
  for (const r of rows) {
    if (r.kind !== 'human' || !r.human_gate_key || r.human_gate_key === '-') continue;
    const key = r.human_gate_key;
    gates[r.phase] = {
      phase: r.phase,
      key,
      // `plan_accepted` -> `plan`, the short name the scripts document
      short: key.endsWith('_accepted') ? key.slice(0, -'_accepted'.length) : key,
    };
  }
  return gates;
}

function terminalPhases(rows) {
  return rows.filter((r) => r.kind === 'terminal').map((r) => r.phase);
}

// -------------------------------------------------------------------- stories

// Validated path to a story's state.json, or null.
function storyStatePath(storyId) {
  if (!STORY_RE.test(storyId || '')) return null;
  const p = path.resolve(SPECS, storyId, 'state.json');
  if (!isInside(p, SPECS)) return null;
  return isFile(p) ? p : null;
}

function isInside(target, dir) {
  const rel = path.relative(path.resolve(dir), target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readState(storyId) {
  const p = storyStatePath(storyId);
  if (p === null) return [null, null];
  try {
    return [JSON.parse(fs.readFileSync(p, 'utf8')), null];
  } catch (e) {
    // A malformed state.json is worth showing, not hiding behind a 500.
    return [null, e.message];
  }
}

const asList = (v) => (Array.isArray(v) ? v : []);

// Every timestamp a story carries, so the list can show a real `updated`.
function collectTimestamps(state) {
  const stamps = [];
  for (const entry of [...asList(state.gate_results), ...asList(state.decision_log)]) {
    if (entry && typeof entry === 'object' && typeof entry.timestamp === 'string') {
      stamps.push(entry.timestamp);
    }
  }
  const gates = state.human_gates;
  if (gates && typeof gates === 'object' && !Array.isArray(gates)) {
    for (const gate of Object.values(gates)) {
      if (gate && typeof gate === 'object' && typeof gate.timestamp === 'string') {
        stamps.push(gate.timestamp);
      }
    }
  }
  return stamps;
}

// The recorded decision at a gate, or null.
//
// approve.sh writes {status, timestamp}; anything else in that slot is the
// hand-edit the script exists to prevent, so it is reported as malformed rather
// than coerced into looking like a decision.
function gateDecision(state, key) {
  const gates = state.human_gates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates) || !(key in gates)) return null;
  const value = gates[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const status = value.status;
    // `pending` is the template's placeholder for "nobody has decided yet",
    // which is the opposite of a recorded decision. bin/approve.js draws exactly
    // this distinction — see the comment above its `existing` check, written
    // after the same confusion cost two hand-edits — and this has to agree with
    // it. Reporting it as a decision makes the panel say "already recorded",
    // then disable every button on a gate nobody has touched, which locks the
    // story out of the UI that exists to decide it.
    if (status === undefined || status === null || status === '' || status === 'pending') return null;
    return { status, timestamp: value.timestamp ?? null, reason: value.reason ?? null };
  }
  return { status: 'malformed', timestamp: null, reason: null };
}

// The human gate a terminal `phase` was reached through, or null.
//
// revise.sh calls this reopening, and it is the ordinary case rather than an
// exotic one: `done` is terminal, but "I tested it and found a bug" is the most
// common thing that happens to a delivery. The gate that passed the story into
// `done` can therefore take it back.
//
// Derived from on_pass rather than named, exactly as the script derives it, so
// a reordered table cannot leave this offering rework on a phase revise.js
// would refuse. Returns null at every non-terminal phase — a story still at a
// live gate is sent back through the decision panel, not reopened.
function reopenableGate(rows, gatesByPhase, phase) {
  if (!terminalPhases(rows).includes(phase)) return null;
  for (const row of rows) {
    if (row.phase in gatesByPhase && row.on_pass === phase) return gatesByPhase[row.phase];
  }
  return null;
}

function summarise(storyId, state, gatesByPhase, order) {
  const phase = state.phase || 'unknown';
  const gate = gatesByPhase[phase] || null;
  const decided = gate ? gateDecision(state, gate.key) : null;
  const stamps = collectTimestamps(state);
  return {
    story_id: state.story_id || storyId,
    dir: storyId,
    phase,
    title: state.title ?? null,
    criteria_count: asList(state.acceptance_criteria).length,
    updated: stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null,
    // Awaiting a human means: at a human phase, with nothing recorded yet.
    awaiting: Boolean(gate && decided === null),
    gate,
    phase_index: order.indexOf(phase) === -1 ? order.length : order.indexOf(phase),
  };
}

function listStories() {
  const rows = loadTable();
  const order = mainline(rows);
  const gatesByPhase = humanGates(rows);
  const terminal = new Set(terminalPhases(rows));

  const stories = [];
  const broken = [];
  if (isDir(SPECS)) {
    for (const name of fs.readdirSync(SPECS).sort()) {
      const dir = path.join(SPECS, name);
      if (!isDir(dir) || !isFile(path.join(dir, 'state.json'))) continue;
      const [state, error] = readState(name);
      if (state === null) {
        broken.push({ dir: name, error: error || 'unreadable' });
        continue;
      }
      stories.push(summarise(name, state, gatesByPhase, order));
    }
  }

  // Anything a human is holding up comes first — those are the only ones that
  // need something. Then live work in pipeline order, then finished.
  stories.sort((a, b) =>
    (a.awaiting ? 0 : 1) - (b.awaiting ? 0 : 1)
    || (terminal.has(a.phase) ? 1 : 0) - (terminal.has(b.phase) ? 1 : 0)
    || a.phase_index - b.phase_index
    || a.story_id.localeCompare(b.story_id));

  return { stories, unreadable: broken };
}

function readStory(storyId) {
  const [state, error] = readState(storyId);
  if (state === null) return [null, error];

  const rows = loadTable();
  const gatesByPhase = humanGates(rows);
  const phase = state.phase || 'unknown';
  const gate = gatesByPhase[phase] || null;
  // Only one of the two is ever set: `gate` is a decision waiting to be made,
  // `reopen` is one already made that can be taken back.
  const reopen = gate === null ? reopenableGate(rows, gatesByPhase, phase) : null;
  const counted = gate || reopen;

  const plan = { path: state.plan_path ?? null, text: null, error: null };
  if (typeof plan.path === 'string' && plan.path) Object.assign(plan, readRepoText(plan.path));

  const ticket = { path: `specs/${storyId}/jira-source.md`, text: null, error: null };
  Object.assign(ticket, readRepoText(ticket.path));

  // Whether a router is attached to this story right now. The page needs it to
  // decide whether to offer to continue a stalled story: offering that while one
  // is already running would start a second router over the same specs
  // directory, and the two would fight over state.json.
  const live = sessionFor(storyId);

  return [{
    story_id: state.story_id || storyId,
    dir: storyId,
    state,
    plan,
    ticket,
    gate,
    reopen,
    running: Boolean(live && !live.closed),
    decision: gate ? gateDecision(state, gate.key) : null,
    // Counted against whichever gate is in play, so reopening a delivered story
    // is bounded by the same ceiling revise.js enforces rather than appearing to
    // start from zero.
    revisions_used: counted ? ((state.revisions || {})[counted.key] || 0) : 0,
    revision_ceiling: state.revision_ceiling ?? 4,
  }, null];
}

// Read a repo-relative text file. Never escapes the repository.
function readRepoText(relPath) {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    return { error: 'path outside the repository' };
  }
  const p = path.resolve(ROOT, relPath);
  if (!isInside(p, ROOT)) return { error: 'path outside the repository' };
  if (!isFile(p)) return { error: 'not found' };
  try {
    return { text: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { error: e.message };
  }
}

// -------------------------------------------------------------------- actions

// Map whatever the client sent to a human_gate_key from the table.
//
// The table decides what is real, exactly as the scripts do — the client cannot
// name a gate the process does not have.
function resolveGate(gateArg) {
  const resolved = table.resolveGate(loadTable(), gateArg || '');
  return resolved ? resolved.key : null;
}

// Run one of the decision scripts and report exactly what it said.
//
// Exit code and stderr are returned untouched. A refusal (1) is information:
// the script explains itself, and the explanation is the useful part.
//
// The .sh shim is invoked rather than the .js behind it, deliberately. The
// `command` string in the response is what the page shows the operator, and it
// has to be a thing they can paste — which is the name every runbook uses.
function runScript(script, args) {
  const display = ['bin/' + path.basename(script), ...args].join(' ');
  if (!isFile(script)) {
    return { exit_code: 2, stdout: '', stderr: `${script} not found`, command: display };
  }

  // A fresh clone may not carry the exec bit; bash runs it either way.
  let argv = [script, ...args];
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    argv = ['bash', ...argv];
  }

  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (r.error && r.error.code === 'ETIMEDOUT') {
    return {
      exit_code: null,
      stdout: r.stdout || '',
      stderr: `${path.basename(script)} did not finish in ${SCRIPT_TIMEOUT / 1000}s. `
        + 'If it is waiting on the router, --no-continue was lost.',
      command: display,
    };
  }
  if (r.error) {
    // No bash, no node, or no interpreter for the shebang.
    return {
      exit_code: 2, stdout: '',
      stderr: `cannot run ${path.basename(script)}: ${r.error.message}`,
      command: display,
    };
  }

  return {
    exit_code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    command: display,
  };
}

// ------------------------------------------------------------------- sessions

// How to get a pty without a native dependency.
//
// Python had `pty.openpty()` in its standard library; Node has nothing
// equivalent, and `node-pty` is a compiled dependency this repository will not
// take — it runs on locked-down laptops where `npm install` is not a step
// anyone can rely on.
//
// `script(1)` allocates a pty and runs a command inside it. It is present on
// macOS and on every Linux, and the two flavours differ only in how the command
// is passed. A child under it reports `isTTY: true`, which is exactly what the
// router checks before handing the terminal to cartographer.
//
// `stty -echo` runs as the first command inside the pty, replacing the
// `termios` call Python made on the slave before spawning. A real terminal
// echoes what you type because you are looking at it; here the browser is, and
// the transcript marks your lines with "> " itself. Left on, every answer
// appears twice and the second copy is indistinguishable from something the
// agent said. Nothing can be typed before the session starts, so there is no
// window in which the echo is still on and input could arrive.
function ptyCommand(shellCommand) {
  return process.platform === 'darwin'
    // BSD script: script [-q] file command ...
    ? ['script', ['-q', '/dev/null', 'sh', '-c', shellCommand]]
    // util-linux script: script [-q] [-e] -c command file
    : ['script', ['-q', '-e', '-c', shellCommand, '/dev/null']];
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// One run of the router, attached to a pseudo-terminal.
//
// The UI does not run the agent. It runs bin/tick.sh, which already knows how to
// run cartographer interactively, and bridges that terminal to the browser. That
// keeps a single way of invoking an agent — a second one would drift from the
// router's, and the two would disagree about what an agent run means.
//
// Output is kept in full rather than streamed-and-forgotten, so a reconnecting
// browser (a reload, a closed laptop) can replay the conversation from the top
// instead of rejoining a transcript it has already lost the start of.
class Session extends EventEmitter {
  constructor(storyId) {
    super();
    this.setMaxListeners(0);
    this.storyId = storyId;
    this.started = Date.now() / 1000;
    this.exitCode = null;
    this.closed = false;
    this.chunks = [];

    const inner = `stty -echo 2>/dev/null; exec ${shQuote(TICK)} ${shQuote(storyId)} --wait`;
    const [cmd, args] = ptyCommand(inner);

    // detached gives the child its own process group, so stopping the session
    // kills the agent too rather than orphaning it.
    //
    // HARNESS_NO_MENU is what stops the browser having two of everything.
    // tick.js offers its 1/2/3/4 gate menu whenever stdin is a tty, and this is
    // a pty, so without it the terminal panel prints a menu for the same
    // decision the page is already showing buttons for. Worse than the
    // duplication: that menu blocks on /dev/tty, which nothing here can ever
    // answer, so the session stays alive holding the story. The next router
    // start is then refused as "already running", and an approval that was
    // recorded correctly appears to do nothing. Suppressed, tick.js prints the
    // decision it is waiting on and exits, which is what the page wants.
    this.proc = spawn(cmd, args, {
      cwd: ROOT,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', HARNESS_NO_MENU: '1' },
    });

    const onData = (buf) => this.append(buf.toString('utf8'));
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);

    this.proc.on('error', (e) => {
      this.append(`\n[ahoy] could not start a terminal session: ${e.message}\n`);
      this.finish(null);
    });
    this.proc.on('close', (code) => this.finish(code));
  }

  append(text) {
    this.chunks.push(text);
    this.emit('data', text);
  }

  finish(code) {
    if (this.closed) return;
    this.exitCode = code;
    this.closed = true;
    this.emit('close');
  }

  // Answer the agent. A bare newline is a valid answer to a y/n prompt.
  send(text) {
    if (this.closed) return false;
    try {
      this.proc.stdin.write(text + '\n');
    } catch {
      return false;
    }
    // Echo it into the transcript: the browser is not a terminal, so nothing
    // else puts what you typed in front of you.
    this.append(`\n> ${text}\n`);
    return true;
  }

  stop() {
    if (this.closed) return;
    try {
      process.kill(-this.proc.pid, 'SIGTERM');
    } catch {
      try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }

  status() {
    return {
      story: this.storyId,
      running: !this.closed,
      exit_code: this.exitCode,
      started: this.started,
      chunks: this.chunks.length,
    };
  }
}

const SESSIONS = new Map();

function sessionFor(storyId) {
  return SESSIONS.get(storyId) || null;
}

// Start a router run, unless one is already live for this story.
function startSession(storyId) {
  const existing = SESSIONS.get(storyId);
  if (existing && !existing.closed) {
    return [409, { error: `a session for ${storyId} is already running`, session: existing.status() }];
  }
  let session;
  try {
    session = new Session(storyId);
  } catch (e) {
    return [500, { error: e.message }];
  }
  SESSIONS.set(storyId, session);
  return [200, { session: session.status() }];
}

function doAction(kind, payload) {
  const storyId = payload.story;
  if (!STORY_RE.test(storyId || '')) return [400, { error: 'invalid story id' }];

  const [state, error] = readState(storyId);
  if (state === null) return [404, { error: error || `no story ${storyId}` }];

  const gateKey = resolveGate(payload.gate || '');
  if (gateKey === null) {
    return [400, { error: `'${payload.gate}' is not a human gate in phases.tsv` }];
  }

  const reason = (payload.reason || '').trim();

  let result;
  if (kind === 'approve') {
    // Approvals record no reason — approve.js only attaches one to a rejection —
    // so a note typed here would be silently dropped.
    result = runScript(APPROVE, [storyId, gateKey, '--no-continue']);
  } else if (kind === 'reject') {
    const args = [storyId, gateKey, '--reject'];
    if (reason) args.push(reason);   // must follow --reject immediately
    args.push('--no-continue');
    result = runScript(APPROVE, args);
  } else if (kind === 'revise') {
    // `--` last: everything after it is the reason, so a reason that looks like
    // a flag is still a reason.
    result = runScript(REVISE, [storyId, gateKey, '--no-continue', '--', reason]);
  } else {
    return [404, { error: 'unknown action' }];
  }

  result.ok = result.exit_code === 0;
  result.gate = gateKey;
  result.story = storyId;
  return [200, result];
}

// Start a story, or pick a stalled one back up: bin/run.sh.
//
// Not part of doAction, and not because it would be inconvenient there: both of
// that function's opening guards would refuse this call. There is no gate to
// resolve, and the story named here usually does not exist yet — which is the
// entire point of the request.
//
// THE KEY IS NOT VALIDATED HERE beyond the path-safety check every story id
// gets. start.js owns the rule that a story id must be a well-formed Jira key,
// and it refuses a bad one with an explanation written for a human. Repeating
// that rule here would give this app a second opinion about what a valid key is,
// and the two would eventually disagree.
//
// --no-continue for the same reason every other script gets it: run.js ends by
// handing to the router, and an HTTP request that blocks for the length of an
// agent run is a request that times out. The browser starts the router itself,
// on a terminal it can stream.
function doRun(payload) {
  const storyId = (payload.story || '').trim();
  if (!STORY_RE.test(storyId)) return [400, { error: 'invalid story id' }];

  // Asked before the script runs, because afterwards it is always true. It is
  // the difference between "created" and "resumed", which is the one thing the
  // caller cannot work out from an exit code of 0.
  const existed = storyStatePath(storyId) !== null;

  const result = runScript(RUN, [storyId, '--no-continue']);
  result.ok = result.exit_code === 0;
  result.story = storyId;
  result.existed = existed;
  return [200, result];
}

// --------------------------------------------------------------------- server

function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendPlain(res, status, message) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendStatic(res, urlPath) {
  const rel = (urlPath === '' || urlPath === '/') ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.split(/[\\/]/).includes('..')) return sendPlain(res, 403, 'forbidden');

  const target = path.resolve(WEB, rel);
  if (!isInside(target, WEB)) return sendPlain(res, 403, 'forbidden');
  if (!isFile(target)) return sendPlain(res, 404, 'not found');

  let body;
  try {
    body = fs.readFileSync(target);
  } catch (e) {
    return sendPlain(res, 500, e.message);
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// The transcript as Server-Sent Events.
//
// SSE rather than a WebSocket: the output is one-way and the replies are
// ordinary POSTs, so this needs no handshake, no framing, and nothing outside
// the standard library. Replay starts at chunk 0, so a reload rejoins the whole
// conversation rather than the middle of it.
function streamSession(res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    Connection: 'close',
  });

  const sendEvent = (name, payload) => {
    try {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch { /* the browser navigated away; the agent keeps running */ }
  };

  for (const chunk of session.chunks) sendEvent('output', { text: chunk });

  if (session.closed) {
    sendEvent('done', { exit_code: session.exitCode });
    return res.end();
  }

  const onData = (text) => sendEvent('output', { text });
  const onClose = () => {
    sendEvent('done', { exit_code: session.exitCode });
    cleanup();
    res.end();
  };
  // Keeps proxies and browsers happy while the agent is thinking.
  const beat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { /* gone */ }
  }, SESSION_IDLE_POLL);

  function cleanup() {
    clearInterval(beat);
    session.off('data', onData);
    session.off('close', onClose);
  }

  session.on('data', onData);
  session.on('close', onClose);
  res.on('close', cleanup);
}

// POST /api/session/<story>/{start,input,stop}
function sessionCommand(urlPath, payload) {
  const rest = urlPath.slice('/api/session/'.length);
  const slash = rest.indexOf('/');
  const storyId = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash + 1);

  if (!STORY_RE.test(storyId || '')) return [400, { error: 'invalid story id' }];
  if (storyStatePath(storyId) === null) return [404, { error: `no story ${storyId}` }];

  if (tail === 'start') return startSession(storyId);

  const session = sessionFor(storyId);
  if (session === null) return [404, { error: 'no session for this story' }];

  if (tail === 'input') {
    const text = payload.text;
    if (typeof text !== 'string') return [400, { error: 'text must be a string' }];
    if (!session.send(text)) {
      return [409, { error: 'the session has ended', session: session.status() }];
    }
    return [200, { session: session.status() }];
  }

  if (tail === 'stop') {
    session.stop();
    return [200, { session: session.status() }];
  }

  return [404, { error: 'no such endpoint' }];
}

function handleGET(req, res, urlPath) {
  if (urlPath === '/api/phases') {
    const rows = loadTable();
    return sendJSON(res, 200, {
      rows,
      mainline: mainline(rows),
      human_gates: humanGates(rows),
      terminal: terminalPhases(rows),
    });
  }

  if (urlPath === '/api/stories') return sendJSON(res, 200, listStories());

  if (urlPath.startsWith('/api/story/')) {
    const storyId = urlPath.slice('/api/story/'.length).replace(/^\/+|\/+$/g, '');
    if (!STORY_RE.test(storyId || '')) return sendJSON(res, 400, { error: 'invalid story id' });
    const [story, error] = readStory(storyId);
    if (story === null) return sendJSON(res, 404, { error: error || `no story ${storyId}` });
    return sendJSON(res, 200, story);
  }

  if (urlPath.startsWith('/api/session/')) {
    const rest = urlPath.slice('/api/session/'.length);
    const slash = rest.indexOf('/');
    const storyId = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? '' : rest.slice(slash + 1);
    if (!STORY_RE.test(storyId || '')) return sendJSON(res, 400, { error: 'invalid story id' });
    const session = sessionFor(storyId);
    if (tail === 'stream') {
      if (session === null) return sendJSON(res, 404, { error: 'no session for this story' });
      return streamSession(res, session);
    }
    if (tail === '') return sendJSON(res, 200, { session: session ? session.status() : null });
    return sendJSON(res, 404, { error: 'no such endpoint' });
  }

  if (urlPath.startsWith('/api/')) return sendJSON(res, 404, { error: 'no such endpoint' });

  return sendStatic(res, urlPath);
}

function handlePOST(req, res, urlPath) {
  const sessionRoute = urlPath.startsWith('/api/session/');
  const known = ['/api/approve', '/api/reject', '/api/revise', '/api/run'];
  if (!sessionRoute && !known.includes(urlPath)) {
    return sendJSON(res, 404, { error: 'no such endpoint' });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isNaN(declared)) return sendJSON(res, 400, { error: 'bad Content-Length' });
  if (declared > 64 * 1024) return sendJSON(res, 413, { error: 'body too large' });

  let raw = '';
  let aborted = false;
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 64 * 1024 && !aborted) {
      aborted = true;
      sendJSON(res, 413, { error: 'body too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return sendJSON(res, 400, { error: 'body is not JSON' });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJSON(res, 400, { error: 'body is not an object' });
    }

    if (sessionRoute) {
      const [status, body] = sessionCommand(urlPath, payload);
      return sendJSON(res, status, body);
    }
    // Dispatched by name rather than falling through to doAction, which reads
    // the last path segment as a decision about an existing story.
    if (urlPath === '/api/run') {
      const [status, body] = doRun(payload);
      return sendJSON(res, status, body);
    }
    const [status, body] = doAction(urlPath.split('/').pop(), payload);
    return sendJSON(res, status, body);
  });
}

function main() {
  let port = 8765;
  let host = '127.0.0.1';   // there is no auth, so do not widen it
  const argv = process.argv.slice(2);
  while (argv.length) {
    const a = argv.shift();
    if (a === '--port') { port = Number(argv.shift()); continue; }
    if (a === '--host') { host = argv.shift(); continue; }
    if (a === '-h' || a === '--help') {
      process.stdout.write('usage: bin/serve.sh [--port 8765] [--host 127.0.0.1]\n');
      return process.exit(0);
    }
    process.stderr.write(`ahoy: unknown option ${a}\n`);
    return process.exit(2);
  }

  for (const required of [SPECS, WEB, TABLE]) {
    if (!fs.existsSync(required)) {
      process.stderr.write(`ahoy: missing ${path.relative(ROOT, required)}\n`);
      return process.exit(1);
    }
  }

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return sendPlain(res, 400, 'bad request');
    }
    // One quiet line per request; static assets stay silent.
    if (urlPath.includes('/api/')) {
      process.stderr.write(`[ahoy] ${req.method} ${urlPath}\n`);
    }
    if (req.method === 'GET') return handleGET(req, res, urlPath);
    if (req.method === 'POST') return handlePOST(req, res, urlPath);
    return sendPlain(res, 405, 'method not allowed');
  });

  server.listen(port, host, () => {
    process.stderr.write(`Ahoy UI on http://${host}:${port}\n`);
    process.stderr.write(`  specs:  ${SPECS}\n`);
    process.stderr.write(`  phases: ${path.relative(ROOT, TABLE)}\n`);
    if (spawnSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }).status !== 0) {
      process.stderr.write('  warning: jq is not on PATH - every action will exit 2.\n');
    }
    if (spawnSync('sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status !== 0) {
      process.stderr.write('  warning: script(1) is not on PATH - the interactive panel needs it\n');
      process.stderr.write('           for a pty, so planning sessions will not start.\n');
    }
  });

  const shutdown = () => {
    process.stderr.write('\nstopped\n');
    for (const session of SESSIONS.values()) session.stop();
    server.close(() => process.exit(0));
    // A browser holding an SSE stream open would otherwise keep the process
    // alive past the point anyone is watching it.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only serve when run as a command. Required as a module — which is how
// tests/cases/serve.test.js reaches the read-only derivations below — this
// binds no port and starts no session.
if (require.main === module) main();

module.exports = {
  STORY_RE, mainline, humanGates, terminalPhases,
  gateDecision, reopenableGate, summarise, readRepoText,
  resolveGate, storyStatePath, isInside,
};
