# Decisions

Each entry records a decision and the failure or constraint that forced it.

This file starts at the bash-to-Node port of `bin/`. Decisions that predate it
are recorded where they were made: the comments in `gates/*.sh`, the Notes
section of [knowledge/process/delivery-phases.md](/knowledge/process/delivery-phases.md),
and the failure list in [gates/README.md](/gates/README.md). Those were not
back-filled here, because reconstructing a team's reasoning from its artifacts
produces a plausible history rather than a true one.

---

## The port: `bin/` is Node, `gates/` stays bash

`bin/` was ten bash scripts, about 3,000 lines, most of it `jq` filters
assembling and re-writing `state.json`. `gates/` is seven scripts that ask
GitHub a question and put an exit code on the end.

Those are different jobs, and only one of them is a good fit for shell.

**The line: the shell asks GitHub questions; JS decides what to do with the
answers.** Every script in `bin/` is now `.js`. Nothing in `gates/` changed
except the one fix recorded below, and the gates are invoked with the same
argv, the same environment, and the same exit code read and routed on
unchanged.

`bin/serve.py` was deliberately left alone. Changing two layers at once means a
failure afterwards is ambiguous about which layer caused it.

### Constraints this port had to hold

- **Node standard library only.** No dependencies, no build step, no
  TypeScript. These run on locked-down work laptops where `npm install` is not
  a step anyone can rely on. There is no `package.json`, so the harness is plain
  CommonJS and there is nothing to configure.
- **`state.json` keeps its exact shape.** Every field in the child dispatch
  contract's "Schema additions" is untouched. A running story survives the port
  with no migration — [tests/cases/state-shape.test.js](/tests/cases/state-shape.test.js)
  asserts that every story under `specs/` round-trips byte-identically against
  `jq .`, which is what the previous writers produced.
- **`phases.tsv` is still the state machine.** Nothing in `bin/` hardcodes a
  phase, an actor or a route. `bin/lib/table.js` reads the file;
  `bin/approve.js` resolves a gate name against it rather than a list of its
  own, so a human gate added to the table is approvable without touching code.

### Thin `.sh` shims stay

Every `bin/x.sh` is now two lines that `exec node .../x.js "$@"`.

They are not politeness. `bin/serve.py` invokes these scripts by path —
`ROOT / "bin" / "approve.sh"` — and runs `tick.sh` under a pty to stream the
router into the browser. Keeping the names meant the UI, every runbook, every
cron entry and everyone's muscle memory needed no change, and `serve.py` stayed
literally untouched. `exec` matters beyond tidiness for `tick.sh`: the process
the UI signals has to be the router itself, not a shell holding its hand.

### What moved into `bin/lib/`

The bash had the same logic pasted into several scripts — the `tools:` parser
lived in `dispatch.sh`, `review.sh` and `tick.sh`; the mapping resolver in
`dispatch.sh` and `repo.sh`; the repo-status fold in `dispatch.sh` and
`decide.sh`. Each copy was a place for a drift to start, and `repo.sh`'s own
header says a second copy of the URL-building logic had already drifted once.

There is now one of each, in `bin/lib/`, and the tests import them.

### `credits.js` still shells out to `python3`

The Copilot usage ledger is a SQLite database. Node's own `node:sqlite` is
experimental and flag-gated on the Node 22 these laptops have, so using it would
have traded a working read for a warning and a runtime flag.

The read was already a `python3` subprocess inside `credits.sh`, so keeping it
adds no dependency that was not there before. It is the same division as
everywhere else here: something else asks the awkward question, and JavaScript
decides what to do with the answer.

### `readLineFromTTY` replaces `read -r x < /dev/tty`

Every human prompt in the harness reads from `/dev/tty`, never from inherited
stdin. In bash this was spelled at each prompt; here it is one function in
`bin/lib/proc.js` that opens `/dev/tty` itself.

The failure it guards against is the same one: the stuck-package menu iterates a
list of rows, and a read of inherited stdin consumes the package list rather
than the keystroke, hits EOF, and prints the options and gives up in the same
breath. `tests/cases/tick.test.js` asserts the router touches `process.stdin`
only to ask whether it is a terminal.

---

## `gates/plan.sh` was missing two checks that existed in the repository

Found during the port, and fixed as a deliberate one-time exception to leaving
`gates/` alone.

`bin/plan.sh` existed. Nothing invoked it — the phase table names the gate
`plan.sh`, and the router resolves that to `gates/plan.sh`. It was a stale copy
of the gate carrying **31 lines the live gate did not have**: the
one-branch-per-repository check and the branch-prefix check, with the comment
explaining what they were for:

> A plan gave two packages in one repository the branches `feature/X` and
> `feature/X-a11y`. Both ran in the same worktree, so every commit landed on the
> first — but `child_repos[].branch` recorded whichever package finished last,
> and `gates/child_ready.sh` went looking for a pull request on a branch that
> did not exist. Everything was done and the gate correctly said no.

The old `tests/run.sh` asserted that rule by **reimplementing the `jq` inline**
and asserting against the reimplementation. It passed. The gate that actually
runs had no such check, so a plan naming two branches for one repository would
have reached implementation exactly as it did the first time.

The checks were moved into `gates/plan.sh` and `bin/plan.sh` was deleted. The
tests now run the real gate: see the branch cases in
[tests/cases/gates-plan-intake.test.js](/tests/cases/gates-plan-intake.test.js).

This is the clearest argument in the repository for the rule the next section
records.

---

## Tests assert against the shipping code, not a copy of it

About sixty of the old suite's assertions did not test `bin/` at all. They
pasted a `jq` filter into the test file — `derive()`, `movable()`, `classify()`,
`split_branches()`, `at_ceiling()`, `profile_tools()`, `resolve_open_pr()` — and
asserted that the paste behaved as described.

That is a specification written twice, and the two copies can disagree without
anything going red. `gates/plan.sh` above is what that looks like when it
happens.

Those assertions now import the real function from `bin/lib/`, or run the real
gate. Same cases, same comments, same failures behind them.

Two of them had no Node function to import, because the logic is in bash and
stays there:

- **the check-rollup classification** (`classify()`) is in
  `gates/child_ready.sh`. The bash suite tested it twice — once through the real
  gate with the `gh` stub, and once against an inline copy. The cases only the
  copy covered were folded into the real-gate tests.
- **the split-branch and prefix rules** are now in `gates/plan.sh`, and are
  tested through it.

### The old suite was not clean, and one green line meant "nothing ran"

Baseline before the port: **158 passed, 1 failed**.

`expect` deleted the sandbox on its way out. The `bin/decide.sh` block called it
three times in a row, so the second and third assertions ran `cd` into a
directory that no longer existed:

```
expect 1 "a package that is not stuck is refused"      # deletes ${WS}
expect 1 "an unknown package is refused"               # ${WS} gone -> cd fails -> exit 1 -> FALSE PASS
expect 2 "an action that is neither accept nor retry"  # ${WS} gone -> exit 1 -> real FAIL
```

The suite documents this exact hazard at its own line 78 and added `expect_keep`
to avoid it; this block did not use it. `bin/decide.sh` was never at fault — run
against a live workspace it exits 2 for a bad action and 1 for an unknown
package, as asserted.

A workspace is now a value handed to one test, not a global, so it cannot be
deleted out from under the next assertion. All three assertions run, and pass.

### The bash 3.2 portability checks were removed

The old suite ended with four checks that scanned `bin/*.sh` and `gates/*.sh`
for constructs macOS's bash 3.2 cannot parse:

- no `"$(cat <<EOF ...)"` — a heredoc inside a command substitution, where 3.2's
  parser does not skip the body while looking for the closing `)`, so an
  apostrophe in the prompt text broke the file and reported the error hundreds
  of lines later;
- no bash 4+ syntax — `mapfile`, `declare -A`, `${var,,}`;
- no `${var:+...}` spanning more than one line;
- no GNU-only `grep -P` / `cat -A`.

Every one of those was about a script in `bin/`, and every script in `bin/` is
now JavaScript. The prompts they constrained are plain template literals, which
is why `dispatch.js` and `review.js` no longer write a heredoc to a temp file
and read it back — that round trip existed only to keep bash 3.2 parsing.

The comments explaining *why* the constraint existed were carried into the Node
prompt-building code, so the next person to touch those strings knows what the
scar tissue was for.

`gates/*.sh` is still bash and still runs on macOS. Those constraints still
apply to it; they are documented in the Requirements section of
[gates/README.md](/gates/README.md), which was always their real home. Nothing
now scans for them automatically. If the gates grow, that check is worth
restoring **scoped to `gates/`** — it was deleted because it had no subject
left, not because it was wrong.

---

## `dispatch.js` prints `bin/decide.sh` where `dispatch.sh` printed `jq`

A small behaviour change, made knowingly.

When dispatch halts on a package nothing can move, `dispatch.sh` printed a
pasteable `jq` incantation for editing `state.json` by hand. That advice
predates `bin/decide.sh`, whose entire reason for existing is that resetting a
stuck package meant pasting `jq` from an error message four or five times in one
evening — and which also validates that the package is genuinely stuck and
recomputes the repository status, neither of which the `jq` line does.

The messages now name `bin/decide.sh`. Everything else about the halt is
unchanged, including the exit code.

---

## What did not change

- The exit-code contract: `0` pass, `1` not yet, `2` environment, `3` branch,
  `4` halt. `1` still means something outside might change, so polling is
  correct, and everything else still means it will not.
- No agent decides whether its own gate passed. The router runs the gate and
  switches on the exit code. Nothing else moves `phase`.
- One writer per decision. Human gates are written only by `bin/approve.js` and
  cleared by `bin/revise.js`; work-package decisions only by `bin/decide.js`.
  The terminal menu and the web UI both call those.
- `{status, timestamp}` for human gates, strictly. A bare boolean is rejected
  loudly, and `pending` counts as unset rather than as a decision.
- Tool grants come from the agent's own profile, never a hardcoded list.
- An agent in a child worktree cannot reach the control plane in either
  direction. The plan goes in as `.ahoy-plan.md`; the report comes out of
  `.ahoy-report.json`.
- `unverified` is never rounded up to `ready`.
- Derived values are recomputed wherever they are read.
- Ceilings on rework, revision and `in_progress` rounds.
