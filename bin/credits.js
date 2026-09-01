#!/usr/bin/env node
'use strict';
// bin/credits.js <STORY-ID> record [--session ID] [--cwd PATH --since TS] [--phase P] [--actor A] [--repo R]
// bin/credits.js <STORY-ID> show [--json]
//
// Records what an agent run cost, into the story's own state.json.
//
//   bin/credits.sh R3DA-13674 record --session "$sid" --phase implementation --actor captain
//   bin/credits.sh R3DA-13674 show
//
// WHY THIS EXISTS. The spend is already measured — the Copilot CLI writes a row
// per turn into ~/.copilot/session-store.db with the AI units it billed. What it
// is not is *attributable*: the ledger knows a session, and only the harness
// knows that the session was the cartographer planning R3DA-13674. Nothing joined
// the two, so "what did this story cost" had no answer.
//
// It lands in state.json rather than staying a query, for the reason tick gives
// about session ids: ~/.copilot lives outside the repo, can be pruned, and does
// not survive moving machines. The ledger is the source; this is the record.
// Once written it travels with the story, and reads without the CLI.
//
// IDEMPOTENT BY SESSION. Entries are keyed by session id and hold that session's
// CUMULATIVE total, so re-recording overwrites rather than adds. That is what
// makes it safe to call after every turn of a resumed session — tick resumes
// one session across many rounds, and a naive append would bill each round again,
// including everything it had already been billed for.
//
// ATTRIBUTION IS EITHER-OR. --session names the one we pinned. --cwd with --since
// sweeps every session that ran in a directory after a point in time, which is
// how a child dispatch catches the subagents its specialist spawned: those have
// their own session ids we never chose, but they run in the worktree we made.
// Both may be given; they union, and the keying makes the overlap harmless.
//
// THE LEDGER IS STILL READ BY PYTHON. It is a SQLite database, and Node's own
// sqlite module is experimental and flag-gated on the Node 22 these laptops
// have. The read was already a python3 subprocess inside the bash, so keeping it
// adds no dependency that was not there this morning — and it is the same
// division as everywhere else here: something else asks the awkward question,
// and JavaScript decides what to do with the answer.
//
// Exit codes:
//   0 recorded (including "nothing to record" — an agent that burned nothing is
//     not an error, and neither is a ledger that has not flushed yet)
//   2 environment or usage error

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { root, statePath, err, out, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');

const ROOT = root();
const LEDGER = process.env.HARNESS_USAGE_DB
  || path.join(os.homedir(), '.copilot', 'session-store.db');

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
const CMD = argv.shift() || '';
if (!STORY_ID || !CMD) {
  die(2, 'usage: bin/credits.sh <STORY-ID> <record|show|backfill|now> [options]');
}

const opts = { session: '', cwd: '', since: '', phase: '', actor: '', repo: '', json: false };
while (argv.length) {
  const a = argv.shift();
  switch (a) {
    case '--session': opts.session = argv.shift() || ''; break;
    case '--cwd': opts.cwd = argv.shift() || ''; break;
    case '--since': opts.since = argv.shift() || ''; break;
    case '--phase': opts.phase = argv.shift() || ''; break;
    case '--actor': opts.actor = argv.shift() || ''; break;
    case '--repo': opts.repo = argv.shift() || ''; break;
    case '--json': opts.json = true; break;
    default: die(2, `unknown option: ${a}`);
  }
}

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `credits: no state file at ${STATE}`);
if (!haveCommand('jq')) die(2, 'credits: jq is required');

// ---------------------------------------------------------------- timestamp
// Printed before a run so it can be passed back as --since afterwards. The
// ledger stores ISO8601 with a Z, and compares as text, so this must match its
// shape exactly rather than being any correct rendering of the same instant.
if (CMD === 'now') {
  out(new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'));
  process.exit(0);
}

function self(args) {
  return spawnSync(process.execPath, [__filename, STORY_ID, ...args], { stdio: 'inherit' });
}

// ------------------------------------------------------------------ backfill
// Sweeps every worktree the story has ever had, with no time floor. This is for
// spend that predates the recording being wired in: work/<STORY>/<repo> is only
// ever created for one story, so the directory alone is sound attribution here.
// It cannot recover the root-level phases — planning and review share their cwd
// with every other run in this repository, and guessing which were this story's
// would be inventing a number rather than reading one.
if (CMD === 'backfill') {
  const story = state.read(STATE);
  let found = false;

  // Sessions the harness pinned at the time. These are the strongest evidence
  // available for the root-level phases, and the only evidence: state.json says
  // this id was opened for this phase of this story, which no amount of looking
  // at the ledger afterwards could establish.
  for (const [bfPhase, bfId] of Object.entries(story.session_ids || {})) {
    if (!bfId) continue;
    found = true;
    self(['record', '--session', bfId, '--phase', bfPhase, '--actor', 'recorded session']);
  }

  const workDir = path.join(ROOT, 'work', STORY_ID);
  if (fs.existsSync(workDir)) {
    for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found = true;
      self(['record', '--cwd', path.join(workDir, entry.name),
        '--since', '1970-01-01T00:00:00.000Z',
        '--phase', 'implementation', '--actor', 'backfilled', '--repo', entry.name]);
    }
  }

  if (!found) err(`credits: nothing to attribute for ${STORY_ID} (no pinned sessions, no worktrees)`);
  process.exit(self(['show']).status ?? 0);
}

// --------------------------------------------------------------------- show
if (CMD === 'show') {
  const story = state.read(STATE);
  const credits = story.credits || { total_aiu: 0, sessions: {} };
  if (opts.json) {
    out(JSON.stringify(credits, null, 2));
    process.exit(0);
  }
  const sessions = credits.sessions || {};
  const round1 = (n) => String(Math.round((n || 0) * 10) / 10);
  const pad = (s, n) => (s || '-').slice(0, n).padEnd(n, ' ');
  out(`story total: ${round1(credits.total_aiu)} AIU across ${Object.keys(sessions).length} session(s)`);
  for (const [, v] of Object.entries(sessions).sort((a, b) => (b[1].aiu || 0) - (a[1].aiu || 0))) {
    out(` ${pad(v.phase, 18)} ${pad(v.actor, 22)} ${round1(v.aiu)} AIU`);
  }
  process.exit(0);
}

if (CMD !== 'record') die(2, `credits: unknown command '${CMD}'`);

if (!opts.session && !opts.cwd) die(2, 'credits: record needs --session or --cwd');
// A cwd sweep without a floor would bill this story for every run that ever
// happened in that directory, including other stories' work in the same repo.
if (opts.cwd && !opts.since) {
  die(2, 'credits: --cwd requires --since (use: bin/credits.sh <ID> now)');
}

// A missing ledger is not a failure. Agents may run where the CLI keeps no
// store, and the harness must not stop delivering a story over bookkeeping.
if (!fs.existsSync(LEDGER)) {
  err(`credits: no usage ledger at ${LEDGER}; nothing recorded`);
  process.exit(0);
}

// ------------------------------------------------------------- read the ledger
// Read-only and via a copy: the CLI writes this database from another process,
// and it is not ours to lock, upgrade, or checkpoint. Copying the -wal alongside
// it keeps the reader consistent with what has been committed.
const READER = `
import json, os, shutil, sqlite3, tempfile

ledger = os.environ["HARNESS_LEDGER"]
session = os.environ.get("HARNESS_SESSION") or ""
cwd = os.environ.get("HARNESS_CWD") or ""
since = os.environ.get("HARNESS_SINCE") or ""

tmp = tempfile.mkdtemp(prefix="ahoy-credits-")
try:
    copy = os.path.join(tmp, "ledger.db")
    shutil.copy2(ledger, copy)
    for ext in ("-wal", "-shm"):
        if os.path.exists(ledger + ext):
            shutil.copy2(ledger + ext, copy + ext)

    db = sqlite3.connect(copy)
    clauses, args = [], []
    if session:
        clauses.append("s.id = ?")
        args.append(session)
    if cwd:
        clauses.append("(s.cwd = ? AND s.created_at >= ?)")
        args += [cwd.rstrip("/"), since]

    rows = db.execute(
        """
        SELECT s.id,
               COALESCE(SUM(u.total_nano_aiu), 0) / 1e9,
               COALESCE(SUM(u.input_tokens), 0),
               COALESCE(SUM(u.output_tokens), 0),
               COUNT(*),
               (SELECT m.model FROM assistant_usage_events m
                 WHERE m.session_id = s.id AND m.model IS NOT NULL
                 ORDER BY m.turn_index DESC LIMIT 1)
          FROM sessions s
          JOIN assistant_usage_events u ON u.session_id = s.id
         WHERE """ + " OR ".join(clauses) + """
         GROUP BY s.id
        """,
        args,
    ).fetchall()

    print(json.dumps([
        {"session": r[0], "aiu": round(r[1], 6), "input_tokens": r[2],
         "output_tokens": r[3], "turns": r[4], "model": r[5]}
        for r in rows
    ]))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`;

function readLedger() {
  const r = spawnSync('python3', ['-'], {
    input: READER,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],   // 2>/dev/null: a broken ledger is not a failed delivery
    env: {
      ...process.env,
      HARNESS_LEDGER: LEDGER,
      HARNESS_SESSION: opts.session,
      HARNESS_CWD: opts.cwd,
      HARNESS_SINCE: opts.since,
    },
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const usage = readLedger();
if (usage.length === 0) process.exit(0);

// ------------------------------------------------------------------- merge
const story = state.read(STATE);
const at = state.nowISO();
const existing = (story.credits && story.credits.sessions) || {};

const merged = { ...existing };
for (const u of usage) {
  const prev = existing[u.session] || {};
  merged[u.session] = {
    aiu: u.aiu,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    turns: u.turns,
    model: u.model,
    // Labels come from the first sighting. A resumed session keeps the phase it
    // was opened for; re-tagging it with wherever it was last observed would
    // quietly move spend between phases.
    phase: prev.phase || opts.phase,
    actor: prev.actor || opts.actor,
    repo: prev.repo || opts.repo,
    first_seen: prev.first_seen || at,
    updated: at,
  };
}

const values = Object.values(merged);
const sum = (key) => values.reduce((acc, v) => acc + (v[key] || 0), 0);
story.credits = {
  sessions: merged,
  // Derived, never accumulated: the total is a fold over the entries, so it
  // cannot drift away from them however often this runs.
  total_aiu: Math.round(sum('aiu') * 1000000) / 1000000,
  total_input_tokens: sum('input_tokens'),
  total_output_tokens: sum('output_tokens'),
  updated: at,
};

try {
  state.write(STATE, story, 'credits');
} catch {
  die(2, 'credits: refused to write malformed state');
}
process.exit(0);
