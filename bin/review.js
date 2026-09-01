#!/usr/bin/env node
'use strict';
// bin/review.js <STORY-ID> [--dry-run]
//
// The pr_review phase. Three steps, in this order:
//
//   1. Fetch the Copilot review workflow's comments from each pull request into
//      open_findings, BEFORE the lookouts run. They travel the same path as any
//      other finding: one list for the fixer, counted by the rework ceiling,
//      recorded in the audit trail.
//   2. Run lookout-design and lookout-defect, each in its own process, each
//      given the same ticket, plan and reviewed PR. They are NOT given the
//      Copilot findings — their first round must be independent, or two
//      reviewers become one reviewer plus an echo.
//   3. REPLACE lookout_reviews[] with both reports. Never append:
//      gates/consensus.sh requires exactly two entries, so appending wedges the
//      story permanently on the second review round.
//
// Each lookout writes its own report to specs/<STORY-ID>/reviews/<lens>.json.
// This script assembles them; it does not interpret them. The verdict belongs
// to gates/consensus.sh.
//
// The `model` recorded for each review is the one THIS script passed on the
// command line, not one the reviewer reported about itself. consensus.sh fails
// when both reviews share a model, and that check is only worth anything if the
// value comes from somewhere the reviewer does not control.
//
// Exit codes:
//   0 both reports recorded; run gates/consensus.sh next
//   1 a lookout did not produce a report
//   2 environment or configuration error

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root, statePath, makeLog, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const profile = require('./lib/profile');
const proc = require('./lib/proc');

const ROOT = root();
const AGENT_CMD = process.env.HARNESS_AGENT_CMD || 'copilot';
const GH_BIN = process.env.HARNESS_GH_BIN || 'gh';

// These MUST match the `model:` pinned in the agent profiles. lookout-design is
// gpt-5.6-terra, lookout-defect is claude-sonnet-5, and each profile says so in
// its own text as the reason the two lenses are separate profiles at all.
//
// The value recorded in lookout_reviews[].model is the one passed here, not one
// the reviewer reported about itself — consensus.sh fails when both reviews
// share a model, and that check is worth nothing if the reviewer supplies the
// value. But recording a model the agent did not actually run on is worse than
// either: the independence check would pass on a fiction. Keep these in sync
// with the profiles, and change both together.
const DESIGN_MODEL = process.env.HARNESS_LOOKOUT_DESIGN_MODEL || 'gpt-5.6-terra';
const DEFECT_MODEL = process.env.HARNESS_LOOKOUT_DEFECT_MODEL || 'claude-sonnet-5';

// Lens names are the profiles' own: lookout-design returns `design-fit`,
// lookout-defect returns `defect-failure`.
const DESIGN_LENS = 'design-fit';
const DEFECT_LENS = 'defect-failure';

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
if (!STORY_ID) die(2, 'usage: bin/review.sh <STORY-ID> [--dry-run]');

let DRY_RUN = false;
while (argv.length) {
  const a = argv.shift();
  if (a === '--dry-run') { DRY_RUN = true; continue; }
  die(2, `unknown option: ${a}`);
}

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `review: no state file at ${STATE}`);
if (!haveCommand('jq')) die(2, 'review: jq is required');
if (!haveCommand(GH_BIN)) die(2, `review: ${GH_BIN} is required`);

const log = makeLog('review', STORY_ID);

const REVIEW_DIR = path.join(ROOT, 'specs', STORY_ID, 'reviews');
fs.mkdirSync(REVIEW_DIR, { recursive: true });

let story = state.read(STATE);
if ((story.child_repos || []).length === 0) {
  die(2, 'review: child_repos[] is empty; nothing to review');
}

function updateState(fn) {
  try {
    story = state.update(STATE, fn, 'review');
  } catch (e) {
    die(2, e instanceof state.StateWriteError ? e.message : `review: state update failed: ${e.message}`);
  }
}

// ------------------------------------------- 1. Copilot review findings
// Fetched first, and deliberately NOT handed to the lookouts.
if (!DRY_RUN) {
  for (const child of story.child_repos || []) {
    const prUrl = child.pr_url || '';
    if (!prUrl) continue;
    log(`fetching Copilot review comments from ${prUrl}`);
    const r = proc.capture(GH_BIN, [
      'pr', 'view', prUrl, '--json', 'comments',
      '--jq', '[.comments[]? | select((.author.login // "") | test("copilot"; "i")) | {body: .body, url: .url}]',
    ], { stderr: 'ignore' });
    let comments = [];
    try {
      comments = r.code === 0 ? JSON.parse(r.out || '[]') : [];
    } catch {
      comments = [];
    }
    if (!Array.isArray(comments) || comments.length === 0) { log('  none found'); continue; }
    log(`  ${comments.length} comment(s) -> open_findings`);
    updateState((s) => {
      s.open_findings = [
        ...(s.open_findings || []),
        ...comments.map((c) => ({
          source: 'copilot_review', repo: child.repo, body: c.body, url: c.url, status: 'open',
        })),
      ];
    });
  }
}

// ------------------------------------------------------------ 2. the lookouts
const planRef = story.plan_path || '';
const reviewedRef = (story.child_repos || []).map((c) => c.pr_url).filter(Boolean).join(', ');
const criteria = JSON.stringify((story.acceptance_criteria || [])
  .map(({ id, text, repo }) => ({ id, text, repo })));

function runLookout(agent, lens, model) {
  const outPath = path.join(REVIEW_DIR, `${lens}.json`);
  try { fs.unlinkSync(outPath); } catch { /* no previous report */ }

  // The prompt is a plain template literal. The bash had to write this heredoc
  // to a file and read it back, because bash 3.2 does not skip a heredoc body
  // when scanning for the `)` that closes a command substitution — so an
  // apostrophe in the PROMPT TEXT broke the whole file and reported the error
  // hundreds of lines away. That hazard does not exist here, and the round trip
  // through a temp file went with it.
  const prompt = `ticket_id: ${STORY_ID}
plan_ref: ${planRef}
reviewed_ref: ${reviewedRef}
lens: ${lens}
HUMAN_GATE: PLAN_ACCEPTED

acceptance_criteria to return a verdict for, every one of them:
${criteria}

Review the pull request(s) above under your own lens only. Write your report to
${outPath} as a single JSON object with exactly these fields:

  "lens": "${lens}"
  "reviewed_shas": { "<repo alias>": "<the commit sha you actually read>" }
  "criteria_verdicts": { "<AC id>": "met" | "not_met" | "partially_met" | "untestable" }
  "findings": [ { "severity": "high"|"medium"|"low", "summary": "...", "location": "..." } ]
  "unresolved_high_or_blocking_count": <integer>
  "diminishing_returns_agreed": true | false
  "consensus_status": "CONSENSUS_READY" | "BLOCKED"

Every acceptance criterion id above must appear in criteria_verdicts; the gate
rejects a report with any of them missing. reviewed_shas must be the sha you
actually read — the gate compares it against the live PR head and rejects a
review of code that has since moved. Do not set "model"; the harness records
which model ran, because a reviewer reporting its own identity is not evidence.
`;

  if (DRY_RUN) {
    log(`--dry-run: would run ${agent} (lens=${lens}, model=${model})`);
    process.stdout.write(prompt + '\n');
    return 0;
  }

  log(`running ${agent} (lens=${lens}, model=${model})`);

  // Same reasoning as bin/dispatch.js: the profile's `tools:` list is what the
  // agent may use, --allow-tool is what it may use without asking, and under
  // --no-ask-user the gap between them is a silent denial. The Lookouts declare
  // Sonarqube tools their review depends on; a fixed grant here would refuse
  // them and produce a design review that never consulted the analyser, with
  // nothing but a log line to say so.
  let grant;
  if (process.env.HARNESS_ALLOW_TOOLS) {
    grant = process.env.HARNESS_ALLOW_TOOLS;
  } else {
    grant = profile.controlPlaneTools(ROOT, agent);
    if (grant) {
      log(`  tool grant from ${agent}.agent.md: ${grant}`);
    } else {
      grant = 'shell,write,edit';
      log(`  warning: could not read tools from agents/${agent}.agent.md; using '${grant}'`);
    }
  }
  // The report is written with `write` and posted to GitHub with `shell`.
  grant = profile.ensure(grant, 'write', 'shell');

  // Pinned for attribution. Unlike a child dispatch there is no worktree to
  // sweep — the lookouts run at ROOT, where a cwd match would also collect
  // every other run in this repository. The id is the only honest key here.
  const lookoutSid = crypto.randomUUID();

  // GITHUB_TOKEN and GH_TOKEN are stripped: a token in the environment takes
  // precedence over the stored Copilot login and is usually a `gh` token
  // without the `Copilot Requests` permission, which fails with exactly the
  // "Authentication failed / token may be invalid" message.
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;

  const r = proc.run(AGENT_CMD, [
    `--agent=${agent}`, `--model=${model}`, '--session-id', lookoutSid, '--prompt', prompt,
    '--allow-tool', grant,
    '--autopilot', '--no-ask-user', '--max-autopilot-continues', '30',
  ], { cwd: ROOT, env });

  // Never fatal: bookkeeping that can stop a delivery is worse than bookkeeping
  // that is occasionally incomplete.
  proc.run(process.execPath, [
    path.join(ROOT, 'bin', 'credits.js'), STORY_ID, 'record',
    '--session', lookoutSid, '--phase', 'review', '--actor', agent,
  ], { stdio: 'ignore' });

  if (!fs.existsSync(outPath)) {
    err(`review: ${agent} produced no report at ${outPath} (exit ${r.code})`);
    return 1;
  }
  try {
    JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    err(`review: ${agent} wrote invalid JSON to ${outPath}`);
    return 1;
  }
  return 0;
}

let rc = 0;
rc = runLookout('lookout-design', DESIGN_LENS, DESIGN_MODEL) || rc;
rc = runLookout('lookout-defect', DEFECT_LENS, DEFECT_MODEL) || rc;
if (rc !== 0) process.exit(1);
if (DRY_RUN) process.exit(0);

// ------------------------------------------------------- 3. record, replacing
// Replace, never append. The gate requires exactly two entries, so appending
// wedges the story permanently on the second review round.
const design = {
  ...JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, `${DESIGN_LENS}.json`), 'utf8')),
  model: DESIGN_MODEL, lens: DESIGN_LENS,
};
const defect = {
  ...JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, `${DEFECT_LENS}.json`), 'utf8')),
  model: DEFECT_MODEL, lens: DEFECT_LENS,
};

updateState((s) => { s.lookout_reviews = [design, defect]; });

log(`lookout_reviews[] replaced with 2 reports (${DESIGN_MODEL}/${DESIGN_LENS}, ${DEFECT_MODEL}/${DEFECT_LENS})`);
log(`run bin/tick.sh ${STORY_ID} to run gates/consensus.sh`);
process.exit(0);
