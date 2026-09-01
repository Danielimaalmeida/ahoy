#!/usr/bin/env node
'use strict';
// bin/tick.js <STORY-ID> [--max-ticks N] [--no-agent] [--once] [--wait[=SECS]]
//
// Drives a story through knowledge/process/phases.tsv until it reaches a human
// gate, a terminal phase, or stops making progress.
//
// The change this represents: gates are run HERE, by the router, not by an
// agent. An agent keeps doing a phase's work; it no longer decides whether the
// gate passed, and it no longer writes `phase`. That removes the trust
// assumption the gates were written around — see gates/preflight.sh, and the
// note in gates/plan.sh about Cartographer being able to skip the script and
// report that it passed. Neither concern applies to a caller that cannot
// fabricate an exit code.
//
// Exit codes of this script:
//   0 story reached a human gate, terminal phase, or is waiting on external work
//   1 no progress (the same phase twice in a row with no route out)
//   2 environment broken — the harness cannot enforce its gates

const fs = require('fs');
const path = require('path');
const { root, statePath, tablePath, makeLog, err, die, haveCommand } = require('./lib/cli');
const state = require('./lib/state');
const table = require('./lib/table');
const derive = require('./lib/derive');
const profile = require('./lib/profile');
const session = require('./lib/session');
const proc = require('./lib/proc');

const ROOT = root();
const GATES = path.join(ROOT, 'gates');
const TABLE = tablePath(ROOT);
const AGENT_CMD = process.env.HARNESS_AGENT_CMD || 'copilot';

const USAGE = 'usage: bin/tick.sh <STORY-ID> [--max-ticks N] [--no-agent] [--once] [--wait[=SECS]]';

let MAX_TICKS = 20;
let RUN_AGENTS = true;
let ONCE = false;
let WAIT = false;
const WAIT_INTERVAL = Number(process.env.HARNESS_WAIT_INTERVAL || 30);
let WAIT_BUDGET = Number(process.env.HARNESS_WAIT_BUDGET || 1800);

const argv = process.argv.slice(2);
const STORY_ID = argv.shift() || '';
if (!STORY_ID) die(2, USAGE);

while (argv.length) {
  const a = argv.shift();
  if (a === '--max-ticks') { MAX_TICKS = Number(argv.shift()); continue; }
  if (a === '--no-agent') { RUN_AGENTS = false; continue; }
  if (a === '--once') { ONCE = true; continue; }
  if (a === '--wait') { WAIT = true; continue; }
  if (a.startsWith('--wait=')) { WAIT = true; WAIT_BUDGET = Number(a.slice('--wait='.length)); continue; }
  die(2, `unknown option: ${a}`);
}

// --once and --wait contradict each other: one says stop after a single routed
// transition, the other says keep polling until something changes. Refuse the
// pair rather than silently honouring whichever the code checks first.
if (ONCE && WAIT) die(2, 'tick: --once and --wait cannot be combined');

const STATE = statePath(ROOT, STORY_ID);
if (!fs.existsSync(STATE)) die(2, `tick: no state file at ${STATE}`);
if (!haveCommand('jq')) die(2, 'tick: jq is required');

const log = makeLog('tick', STORY_ID);

// ---------------------------------------------------------------- state I/O
function readState() { return state.read(STATE); }
function readPhase() { return (state.readQuiet(STATE) || {}).phase || ''; }

// setPhase(next, why, logType)
//
// decision_log is appended ONLY when a logType is given. delivery-phases.md is
// explicit that routine transitions are not logged: the phase history plus
// gate_results already reconstruct those, and only judgment calls and human
// decisions belong in decision_log.
function setPhase(next, why, logType) {
  try {
    state.update(STATE, (s) => {
      s.phase = next;
      if (logType && logType !== '-') {
        s.decision_log = [
          ...(s.decision_log || []),
          {
            timestamp: state.nowISO(),
            actor: 'tick',
            type: logType,
            summary: `phase -> ${next}: ${why}`,
          },
        ];
      }
    }, 'tick');
  } catch {
    die(2, 'tick: refused to write invalid state');
  }
  log(`phase -> ${next} (${why})`);
}

// --------------------------------------------------------------- the menu
//
// What you are deciding on, then the options. The summary is not decoration: a
// choice made without re-reading what it is about is not much of a gate, and
// `plan_review` exists for the one thing no gate can check — whether the
// criteria actually cover the ticket.
function gateSummary(phase) {
  const s = readState();
  if (phase === 'plan_review') {
    const acs = s.acceptance_criteria || [];
    const wps = s.work_packages || [];
    const repos = [...new Set(wps.map((w) => w.repo))].join(', ');
    process.stdout.write(`  plan: ${s.plan_path || '(unset)'}\n`);
    process.stdout.write(`  ${acs.length} acceptance criteria, ${wps.length} work package(s) across: ${repos || 'none'}\n`);
    process.stdout.write('\n');
    for (const ac of acs) process.stdout.write(`    ${ac.id}: ${ac.text || ''}\n`);
    process.stdout.write('\n  Nothing upstream checks whether these COVER the ticket. That is this gate.\n');
  } else if (phase === 'delivery_gate') {
    for (const r of s.child_repos || []) {
      process.stdout.write(`  ${r.repo}: ${r.pr_url || '(no pr)'}\n`);
    }
    const unmet = [...new Set((s.lookout_reviews || []).flatMap((r) =>
      Object.entries(r.criteria_verdicts || {}).filter(([, v]) => v !== 'met').map(([k]) => k)))];
    if (unmet.length) process.stdout.write(`  criteria not verified as met: ${unmet.join(', ')}\n`);
    process.stdout.write('  both reviews passed gates/consensus.sh\n');
  }
}

// ----------------------------------------------- stuck work packages
//
// A package in `unverified`, `stalled`, `blocked` or `failed` is never
// dispatched — dispatch only picks up `pending` — so the story cannot move until
// someone decides. That decision used to be a jq incantation pasted from an
// error message, run four or five times in one evening.
//
// It is the same shape as the two human gates: accept what happened, or send it
// round again. So it belongs in the same place, and the jq disappears.
//
// `unverified` is the one that matters. It means the work may well be right but
// a check could not run, so nobody has evidence. Accepting it is a real choice
// with a real cost, and it should look like one.

// Delegated to bin/decide.js rather than written here.
//
// The menu is one front end for this decision and the web UI is another, and a
// decision written in two places is a shape that drifts — which is the exact
// failure the single-writer rule for human_gates exists to prevent. decide also
// validates that the package is genuinely stuck and recomputes the repository
// status, neither of which this menu was doing.
function setPackageStatus(id, action, note) {
  const args = [path.join(ROOT, 'bin', 'decide.js'), STORY_ID, id, action];
  if (note) args.push('--', note);
  return proc.run(process.execPath, args).code === 0;
}

// Returns true if something changed and the loop should carry on, false to stop.
function stuckPackageMenu() {
  const rows = derive.stuckPackages(readState());
  if (rows.length === 0) return false;
  if (!proc.haveTTY()) {
    log('work package(s) need a decision; re-run from a terminal, or edit state.json');
    return false;
  }

  for (const row of rows) {
    const { id } = row;
    const st = row.status;
    process.stdout.write('\n');
    process.stdout.write(`${STORY_ID} — ${id}\n`);
    process.stdout.write(`  agent:  ${row.agent || '?'}\n`);
    process.stdout.write(`  status: ${st}\n`);
    if (st === 'unverified') {
      process.stdout.write('\n  The work may well be correct, but a check it needed could not run,\n');
      process.stdout.write('  so nobody has evidence. Accepting it means accepting that.\n');
    } else if (st === 'stalled') {
      process.stdout.write('\n  It reported the same thing twice without finishing. Running the same\n');
      process.stdout.write('  agent again will not change that.\n');
    } else if (st === 'blocked') {
      if (row.blocker_question) process.stdout.write(`\n  It asked: ${row.blocker_question}\n`);
    } else if (st === 'failed') {
      process.stdout.write('\n  It produced no usable report, or contradicted the repository.\n');
    }
    if (row.rework_note) process.stdout.write(`  last note: ${row.rework_note}\n`);
    process.stdout.write(`  reports:  specs/${STORY_ID}/reports/\n`);

    let decided = false;
    while (!decided) {
      decided = true;
      process.stdout.write('\n');
      process.stdout.write('  1) accept    — treat it as delivered and move on\n');
      process.stdout.write('  2) retry     — say what to fix; dispatch the agent again\n');
      process.stdout.write('  3) skip      — leave it; decide later\n');
      process.stdout.write('\n> ');
      // From /dev/tty, not stdin. A read of inherited stdin here consumed the
      // package list rather than the keystroke, hit EOF immediately, and the
      // menu printed its options and gave up in the same breath — which is
      // exactly what it did the first time a package needed a decision.
      const choice = proc.readLineFromTTY();
      if (choice === null) return false;
      if (['1', 'a', 'A'].includes(choice)) {
        if (!setPackageStatus(id, 'accept')) return false;
      } else if (['2', 'r', 'R'].includes(choice)) {
        process.stdout.write('\nWhat should change? (empty to retry unchanged)\n> ');
        const reason = proc.readLineFromTTY();
        if (reason === null) return false;
        if (!setPackageStatus(id, 'retry', reason)) return false;
      } else if (['3', 's', 'S'].includes(choice)) {
        log(`${id} left as ${st}`);
      } else if (choice === '') {
        // An empty answer is not "skip". It is no answer, and it arrives by
        // accident far more often than on purpose — a stray newline in the
        // terminal buffer answered this menu once and silently skipped a
        // decision the operator never made. Re-ask.
        process.stdout.write('No default here on purpose. Choose 1, 2 or 3.\n');
        decided = false;
      } else {
        process.stdout.write('Not an option. Choose 1, 2 or 3.\n');
        decided = false;
      }
    }
  }

  // Carry on only if something is now dispatchable.
  return derive.workPackages(readState()).some((w) => derive.statusOf(w) === 'pending');
}

// Returns true to continue the loop, false to stop.
function humanGateMenu(phase, humanKey) {
  const short = humanKey.replace(/_accepted$/, '');
  for (;;) {
    process.stdout.write('\n');
    process.stdout.write(`${phase} — ${STORY_ID}\n`);
    gateSummary(phase);
    process.stdout.write('\n');
    process.stdout.write('  1) approve  — record the decision and carry on\n');
    process.stdout.write('  2) revise   — say what to change; back to the agent that made it\n');
    process.stdout.write('  3) chat     — open a session to talk it through, change nothing\n');
    process.stdout.write('  4) quit     — decide later; nothing is recorded\n');
    process.stdout.write('\n> ');
    const choice = proc.readLineFromTTY();
    if (choice === null) { process.stdout.write('\n'); return false; }

    if (['1', 'a', 'A'].includes(choice)) {
      const r = proc.run(process.execPath,
        [path.join(ROOT, 'bin', 'approve.js'), STORY_ID, short, '--no-continue']);
      return r.code === 0;
    }
    if (['2', 'r', 'R'].includes(choice)) {
      process.stdout.write('\nWhat should change?\n> ');
      const reason = proc.readLineFromTTY();
      if (reason === null) return false;
      if (!reason) {
        process.stdout.write('A revision with no reason is how the agent ends up guessing. Nothing done.\n');
        continue;
      }
      const r = proc.run(process.execPath,
        [path.join(ROOT, 'bin', 'revise.js'), STORY_ID, short, '--no-continue', '--', reason]);
      return r.code === 0;
    }
    if (['3', 'c', 'C'].includes(choice)) {
      // A session to think in. Nothing is recorded and no phase moves — the
      // decision is still made at this menu afterwards.
      const rows = table.load(TABLE);
      const producer = table.producerOf(rows, phase);
      let actor = producer ? ((table.rowFor(rows, producer) || {}).actor || '') : '';
      if (!actor || actor === '-' || actor.startsWith('bin/')) actor = 'cartographer';
      const csid = producer ? sessionIdFor(producer) : '';
      // A pointer for any session launched without a prompt. An agent started
      // bare has no idea which story it is looking at; this is where it finds out.
      try {
        fs.writeFileSync(path.join(ROOT, 'specs', '.current-story'), `${STORY_ID}\n`);
      } catch { /* the pointer is a convenience, not a dependency */ }
      if (csid) {
        // Resuming beats starting cold: a conversation about a plan is worth
        // far more with the agent that wrote it, holding what it already
        // considered and rejected.
        process.stdout.write(`\nResuming the ${actor} session that produced this. Exit to come back here.\n`);
        process.stdout.write('Nothing you do there records a decision.\n\n');
        proc.run(AGENT_CMD, [`--resume=${csid}`, '--allow-tool', interactiveGrant(actor)]);
      } else {
        process.stdout.write(`\nOpening a session with ${actor}. It reads the story from specs/.current-story.\n`);
        process.stdout.write('Exit it to come back here. Nothing you do there records a decision.\n\n');
        proc.run(AGENT_CMD, [`--agent=${actor}`, '--allow-tool', interactiveGrant(actor)]);
      }
      continue;
    }
    if (['4', 'q', 'Q'].includes(choice)) {
      process.stdout.write(`\nNothing recorded. Resume with: bin/run.sh ${STORY_ID}\n`);
      return false;
    }
    if (choice === '') {
      process.stdout.write('No default here on purpose. Choose 1, 2, 3 or 4.\n');
      continue;
    }
    process.stdout.write('Not an option. Choose 1, 2, 3 or 4.\n');
  }
}

// The grant for an agent tick runs directly. Same rule as bin/dispatch.js: the
// profile's tools list is what the agent may use, and a fixed string here would
// silently overrule it.
function interactiveGrant(agent) {
  if (process.env.HARNESS_ALLOW_TOOLS) return process.env.HARNESS_ALLOW_TOOLS;
  const g = profile.controlPlaneTools(ROOT, agent) || 'shell,write,edit';
  return profile.ensure(g, 'shell', 'write');
}

// ------------------------------------------------------------ agent sessions
// See bin/lib/session.js for why the harness drives a session rather than
// starting a cold one every round, and why a lost session costs context and
// not the round.
const sessionIdFor = (phase) => session.idFor(STATE, phase);
const rememberSession = (phase, id) => session.remember(STATE, phase, id);
const newSessionId = () => session.newId();

// Bills a finished agent run to the story. Never fatal: bookkeeping that can
// stop a delivery is worse than bookkeeping that is occasionally incomplete,
// and the ledger it reads is written by another process on its own schedule.
function recordCredits(session, phase, actor) {
  if (!session) return;
  proc.run(process.execPath, [
    path.join(ROOT, 'bin', 'credits.js'), STORY_ID, 'record',
    '--session', session, '--phase', phase || '', '--actor', actor || '',
  ], { stdio: 'ignore' });
}

// ------------------------------------------------------------------- actors
let RERUN_ACTOR = false;

function runActor(actor, phase, interactive) {
  if (actor === '-') return;
  if (!RUN_AGENTS) { log(`skipping actor '${actor}' (--no-agent)`); return; }

  // A bin/ actor is a harness script, not an agent. It owns its own agent
  // invocations (dispatch runs specialists in child worktrees; review runs the
  // two lookouts with the models it assigns), so tick just calls it.
  if (actor.startsWith('bin/')) {
    log(`running ${actor} for phase '${phase}'`);
    // The .sh shim and the .js are the same command; prefer the .js so the
    // router does not depend on a shell being present to reach its own actors.
    const script = actor.replace(/\.sh$/, '.js');
    const target = fs.existsSync(path.join(ROOT, script))
      ? [process.execPath, path.join(ROOT, script)]
      : [path.join(ROOT, actor)];
    const acode = proc.run(target[0], [...target.slice(1), STORY_ID]).code;

    // Non-zero is not fatal here: the gate below is what decides. A dispatch
    // that could not proceed leaves the gate reporting `not yet`, which is the
    // correct route.
    //
    // Exit 4 from an actor is a halt, and it outranks the gate. The gate below
    // can only report "not yet", and with --wait that becomes a poll — which is
    // exactly wrong when the actor has just said nothing external will change.
    // Left as exit 1, a failed work package produced the same message every
    // thirty seconds for the whole wait budget.
    if (acode === 4) {
      // A halt means a person has to choose. Offer the choice here rather than
      // printing a jq command for them to paste.
      if (process.env.HARNESS_NO_MENU !== '1' && stuckPackageMenu()) {
        RERUN_ACTOR = true;
        return;
      }
      log(`${actor} halted: a human must decide. Not polling.`);
      process.exit(0);
    }
    if (acode !== 0) log(`${actor} exited ${acode}; continuing to the gate`);
    return;
  }

  let prompt = `Story ${STORY_ID}. Perform ONLY the '${phase}' phase action from knowledge/process/delivery-phases.md. Do not run gates. Do not write .phase. Write only the state fields your profile permits, then stop.`;

  // A revision is not a first run, and the same prompt for both is why a
  // revision round once produced a plan revised by the agent's judgement rather
  // than the human's. If a reason was recorded, lead with it: the artifact
  // exists, someone read it, and this is what they want different.
  const revisionReason = (state.readQuiet(STATE) || {}).revision_reason || '';
  if (revisionReason) {
    prompt = `Story ${STORY_ID}. This is a REVISION, not a first pass. Your previous ${phase} output is already on disk — read it first and change it. Do not start over.

What the human wants changed:
${revisionReason}

Address that specifically. If it is ambiguous, ask before editing. Do not run gates, do not write .phase, and write only the state fields your profile permits.`;
  }

  // A pointer for any session launched without a prompt, including the `chat`
  // option at a human gate.
  try {
    fs.writeFileSync(path.join(ROOT, 'specs', '.current-story'), `${STORY_ID}\n`);
  } catch { /* the pointer is a convenience, not a dependency */ }

  if (interactive === 'yes') {
    // The agent gets this terminal. No --no-ask-user, no output capture: the
    // human is present and can answer, which is the entire point of the phase.
    // Cartographer's plan is only as good as the questions it was allowed to
    // ask, and unattended it cannot ask any — under --no-ask-user every
    // question becomes a silent denial, not a prompt.
    if (!process.stdin.isTTY) {
      err(`tick: phase '${phase}' is interactive but stdin is not a terminal.`);
      err('tick: run it from a shell, or re-run with --no-agent to skip the actor.');
      process.exit(2);
    }
    log(`handing the terminal to '${actor}' for phase '${phase}'`);
    log('  answer its questions, then exit the session to continue.');

    // --autopilot WITHOUT --no-ask-user. The two flags do different jobs and
    // only one of them is the problem for an interactive phase:
    //
    //   --autopilot      keeps the session going across turns
    //   --no-ask-user    turns every question into a silent denial
    //
    // Dropping both left the agent with one turn: it asked its question and the
    // process ended before anyone could answer, which is how a three-minute
    // planning session produced no plan and a run of "could not request
    // permission from user" — there was no continuation to grant anything into.
    const continues = String(process.env.HARNESS_INTERACTIVE_CONTINUES || 60);
    let sid = sessionIdFor(phase);
    if (sid) {
      log(`  resuming session ${sid} — it remembers the earlier rounds`);
      const rc = proc.run(AGENT_CMD, [
        `--resume=${sid}`, '--prompt', prompt,
        '--allow-tool', interactiveGrant(actor),
        '--autopilot', '--max-autopilot-continues', continues,
      ]).code;
      recordCredits(sid, phase, actor);
      if (rc !== 0) {
        // Pruned, expired, or on another machine. The plan is on disk; a cold
        // session can still do the work, so this costs context and not the round.
        log(`  resume failed (exit ${rc}); falling back to a fresh session`);
        rememberSession(phase, '');
        sid = '';
      }
    }
    if (!sid) {
      sid = newSessionId();
      log(`  new session ${sid}`);
      rememberSession(phase, sid);
      const rc = proc.run(AGENT_CMD, [
        `--agent=${actor}`, '--session-id', sid, '--prompt', prompt,
        '--allow-tool', interactiveGrant(actor),
        '--autopilot', '--max-autopilot-continues', continues,
      ]).code;
      if (rc !== 0) {
        log(`actor '${actor}' exited non-zero; continuing to the gate, which is the thing that decides`);
      }
      recordCredits(sid, phase, actor);
    }
    return;
  }

  log(`dispatching actor '${actor}' for phase '${phase}'`);
  // A session id is assigned even though nothing resumes this one: it is what
  // makes the run's cost attributable to this story afterwards. Without it the
  // session is indistinguishable in the ledger from any other run in this
  // directory, including the ones a person started by hand.
  const oneshotSid = newSessionId();
  // The agent does the phase's work. It is not asked whether the gate passed,
  // and it is not permitted to write `phase` — this script does that below.
  const rc = proc.run(AGENT_CMD, [
    `--agent=${actor}`, '--session-id', oneshotSid, '--prompt', prompt,
    '--allow-tool', interactiveGrant(actor),
    '--autopilot', '--no-ask-user', '--max-autopilot-continues', '15', '-s',
  ]).code;
  if (rc !== 0) {
    log(`actor '${actor}' exited non-zero; continuing to the gate, which is the thing that decides`);
  }
  recordCredits(oneshotSid, phase, actor);
}

// -------------------------------------------------------------------- gates
function runGate(script, args) {
  log(`running gates/${script} ${args.join(' ')}`);
  return proc.runGate(GATES, script, args).code;
}

// Repos that branched, and what the gate said about each. A branch means the
// gate found evidence the agent must act on — failing CI, say — and that text is
// the whole reason a re-run might succeed where the first attempt did not.
let BRANCHED_REPOS = [];
let BRANCHED_REASON = '';

function repoAliases() {
  return ((state.readQuiet(STATE) || {}).child_repos || []).map((r) => r.repo).filter(Boolean);
}

function runPerRepoGate(script) {
  let worst = 0;
  BRANCHED_REPOS = [];
  BRANCHED_REASON = '';
  for (const repo of repoAliases()) {
    const { code, out } = proc.runGate(GATES, script, [STORY_ID, repo], { capture: true });
    if (out) process.stderr.write(out.endsWith('\n') ? out : out + '\n');
    log(`  ${repo}: gates/${script} -> ${code}`);
    if (code === 2) return 2;
    if (code === 3) {
      BRANCHED_REPOS.push(repo);
      BRANCHED_REASON += out + '\n';
    }
    if (code > worst) worst = code;
  }
  return worst;
}

// ------------------------------------------------- back to implementation
//
// A gate branched during `implementation` — CI is red on a pull request the
// harness opened. Nothing external will fix that, and the agent that wrote the
// code is the one that can.
//
// So: reopen that repository's work packages, attach what the gate reported as
// a rework_note so the fixer is told what is broken rather than left to guess,
// and put the repository back to in_progress. The next tick dispatches it again.
//
// gates/rework_ceiling.sh has already run and incremented retry_count, so this
// is bounded exactly like a Lookout-driven rework. A build nobody can fix stops
// for a human rather than burning the wait budget.
function reopenForFix() {
  const note = BRANCHED_REASON.split('\n').slice(0, 40).join('\n');
  for (const repo of BRANCHED_REPOS) {
    try {
      state.update(STATE, (s) => {
        derive.reopenRepoPackages(s, repo, note);
        s.decision_log = [
          ...(s.decision_log || []),
          {
            timestamp: state.nowISO(),
            actor: 'tick',
            type: 'rework',
            summary: `reopened ${repo} work packages: gate reported failing checks`,
          },
        ];
      }, 'tick');
    } catch {
      die(2, 'tick: refused to write invalid state');
    }
    log(`reopened ${repo}'s work packages with the gate's report attached`);
  }
}

// --------------------------------------------------------------- rework path
// The prose rule was "call rework_ceiling.sh exactly once per rework decision,
// from the pr_review fail path only, and do not call it from the rework row."
// That is an instruction an agent can forget. Here it is the only place the
// script is reachable from, so it cannot be called twice or from the wrong row.
function enterRework() {
  let anyHalt = false;
  for (const repo of repoAliases()) {
    const code = proc.runGate(GATES, 'rework_ceiling.sh', [STORY_ID, repo]).code;
    log(`  ${repo}: rework_ceiling -> ${code}`);
    if (code === 2) return 2;
    if (code !== 0) anyHalt = true;
  }
  if (anyHalt) {
    setPhase('blocked', 'rework ceiling reached; escalating to a human', 'rework_escalation');
    return 4;
  }
  return 0;
}

// ---------------------------------------------------------------- preflight
{
  const pre = proc.runGate(GATES, 'preflight.sh', [], { capture: true });
  if (pre.code !== 0) {
    err(`tick: preflight failed (exit ${pre.code}); the harness cannot enforce its gates`);
    proc.runGate(GATES, 'preflight.sh', []);
    process.exit(2);
  }
}
log('preflight ok');

// --------------------------------------------------------------- the loop
let ticks = 0;
let waited = 0;
const rows = table.load(TABLE);

function sleepSeconds(seconds) {
  // Synchronous, like the `sleep` it replaces: the router is a linear script,
  // and an async wait here would turn it inside out for no gain.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

for (;;) {
  ticks += 1;
  if (ticks > MAX_TICKS) {
    log(`max ticks (${MAX_TICKS}) reached; stopping`);
    process.exit(0);
  }

  const phase = readPhase();
  if (!phase) die(2, 'tick: state.json has no .phase');

  const row = table.rowFor(rows, phase);
  if (!row) die(2, `tick: phase '${phase}' is not in ${TABLE}`);

  const { kind, actor, on_pass: onPass, on_branch: onBranch, on_fail: onFail } = row;
  const humanKey = row.human_gate_key;
  const logType = row.log;
  const interactive = row.interactive || 'no';
  let gate = row.gate;
  log(`phase '${phase}' (kind=${kind})`);

  if (kind === 'human') {
    // The human's approval already lives in state.json, written by
    // bin/approve.js in response to an explicit decision. Reading it is not an
    // agent declaring its own success, so the router may advance on it.
    const approved = derive.humanGateStatus(readState(), humanKey);
    if (approved === 'approved') {
      setPhase(onPass, `human_gates.${humanKey} is approved`, logType);
      if (ONCE) process.exit(0);
      continue;
    }
    if (approved.startsWith('MALFORMED:')) {
      err(`tick: human_gates.${humanKey} is a ${approved.slice('MALFORMED:'.length)}, not an object.`);
      err('tick: expected {"status": "approved", "timestamp": "..."}.');
      err('tick: a malformed gate is NOT approval. Record the decision with:');
      err(`  bin/approve.sh ${STORY_ID} ${humanKey.replace(/_accepted$/, '')}`);
      process.exit(2);
    }
    // A menu, but only when a person is actually there. Piped or scheduled,
    // this falls back to printing the command and stopping — a prompt that
    // blocks forever in CI is worse than no prompt.
    //
    // No default and no timeout, deliberately. Enter alone does nothing and
    // nothing auto-approves after waiting. A menu is precisely where "silence
    // is never approval" gets quietly broken, because a default feels like a
    // convenience right up until it approves something nobody read.
    if (process.stdin.isTTY && process.env.HARNESS_NO_MENU !== '1') {
      if (humanGateMenu(phase, humanKey)) continue;
      process.exit(0);
    }
    log(`human gate '${humanKey}' at phase '${phase}' is '${approved}'; stopping.`);
    log(`Record the decision with: bin/approve.sh ${STORY_ID} ${humanKey.replace(/_accepted$/, '')}`);
    log('Silence is never approval.');
    process.exit(0);
  }

  if (kind === 'terminal') {
    log(`terminal phase '${phase}'; nothing to do.`);
    process.exit(0);
  }

  RERUN_ACTOR = false;
  runActor(actor, phase, interactive);

  // A decision was just made about a stuck work package, so the actor has
  // something new to do. Run it again before the gate, which would otherwise
  // report "not yet" against state that changed a second ago.
  if (RERUN_ACTOR) {
    RERUN_ACTOR = false;
    ticks -= 1;
    continue;
  }

  // The reason applied to the round that just ran. Leaving it would make the
  // next revision, or a later re-run of this phase, replay an instruction that
  // was already carried out.
  if ((state.readQuiet(STATE) || {}).revision_reason) {
    state.updateQuiet(STATE, (s) => { delete s.revision_reason; });
  }

  // Phases with no gate are pure routing rows (e.g. rework -> implementation).
  if (gate === '-') {
    setPhase(onPass, 'no gate for this phase; routing per the phase table', logType);
    if (ONCE) process.exit(0);
    continue;
  }

  let code = 0;
  if (kind === 'implementation') {
    // An empty child_repos[] means no work package has been dispatched yet, not
    // that every repo is ready. Without this guard runPerRepoGate iterates
    // nothing, returns 0, and pr.sh is asked to verify a delivery that has not
    // started — it fails safe, but records a misleading `fail` in gate_results.
    if (repoAliases().length === 0) {
      log('child_repos[] is empty: no work packages dispatched yet.');
      log(`Dispatch per the approved plan, then re-run. Staying in '${phase}'.`);
      process.exit(0);
    }
    // delivery-phases.md: child_ready.sh once a repo's last work package
    // returns ready; once ALL repos pass, pr.sh; only then -> pr_review.
    code = runPerRepoGate(gate);
    if (code === 0) {
      log(`all repos passed gates/${gate}; running gates/pr.sh`);
      code = runGate('pr.sh', [STORY_ID]);
      gate = 'pr.sh';
    }
  } else {
    code = runGate(gate, [STORY_ID]);
  }
  log(`gates/${gate} -> exit ${code}`);

  if (code === 0) {
    setPhase(onPass, `gates/${gate} passed`, '-');
  } else if (code === 1) {
    if (onFail === 'stay' || onFail === '-') {
      // `not yet` is the CI case: the pull request exists and its checks are
      // still running. Polling is the correct response and the only reason the
      // operator was re-running this script by hand.
      if (WAIT) {
        if (waited >= WAIT_BUDGET) {
          log(`gates/${gate} still reports 'not yet' after ${waited}s of waiting; giving up.`);
          log('The story is untouched. Re-run when the external state has changed.');
          process.exit(0);
        }
        log(`gates/${gate} reports 'not yet'; sleeping ${WAIT_INTERVAL}s (${waited}/${WAIT_BUDGET}s used)`);
        sleepSeconds(WAIT_INTERVAL);
        waited += WAIT_INTERVAL;
        // Waiting is not a tick: a poll that changed nothing should not spend
        // the progress budget that exists to catch a stuck story.
        ticks -= 1;
        continue;
      }
      log(`gates/${gate} reports the condition is not met yet; staying in '${phase}'.`);
      log('Re-run tick after the external state changes, or use --wait to poll.');
      process.exit(0);
    }
    setPhase(onFail, `gates/${gate} failed: ${phase}`, logType);
    process.exit(0);
  } else if (code === 2) {
    die(2, `tick: gates/${gate} could not run (environment). Fix the environment; the story is untouched.`);
  } else if (code === 3) {
    if (onBranch === '-') {
      die(2, `tick: gates/${gate} branched but phase '${phase}' has no on_branch route`);
    }
    const rc = enterRework();
    if (rc === 0) {
      // Branching back to the SAME phase means fixing in place rather than
      // entering the rework phase: the packages reopen, the repository goes
      // back to in_progress, and the next tick dispatches the fixer.
      if (onBranch === phase) {
        reopenForFix();
        log(`staying in '${phase}' to fix what the gate reported`);
        if (ONCE) process.exit(0);
        continue;
      }
      setPhase(onBranch, `gates/${gate} routed to rework`, 'rework');
    } else if (rc === 4) {
      process.exit(0);
    } else {
      process.exit(2);
    }
  } else if (code === 4) {
    log(`gates/${gate} halted: a human must decide. Stopping without changing phase.`);
    process.exit(0);
  } else {
    die(2, `tick: gates/${gate} returned unexpected code ${code}`);
  }

  if (ONCE) process.exit(0);

  // A branch back to the same phase is progress even though `phase` is
  // unchanged: work packages reopened and the repository moved to in_progress,
  // so the next tick does something different. The ceiling bounds it.
  if (readPhase() === phase && BRANCHED_REPOS.length === 0) {
    die(1, 'tick: phase did not change after a routed tick; stopping to avoid a loop');
  }
  BRANCHED_REPOS = [];
}
