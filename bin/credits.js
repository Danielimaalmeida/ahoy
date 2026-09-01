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
// THE LEDGER IS READ WITH `node:sqlite`. It is a SQLite database, and reading
// it used to be a python3 subprocess — first inside the bash, then carried
// across the port unchanged. `node:sqlite` is standard library, so that was the
// last thing keeping Python in the harness.
//
// It is still marked experimental upstream, which is a real caveat: it needs
// Node 22.5 or newer, and the API could change. Both failure modes land in the
// same place as a missing ledger — a warning and exit 0 — because bookkeeping
// that can stop a delivery is worse than bookkeeping that is occasionally
// incomplete.
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
// `spawnSync` is still used by `backfill`, which re-invokes this script per
// session and per worktree so each record goes through the same merge.

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
//
// Read via a COPY: the CLI writes this database from another process, and it is
// not ours to lock, upgrade, or checkpoint. Copying the -wal alongside it keeps
// the reader consistent with what has been committed.
//
// `node:sqlite` announces itself as experimental on every load. That warning is
// not actionable by whoever is asking what a story cost, and it would print on
// every `credits show`, so it is filtered here and nowhere else — the caveat is
// recorded in docs/decisions.md instead, where it can be acted on.
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } catch {
    // Node older than 22.5, or a build without it. Same outcome as a missing
    // ledger: say so, record nothing, and never fail the delivery.
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

const SQL = `
  SELECT s.id                                        AS session,
         COALESCE(SUM(u.total_nano_aiu), 0) / 1e9    AS aiu,
         COALESCE(SUM(u.input_tokens), 0)            AS input_tokens,
         COALESCE(SUM(u.output_tokens), 0)           AS output_tokens,
         COUNT(*)                                    AS turns,
         (SELECT m.model FROM assistant_usage_events m
           WHERE m.session_id = s.id AND m.model IS NOT NULL
           ORDER BY m.turn_index DESC LIMIT 1)       AS model
    FROM sessions s
    JOIN assistant_usage_events u ON u.session_id = s.id
   WHERE __WHERE__
   GROUP BY s.id`;

function readLedger() {
  const sqlite = loadSqlite();
  if (!sqlite) {
    err('credits: this Node has no node:sqlite (needs 22.5+); nothing recorded');
    return [];
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahoy-credits-'));
  let db;
  try {
    const copy = path.join(tmpDir, 'ledger.db');
    fs.copyFileSync(LEDGER, copy);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(LEDGER + ext)) fs.copyFileSync(LEDGER + ext, copy + ext);
    }

    // Either-or attribution, unioned. --session names the one we pinned; --cwd
    // with --since sweeps the worktree, which is how a child dispatch catches
    // the subagents its specialist spawned. Keying by session makes the overlap
    // harmless.
    const clauses = [];
    const args = [];
    if (opts.session) { clauses.push('s.id = ?'); args.push(opts.session); }
    if (opts.cwd) {
      clauses.push('(s.cwd = ? AND s.created_at >= ?)');
      args.push(opts.cwd.replace(/\/+$/, ''), opts.since);
    }

    db = new sqlite.DatabaseSync(copy);
    const rows = db.prepare(SQL.replace('__WHERE__', clauses.join(' OR '))).all(...args);
    return rows.map((r) => ({
      session: r.session,
      aiu: Math.round(Number(r.aiu) * 1e6) / 1e6,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      turns: Number(r.turns),
      model: r.model ?? null,
    }));
  } catch (e) {
    // A ledger that has not flushed yet, or whose schema has moved on, is not a
    // failed delivery. Say what happened and record nothing.
    err(`credits: could not read the usage ledger (${e.message}); nothing recorded`);
    return [];
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
