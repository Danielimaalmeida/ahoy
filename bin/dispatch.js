#!/usr/bin/env node
'use strict';
// bin/dispatch.js <STORY-ID> [--dry-run] [--one]
//
// Dispatches the next ready work package from state.json to the specialist agent
// the plan assigned, in the plan's dependency order.
//
// This replaces the `orchestrate` skill's create_session, which exists only in
// the GitHub Copilot app. Here a child agent is a `copilot --agent=<name>`
// process with cwd set to that repository's worktree. No session tools, no
// skill, nothing that can silently fail to resolve — if the agent profile is
// missing, copilot says so and this script exits non-zero.
//
// It dispatches ONE package per pass, like Captain did, so a failure stops the
// sequence rather than fanning out over a broken plan.
//
// The specialist and the order come from work_packages[], written by
// Cartographer and validated by gates/plan.sh. This script chooses neither —
// that is what keeps repository-specific sequencing out of the control plane.
//
// Exit codes:
//   0 a package was dispatched, or all packages are already done
//   1 nothing dispatchable yet (dependencies still outstanding)
//   2 environment or configuration error
//   4 a human must decide; nothing external will change this

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root, statePath, makeLog, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const derive = require('./lib/derive');
const mapping = require('./lib/mapping');
const profile = require('./lib/profile');
const proc = require('./lib/proc');

const ROOT = root();
const AGENT_CMD = process.env.HARNESS_AGENT_CMD || 'copilot';
const WORKTREES = process.env.HARNESS_WORKTREE_ROOT || path.join(ROOT, 'work');
const MAPPING = process.env.HARNESS_REPO_MAPPING
  || path.join(ROOT, 'knowledge', 'repositories', 'agent-mappings.md');

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
if (!STORY_ID) die(2, 'usage: bin/dispatch.sh <STORY-ID> [--dry-run] [--one]');

let DRY_RUN = false;
let ONE = false;
while (argv.length) {
  const a = argv.shift();
  if (a === '--dry-run') { DRY_RUN = true; ONE = true; continue; }
  if (a === '--one') { ONE = true; continue; }
  die(2, `unknown option: ${a}`);
}

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `dispatch: no state file at ${STATE}`);
if (!haveCommand('jq')) die(2, 'dispatch: jq is required');

const log = makeLog('dispatch', STORY_ID);

function updateState(fn) {
  try {
    return state.update(STATE, fn, 'dispatch');
  } catch (e) {
    die(2, e instanceof state.StateWriteError ? e.message : `dispatch: state update failed: ${e.message}`);
  }
}

function markPackage(id, status) {
  updateState((s) => {
    s.work_packages = derive.workPackages(s).map((w) => (w.id === id ? { ...w, status } : w));
  });
}

// ---------------------------------------------------------------- one pass
//
// Returns the exit code for this pass. Each pass RE-READS state, so a package
// whose dependency just completed becomes eligible without any bookkeeping in
// the loop below — which is why the selection logic lives in exactly one place.
function dispatchOne() {
  const story = state.read(STATE);

  // The plan must be approved. Writing to a child repository before
  // human_gates.plan_accepted is the single rule Captain's profile guards
  // hardest, so it is enforced here in code rather than restated as an
  // instruction.
  const approved = ((story.human_gates || {}).plan_accepted || {}).status || '';
  if (approved !== 'approved') {
    err(`dispatch: human_gates.plan_accepted is '${approved || 'unset'}'; refusing to touch a child repository before the plan is approved`);
    return 2;
  }

  const next = derive.nextPackage(story);
  if (!next) return nothingToDispatch(story);
  return dispatchPackage(story, next);
}

// ------------------------------------------------- nothing was selectable
function nothingToDispatch(story) {
  const wps = derive.workPackages(story);

  if (wps.length === 0) {
    err(`dispatch: work_packages[] is missing or empty in ${STATE}.`);
    err("dispatch: Cartographer must record the plan's work packages there; prose alone is not dispatchable.");
    return 2;
  }

  // Exit 4, not 1.
  //
  // Exit 1 means "not yet" and the router may poll on it — correct while CI is
  // running, because something outside can change. A failed or stalled package
  // is not that: nothing external will fix it, so polling produces the same
  // message every thirty seconds until the wait budget runs out. That happened.
  //
  // Exit 4 halts without changing phase, which is what "a human must decide"
  // means everywhere else in the exit-code contract.
  const stuck = wps.filter((w) => w.status === 'failed' || w.status === 'stalled');
  if (stuck.length > 0) {
    err(`dispatch: work package(s) need a human: ${stuck.map((w) => `${w.id} (${w.status})`).join(', ')}`);
    err('dispatch: nothing external will change this, so the harness stops rather');
    err('dispatch: than polling. Read what the package last reported:');
    err(`  ls ${path.join(ROOT, 'specs', STORY_ID, 'reports')}/`);
    err('dispatch: then decide, with the command that owns that decision:');
    err(`  bin/decide.sh ${STORY_ID} ${stuck[0].id} accept`);
    err(`  bin/decide.sh ${STORY_ID} ${stuck[0].id} retry -- "what to fix"`);
    return 4;
  }

  const remaining = wps.filter((w) => derive.statusOf(w) !== 'done');
  if (remaining.length === 0) {
    // Reconcile every repository's status before leaving, not only when this
    // script has just finished a package.
    //
    // The derivation used to live solely on the completion path, so a story
    // whose packages were all `done` — because the last one was marked done by
    // hand, say — exited here with child_repos[].status still `in_progress`.
    // gates/child_ready.sh requires `ready`, so it reported not-yet forever
    // while there was nothing left to do.
    //
    // A derived value should be recomputed wherever it is read, not only where
    // it happens to be written.
    const updated = updateState((s) => derive.recomputeRepoStatuses(s));
    log('all work packages dispatched');
    for (const r of updated.child_repos || []) err(`[dispatch] ${r.repo} -> ${r.status || '?'}`);
    return 0;
  }

  // Distinguish "waiting for something that will happen" from "waiting for
  // something that will not".
  //
  // A package left `pending` is genuinely waiting on a dependency that is still
  // being worked, and re-running will eventually pick it up: exit 1, poll.
  //
  // A package in `unverified`, `blocked`, `stalled`, `waiting_on_handback` or
  // `failed` is never dispatched — dispatch only picks up `pending` — so nothing
  // this script does will ever move it. Polling produced the same line every
  // thirty seconds for the full half-hour budget while a work package sat
  // `unverified` because a browser check could not run.
  //
  // `unverified` in particular is the one status a child can only reach by being
  // honest. It must not be rounded up, and it must not be silently waited on
  // either: someone has to look.
  if (derive.movability(story) === 'halt') {
    const immovable = wps.filter((w) => !['done', 'pending'].includes(derive.statusOf(w)));
    err('dispatch: no package can be dispatched, and these will not move on their own:');
    err(`  ${immovable.map((w) => `${w.id} (${derive.statusOf(w)})`).join(', ')}`);
    err('dispatch:');
    err("dispatch: 'unverified' means the work may be right but a check could not");
    err('dispatch: run, so nobody has evidence. The harness never rounds that up.');
    err('dispatch: read what the package reported, then decide:');
    err(`  ls ${path.join(ROOT, 'specs', STORY_ID, 'reports')}/`);
    err('dispatch:');
    // Name the actual package. A hint that says select(.id=="WP") is a template
    // the reader has to finish, and the whole point of printing a command is
    // that it can be pasted.
    const first = immovable[0].id;
    err('dispatch: run bin/run.sh from a terminal and the harness offers this as a menu.');
    err(`dispatch: otherwise, to accept ${first} as delivered:`);
    err(`  bin/decide.sh ${STORY_ID} ${first} accept`);
    err('dispatch: or to send it round again after fixing the cause:');
    err(`  bin/decide.sh ${STORY_ID} ${first} retry -- "what to fix"`);
    return 4;
  }

  err(`dispatch: no package is ready; still blocked on dependencies: ${remaining.map((w) => w.id).join(', ')}`);
  return 1;
}

// ------------------------------------------------------- dispatch a package
function dispatchPackage(story, wp) {
  const id = wp.id;
  const repo = wp.repo;
  const agent = wp.agent;
  let openPr = String(wp.open_pr);

  // A pull request already open for this repository overrides the plan's flag.
  //
  // `open_pr` is decided once, at planning time, and every rework round hands
  // the same instruction to the agent again: open a pull request, request
  // Copilot review. The agent has no way to know one already exists, so it
  // obliges — and three rework rounds leave a repository with a pile of pull
  // requests and a review thread nobody can read.
  //
  // The harness does know: child_repos[].pr_number. So it answers the question
  // rather than asking the agent to.
  const existingPr = (story.child_repos || [])
    .filter((r) => r.repo === repo).map((r) => r.pr_number).find((n) => n || n === 0);
  const existingPrUrl = (story.child_repos || [])
    .filter((r) => r.repo === repo).map((r) => r.pr_url).find(Boolean) || '';
  let prNote = '';
  if (existingPr || existingPr === 0) {
    if (openPr === 'true') log(`  PR #${existingPr} already open for ${repo}; not asking for another`);
    openPr = 'false';
    prNote = `A pull request is ALREADY OPEN for this branch: #${existingPr}
${existingPrUrl}

Push your commits to the branch and stop. Do NOT open another pull request, do
NOT request Copilot review again, and do NOT post a new review comment — the
existing thread already carries this work, and a second request on the same
change makes the thread unreadable for whoever has to act on it.

`;
  }

  // ------------------------------------------------------ resolve the repo
  // Read the existing agent-to-repository mapping rather than a second file
  // that would have to be kept in step with it. Repositories under "not yet
  // mapped" have no plan alias, so they never match.
  if (!fs.existsSync(MAPPING)) {
    err(`dispatch: mapping not found at ${MAPPING} (set HARNESS_REPO_MAPPING)`);
    return 2;
  }
  const slug = mapping.resolveFieldFile(MAPPING, repo, 'slug');
  if (!slug) {
    err(`dispatch: no repository in ${MAPPING} has plan alias '${repo}'.`);
    err("dispatch: if it is under 'Repositories not yet mapped', it has no conforming agent set and must not be dispatched into.");
    return 2;
  }

  const prefix = story.branch_prefix || 'feature';
  // gates/child_ready.sh rejects any branch outside this set, and it runs AFTER
  // the work is done. Fail here instead, before a worktree exists.
  if (!['feature', 'hotfix', 'chore', 'docs', 'release'].includes(prefix)) {
    err(`dispatch: branch prefix '${prefix}' is rejected by gates/child_ready.sh (feature|hotfix|chore|docs|release)`);
    return 2;
  }
  const slugpart = wp.branch_slug || 'work';
  const branch = `${prefix}/${STORY_ID}-${slugpart}`;
  const worktree = path.join(WORKTREES, STORY_ID, repo);

  // ------------------------------------------------------ the work package
  const criteria = JSON.stringify((story.acceptance_criteria || [])
    .filter((c) => c.repo === repo)
    .map(({ id: acId, text, test_ids }) => ({ id: acId, text, test_ids })));
  const planRef = story.plan_path || '';
  const reworkNote = wp.rework_note || '';

  // The child's handoff report, in the control plane rather than the child
  // repo: it is harness bookkeeping and has no business in the delivered diff.
  const REPORT_DIR = path.join(ROOT, 'specs', STORY_ID, 'reports');
  const REPORT = path.join(REPORT_DIR, `${id}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Archive the previous report rather than deleting it.
  //
  // Deleting was actively harmful: a package re-dispatched three times destroyed
  // the evidence of what the first two attempts found, so by the time anyone
  // looked there was nothing to read. The whole reason to ask an agent to file a
  // report is to have it afterwards.
  let attempt = 1;
  while (fs.existsSync(path.join(REPORT_DIR, `${id}.round${attempt}.json`))) attempt += 1;
  if (fs.existsSync(REPORT)) {
    fs.renameSync(REPORT, path.join(REPORT_DIR, `${id}.round${attempt}.json`));
    log(`kept the previous report as ${id}.round${attempt}.json`);
  }

  // The agent writes the report INSIDE its worktree, and this script moves it
  // out. It cannot write it where the harness wants it: the agent runs with its
  // working directory set to a child repository checkout, and Copilot will not
  // write outside that directory. Pointing the agent at specs/<STORY>/reports/
  // produced exactly one thing: "Permission denied and could not request
  // permission from user", after ten minutes and a real implementation, with
  // the report stranded in the session state.
  const DROP_NAME = '.ahoy-report.json';
  const DROP = path.join(worktree, DROP_NAME);

  // The plan travels the same way, for the same reason. `plan_ref` is a path in
  // the control plane, so an agent told to read it fails exactly as it failed
  // reading the contract — and then implements from the acceptance criteria
  // alone, without the design decisions and sequencing the plan carries.
  const PLAN_NAME = '.ahoy-plan.md';
  const PLAN_DROP = path.join(worktree, PLAN_NAME);

  // Built as a variable rather than inlined. The bash had to do this because
  // bash 3.2 cannot parse a `${var:+...}` whose alternate value spans lines —
  // it reports "bad substitution: no closing }" and emits the whole heredoc
  // raw. That hazard is gone; the separation is kept because it is clearer.
  const reworkBlock = reworkNote ? `ATTENTION — this package was reopened because something is wrong
with work already delivered. Fix this before anything else:

${reworkNote}

If it names failing CI checks, open the linked runs, read the actual failure,
and fix the cause. Run the repository own test and lint commands locally before
you push — pushing a guess costs another full CI cycle, and the harness will
simply hand you the same failure again.

` : '';

  const prompt = `ticket_id: ${STORY_ID}
plan_ref: ${PLAN_NAME}  (the approved plan, staged into this worktree for you)
work_package_id: ${id}
repo: ${repo}
branch: ${branch}
open_pr: ${openPr}
HUMAN_GATE: PLAN_ACCEPTED

acceptance_criteria (implement and test every one; the test_ids are greped for
in the pull request diff by gates/child_ready.sh, so they must appear verbatim):
${criteria}

${reworkBlock}Read ${PLAN_NAME} first. It is the approved implementation plan and it carries
the design decisions, sequencing and boundaries the acceptance criteria alone do
not. Do not commit it — the harness put it there and takes it away.

You are running inside a checkout of ONE child repository. The Ahoy control
plane — its specs/, knowledge/ and gates/ directories — is not reachable from
here, and paths into it will fail. Everything you need is in this prompt or in
this repository.

${prNote}Work in this worktree, on the branch above, with real commits. If open_pr is
true, open the pull request and put ${STORY_ID} in its body. If open_pr is
false, push and stop — opening one is another package's job, or already done.

When you are finished, write your handoff report to:
  ${DROP_NAME}
in the ROOT OF THIS WORKTREE — the directory you are working in. Write it there
and nowhere else; a path outside this directory will be refused and the harness
will treat the work package as undelivered even though you did the work.

Write it as your LAST action, after committing and pushing. Do not commit the
file itself: it is harness bookkeeping and has no business in the delivered
diff. The harness moves it out and deletes it.

The report is a single JSON object with exactly these fields. Everything you
need is below — do not go looking for the contract document, it lives in the
control plane and you cannot reach it from here:

  "work_package_id": "${id}"
  "repo": "${repo}"
  "repo_slug": "<owner/name>"
  "branch": "${branch}"
  "head_sha": "<the commit you finished on>"
  "status": "ready" | "in_progress" | "blocked" | "unverified"
  "acceptance_criteria_mapping": { "<AC id>": "<files, behaviour, and the test proving it>" }
  "test_ids_delivered": { "<test name>": "<where it lives>" }
  "changed_files": [ "..." ]   or the string "none (review-only)"
  "validation_commands": [ { "command": "...", "result": "..." } ]
  "remaining_gaps": [ { "severity": "...", "detail": "..." } ]
  "handback_to": "<work package id>"             (only when handing back)
  "rework_note"                                  (if set on your package: what a
                                                  previous package asked you to fix)
  "assumption_check": "No unresolved assumptions remain."
  "blocker_question": "<one focused question>"   (only when status is blocked)
  "pr_url", "pr_number"                          (only when open_pr is true)

The status vocabulary is exact and the harness routes on it:

  ready       this work package is complete and evidenced
  in_progress more work remains that YOU can do; you will be dispatched again
  blocked     you need an answer to proceed; ask it in blocker_question
  unverified  the change may well be correct, but a check you needed could not
              run, so nobody has evidence

Only report in_progress when running you again could finish the job. If the
remaining work needs a tool you do not have, running you again changes nothing
and the harness will stop after two such rounds.

For that case use the handback instead: report "in_progress" AND set

  "handback_to": "<work package id>"

naming the package whose agent can do it, with the specifics in remaining_gaps.
The harness reopens that package with your findings attached and holds yours
until it is done.

A reviewer that finds a defect it cannot fix should hand back. That is the
normal outcome of review, not a failure.

Report unverified when it is true. It is the one status you can only reach by
being honest, and the harness never rounds it up to ready — a delivery that
looks close to done is not the same as one somebody checked.

Reporting "ready" with no commits is a contradiction the harness rejects, unless
changed_files is exactly "none (review-only)". A package that legitimately has
nothing left to add is a real outcome; say so in that field rather than
inventing a change to prove you ran.
`;

  log(`work package ${id} -> ${agent} in ${repo} (${slug})`);
  log(`  branch:   ${branch}`);
  log(`  worktree: ${worktree}`);
  log(`  open_pr:  ${openPr}`);

  if (DRY_RUN) {
    log(`--dry-run: not creating the worktree and not invoking ${agent}`);
    process.stdout.write(prompt + '\n');
    return 0;
  }

  // --------------------------------------------------------- the worktree
  // A real checkout, never a scratch directory: code that is not in a checkout
  // cannot be committed, pushed, reviewed, or verified by any gate.
  if (!fs.existsSync(worktree)) {
    const clone = path.join(WORKTREES, '.clones', repo);
    if (!fs.existsSync(path.join(clone, '.git'))) {
      const remote = mapping.remoteFor(slug);
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      log(`cloning ${remote}`);
      if (proc.run('git', ['clone', remote, clone], { stdio: ['ignore', 2, 2] }).code !== 0) return 2;
    }
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    if (proc.run('git', ['-C', clone, 'fetch', 'origin'], { stdio: ['ignore', 2, 2] }).code !== 0) return 2;
    if (proc.run('git', ['-C', clone, 'worktree', 'add', '-b', branch, worktree, 'origin/HEAD'],
      { stdio: ['ignore', 2, 2] }).code !== 0) return 2;
  }

  // Where this branch diverged from the BASE BRANCH — not the worktree HEAD at
  // the start of this invocation.
  //
  // The difference matters on a retry. A package that committed its work, then
  // failed for an unrelated reason (a report it could not write, say), already
  // has its commits. Re-running it correctly makes no new commit, and a
  // HEAD-at-start comparison would read that as "delivered nothing" and fail it
  // a second time for succeeding.
  //
  // The question worth asking is "has this branch delivered anything at all",
  // which is a comparison against the base branch and gives the same answer
  // however many times the agent has run.
  const mergeBase = proc.git(worktree, ['merge-base', 'HEAD', 'origin/HEAD'], { stderr: 'ignore' });
  const baseSha = mergeBase.code === 0 && mergeBase.out
    ? mergeBase.out
    : proc.git(worktree, ['rev-parse', 'HEAD']).out;

  // --no-ask-user without tool grants is a trap: every permission request the
  // agent makes becomes a silent DENIAL rather than a prompt, so it burns its
  // budget being refused reads it needs — including .git/HEAD and .git/config,
  // without which it cannot commit. Grant the tools up front instead.
  //
  // THE GRANT COMES FROM THE AGENT'S OWN PROFILE, in the child repository, next
  // to the code, maintained by the people who own it. A fixed grant here
  // quietly overrules every profile in every child repo — which is how
  // `frontend-implementer` built a Splitter without the design-system
  // validation its own profile declares.
  let allowTools;
  if (process.env.HARNESS_ALLOW_TOOLS) {
    allowTools = process.env.HARNESS_ALLOW_TOOLS;
    log(`tool grant from HARNESS_ALLOW_TOOLS: ${allowTools}`);
  } else {
    allowTools = profile.childProfileTools(worktree, agent);
    if (allowTools) {
      log(`tool grant from ${agent}.agent.md: ${allowTools}`);
    } else {
      // No profile found in the child repo, or none this parser could read.
      // Fall back rather than fail — but say so, because a silent fallback here
      // is exactly the failure being fixed.
      allowTools = 'shell,write,edit';
      log(`warning: could not read tools from ${worktree}/.github/agents/${agent}.agent.md`);
      log(`warning: falling back to '${allowTools}'. Any MCP tool the profile`);
      log('warning: declares will be DENIED, silently, under --no-ask-user.');
    }
  }
  const withShell = profile.ensure(allowTools, 'shell');
  if (withShell !== allowTools) log("added 'shell' to the grant: without it the agent cannot commit");
  allowTools = withShell;

  // Stage the plan into the worktree so the agent can actually read it.
  const planSrc = path.join(ROOT, planRef.replace(/^\.\//, ''));
  if (planRef && fs.existsSync(planSrc)) {
    fs.copyFileSync(planSrc, PLAN_DROP);
    log(`staged the plan into ${PLAN_NAME}`);
  } else {
    log(`warning: no plan file at ${planSrc}; the agent works from criteria alone`);
  }

  // GH_HOST is PASSED THROUGH, not stripped.
  //
  // An earlier version removed it, on the theory that Copilot requests always
  // go to github.com. That is wrong when Copilot is logged in against a GitHub
  // Enterprise host — ~/.copilot/config.json `loggedInUsers` records which —
  // and removing GH_HOST then hides the only pointer to the right credential.
  //
  // GITHUB_TOKEN and GH_TOKEN are still stripped: a token in the environment
  // takes precedence over the stored Copilot login and is usually a `gh` token
  // without the `Copilot Requests` permission, which fails with exactly the
  // "Authentication failed / token may be invalid" message.
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const copilotHost = process.env.HARNESS_COPILOT_HOST || process.env.GH_HOST || '';
  if (copilotHost) env.GH_HOST = copilotHost;

  // Pinned so the run is attributable, and stamped so the cwd sweep below has a
  // floor. The specialist may spawn subagents, which get session ids we never
  // chose; what they share is this worktree, so the directory is what catches
  // them.
  const dispatchSid = crypto.randomUUID();
  const since = proc.capture(process.execPath,
    [path.join(ROOT, 'bin', 'credits.js'), STORY_ID, 'now'], { stderr: 'ignore' });
  const dispatchSince = since.code === 0 ? since.out : '';

  const agentRun = proc.run(AGENT_CMD, [
    `--agent=${agent}`, '--session-id', dispatchSid, '--prompt', prompt,
    '--allow-tool', allowTools,
    '--autopilot', '--no-ask-user', '--max-autopilot-continues', '40',
  ], { cwd: worktree, env });

  // Before the exit check: a run that failed still spent, and that is exactly
  // the spend worth being able to see.
  proc.run(process.execPath, [
    path.join(ROOT, 'bin', 'credits.js'), STORY_ID, 'record',
    '--session', dispatchSid,
    ...(dispatchSince ? ['--cwd', worktree, '--since', dispatchSince] : []),
    '--phase', 'implementation', '--actor', agent, '--repo', repo,
  ], { stdio: 'ignore' });

  if (agentRun.code !== 0) {
    err(`dispatch: ${agent} exited ${agentRun.code} for work package ${id}`);
    markPackage(id, 'failed');
    return 2;
  }

  // ---------------------------------------------------- record what happened
  // head_sha comes from the worktree, not from the agent's report: it is the
  // one field child_ready.sh compares against the live PR, so it must not be
  // self-reported. status stays a claim — only gates/child_ready.sh, which asks
  // GitHub, may justify `ready`.
  const headSha = proc.git(worktree, ['rev-parse', 'HEAD']).out;

  // The staged plan is harness scaffolding and leaves with the harness. Removed
  // before the diff is inspected, so an uncommitted copy never reads as the
  // agent's own untracked mess.
  if (fs.existsSync(PLAN_DROP)) {
    fs.unlinkSync(PLAN_DROP);
    if (proc.git(worktree, ['ls-files', '--error-unmatch', PLAN_NAME], { stderr: 'ignore' }).code === 0) {
      err(`dispatch: warning — ${agent} committed ${PLAN_NAME}; unstaging it.`);
      proc.git(worktree, ['rm', '--cached', PLAN_NAME], { stderr: 'ignore' });
      err('dispatch: commit that removal before the PR is reviewed.');
    }
  }

  // ------------------------------------------------- collect the report
  // The agent wrote it inside the worktree because that is the only place it
  // can write. Move it to the control plane, and get it out of the checkout
  // before it can end up in a diff.
  if (fs.existsSync(DROP)) {
    fs.renameSync(DROP, REPORT);
    // If the agent committed it despite being told not to, the file is back on
    // the next checkout and it IS in the delivered diff. Say so plainly rather
    // than letting a bookkeeping file ship.
    if (proc.git(worktree, ['ls-files', '--error-unmatch', DROP_NAME], { stderr: 'ignore' }).code === 0) {
      err(`dispatch: warning — ${agent} committed ${DROP_NAME}. It is harness`);
      err('dispatch: bookkeeping and does not belong in the pull request.');
      proc.git(worktree, ['rm', '--cached', DROP_NAME], { stderr: 'ignore' });
      err('dispatch: unstaged it; commit that removal before the PR is reviewed.');
    }
  }

  if (!fs.existsSync(REPORT)) {
    err(`dispatch: ${agent} exited 0 but wrote no report at ${DROP}.`);
    err('dispatch: without it there is no claim about what happened, so the');
    err('dispatch: package is NOT marked done.');
    err('dispatch: the report must be written INSIDE the worktree — a path');
    err('dispatch: outside it is refused, and under --no-ask-user that refusal');
    err('dispatch: is silent. Check the agent output above for denied writes.');
    err(`dispatch: the work itself may be fine; check:  git -C ${worktree} log --oneline -3`);
    markPackage(id, 'failed');
    return 1;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  } catch {
    err(`dispatch: ${agent} wrote invalid JSON to ${REPORT}`);
    markPackage(id, 'failed');
    return 1;
  }

  const childStatus = report.status || '';
  const changed = typeof report.changed_files === 'string'
    ? report.changed_files
    : String((report.changed_files || []).length);
  const reviewOnly = changed.includes('review-only');

  log(`child reports status '${childStatus}' (changed_files: ${changed})`);

  const gapLines = (report.remaining_gaps || [])
    .map((g) => `${g.severity || '?'}: ${g.detail || '?'}`);

  switch (childStatus) {
    case 'ready':
      break;

    case 'in_progress': {
      // Re-dispatching only helps if running the SAME agent again could change
      // the answer. Often it cannot — a review-only agent that found a defect
      // it has no tool to fix will report `in_progress` every time, forever,
      // and each round costs ten minutes and a few hundred thousand tokens.
      //
      // So count consecutive rounds and stop at the ceiling, exactly as
      // gates/rework_ceiling.sh does for rework.
      const rounds = (wp.in_progress_rounds || 0) + 1;
      const ceiling = story.in_progress_ceiling ?? 2;
      updateState((s) => {
        s.work_packages = derive.workPackages(s).map((w) =>
          (w.id === id ? { ...w, in_progress_rounds: rounds } : w));
      });

      // A handback is what an agent means when it says "I found something and
      // somebody else has to fix it". The contract had no word for it, so
      // agents reached for `in_progress` — the one status that guarantees the
      // least useful outcome. One review-only package looped indefinitely at
      // roughly ten minutes and 3M tokens a round, correctly reporting a real
      // accessibility defect each time and having nowhere to put it.
      const handback = report.handback_to || '';
      if (handback) {
        err(`dispatch: ${agent} hands ${id} back to ${handback}:`);
        for (const line of gapLines) err(`  ${line}`);
        const target = derive.workPackages(story).find((w) => w.id === handback);
        if (target) {
          const note = gapLines.join('; ');
          updateState((s) => {
            s.work_packages = derive.workPackages(s).map((w) => {
              if (w.id === handback) return { ...w, status: 'pending', rework_note: note };
              if (w.id === id) return { ...w, status: 'waiting_on_handback' };
              return w;
            });
          });
          err(`dispatch: reopened ${handback}; ${id} waits for it. Re-run to continue.`);
        } else {
          err(`dispatch: no work package '${handback}' exists. Fix the plan or the report.`);
        }
        return 1;
      }

      if (derive.atCeiling(rounds, ceiling)) {
        err(`dispatch: ${agent} has reported 'in_progress' ${rounds} times for ${id}`);
        err('dispatch: without finishing. Running it again will not change that.');
        err('dispatch: what it last reported:');
        for (const line of gapLines) err(`  ${line}`);
        err(`dispatch: full report: ${REPORT}`);
        err('dispatch:');
        err('dispatch: usually this means the agent cannot finish the job it was');
        err('dispatch: given — a reviewer with no edit tool that found a defect,');
        err("dispatch: for instance. Move the work to a package whose agent can do");
        err("dispatch: it, or have the report name a 'handback_to' package.");
        markPackage(id, 'stalled');
        return 1;
      }

      log(`${agent} reports more work remains in scope for ${id} (round ${rounds} of ${ceiling}).`);
      log('The package stays pending and will be dispatched again. Re-run to continue.');
      return 1;
    }

    case 'blocked':
      err(`dispatch: ${agent} is blocked on work package ${id}:`);
      err(`  ${report.blocker_question || '(none given)'}`);
      err('dispatch: answer it in the plan or the ticket, then re-run.');
      markPackage(id, 'blocked');
      return 1;

    case 'unverified':
      // Never rounded up. It is the one status a child can only reach by being
      // honest, and rounding it up removes any reason to be.
      err(`dispatch: ${agent} reports 'unverified' for ${id}: the change may be`);
      err('dispatch: correct, but a check it needed could not run, so there is no');
      err('dispatch: evidence. This is never rounded up to ready.');
      for (const line of gapLines) err(`  gap: ${line}`);
      markPackage(id, 'unverified');
      return 1;

    case '':
      err(`dispatch: ${REPORT} has no status field`);
      markPackage(id, 'failed');
      return 1;

    default:
      err(`dispatch: ${REPORT} reports unknown status '${childStatus}'`);
      err('dispatch: the contract vocabulary is ready|in_progress|blocked|unverified');
      markPackage(id, 'failed');
      return 1;
  }

  // `ready` is the child's claim. This is the half of it that can be checked
  // here: a `ready` claiming changed files while the branch never diverged from
  // its base is rejected as the contradiction it is.
  if (headSha === baseSha && !reviewOnly) {
    err(`dispatch: ${agent} reports 'ready' with changed files, but HEAD is still`);
    err(`dispatch: ${baseSha} — nothing was committed. The report contradicts the`);
    err('dispatch: repository, so the package is NOT marked done.');
    err('dispatch: if the honest outcome was that nothing needed changing, the');
    err('dispatch: report should say  "changed_files": "none (review-only)".');
    err(`dispatch: check for uncommitted work:  git -C ${worktree} status --short`);
    markPackage(id, 'failed');
    return 1;
  }
  if (reviewOnly) log('review-only package: no commit expected, and none required');

  // Uncommitted work is not delivered work: gates read the pull request diff,
  // and a dirty worktree contributes nothing to it.
  const dirty = proc.git(worktree, ['status', '--porcelain']).out;
  if (dirty) {
    err(`dispatch: warning — ${worktree} has uncommitted changes after ${agent}:`);
    for (const line of dirty.split('\n').slice(0, 10)) err(line);
    err('dispatch: these are not in any commit and will not appear in the PR diff.');
  }

  // The recorded branch is not overwritten by a later package that disagrees.
  //
  // It used to be, and that is how a story ended up recording a branch no pull
  // request was ever opened against: the last package to finish simply won. The
  // first package to record a branch for a repository owns it; a second one
  // naming something different is a plan error, and it stops here rather than
  // surfacing later as "no open PR exists for branch ..." with everything done.
  const recordedBranch = (story.child_repos || [])
    .filter((r) => r.repo === repo).map((r) => r.branch).find(Boolean) || '';
  if (recordedBranch && recordedBranch !== branch) {
    err(`dispatch: ${repo} already has branch '${recordedBranch}' recorded, but`);
    err(`dispatch: work package ${id} was dispatched on '${branch}'.`);
    err("dispatch: a repository's work for a story lands on ONE branch. The plan");
    err('dispatch: names it once per repository and every package uses it verbatim.');
    err(`dispatch: fix the plan (bin/revise.sh ${STORY_ID} plan) rather than`);
    err(`dispatch: patching state — the commits are on '${recordedBranch}'.`);
    markPackage(id, 'failed');
    return 4;
  }

  // A package that got there has no stalled history worth carrying, and the
  // repository status is DERIVED from the packages rather than hardcoded. It
  // used to be written as "in_progress" every time, including when the last
  // package finished — so gates/child_ready.sh, which requires "ready", could
  // never pass however much work completed.
  const finalState = updateState((s) => {
    s.work_packages = derive.workPackages(s).map((w) =>
      (w.id === id ? { ...w, status: 'done', in_progress_rounds: 0 } : w));
    const rstatus = derive.repoStatus(s, repo);
    const repos = s.child_repos || [];
    s.child_repos = repos.some((r) => r.repo === repo)
      ? repos.map((r) => (r.repo === repo
        ? { ...r, branch, head_sha: headSha, status: rstatus }
        : r))
      : [...repos, { repo, slug, branch, head_sha: headSha, status: rstatus, retry_count: 0 }];
  });

  const repoStatus = (finalState.child_repos || [])
    .filter((r) => r.repo === repo).map((r) => r.status)[0] || '?';
  const left = derive.workPackages(finalState)
    .filter((w) => w.repo === repo && w.status !== 'done').map((w) => w.id);
  log(`work package ${id} complete at ${headSha}; ${repo} is now '${repoStatus}'`);
  if (left.length) log(`  still open in ${repo}: ${left.join(', ')}`);
  log(`run gates/child_ready.sh ${STORY_ID} ${repo} to verify against GitHub`);
  return 0;
}

// ------------------------------------------------------------------ the loop
// Dispatch every ready package, in dependency order, until none is left or one
// fails. `--one` restores the single-step behaviour for debugging.
if (ONE) process.exit(dispatchOne());

for (;;) {
  const code = dispatchOne();
  if (code === 1) process.exit(0);       // nothing ready, or all done
  if (code !== 0) process.exit(code);    // a real failure, or a halt
  const remaining = derive.workPackages(state.readQuiet(STATE) || {})
    .filter((w) => derive.statusOf(w) === 'pending');
  if (remaining.length === 0) break;
}
process.exit(0);
