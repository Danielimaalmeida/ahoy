# Child dispatch contract

Authoritative. Every child-repository agent conforms to this; Ahoy does not
adapt to any child repository's shape. A child repo may organise its work
however it likes internally, but what crosses the boundary is defined here.

This exists because the gates under `gates/` verify child work against this
contract. A child that returns a different shape does not fail politely — it
fails a gate that was written to read these exact fields.

Dispatching is done by [`bin/dispatch.sh`](/bin/dispatch.sh), which the router
runs for the `implementation` phase. It replaces the desktop app's
`create_session` with a git worktree per story and repository.

## What dispatch sends

**One work package at a time**, in the order and dependency sequence given by
the approved implementation plan. The dispatcher does not decide which
specialist agent handles a work package: the plan assigns that from the mappings
under `knowledge/repositories/`. It does not decide the order of a repository's
internal phases either — the plan does.

Every dispatch carries:

| field | meaning |
|---|---|
| `ticket_id` | the existing Jira issue key |
| `plan_ref` | the approved plan, **staged into the worktree** as `.ahoy-plan.md` |
| `work_package_id` | the work package being dispatched |
| `acceptance_criteria` | the criteria assigned to this work package, each with `id`, `text`, and `test_ids`, copied from `state.json` |
| `repo` | the repository alias used throughout the plan |
| `branch` | the branch this repository's work belongs on — see below |
| `open_pr` | boolean; see below |
| `rework_note` | present only when the package was reopened by a handback: what a previous package asked this one to fix |
| `gate` | the exact marker `HUMAN_GATE: PLAN_ACCEPTED` |

Dispatch never runs without `human_gates.plan_accepted.status == "approved"`.

### The control plane is not reachable from a child worktree

The agent runs with its working directory set to a checkout of **one** child
repository. Copilot will not read or write outside that directory, in either
direction, and under `--no-ask-user` the refusal is silent.

So the harness ferries, and every path in a dispatch prompt stays inside the
worktree:

- the plan is copied **in** as `.ahoy-plan.md` before the agent starts
- the handoff report is written to `.ahoy-report.json` in the worktree root and
  moved **out** afterwards
- both are removed from the checkout; neither belongs in the delivered diff

A prompt that references `knowledge/`, `specs/` or `gates/` will fail. This is
not a style rule — it cost two complete runs, one of them ten minutes of real
implementation whose report could not be filed.

### Tool grants come from the agent's own profile

`bin/dispatch.sh` reads the `tools:` list from
`.github/agents/<agent>.agent.md` in the child repository and grants exactly
that, adding `shell` if absent because without it the agent cannot commit.

The profile is the single source of truth. A repository that adds an MCP server
to one of its agents needs no change in Ahoy.

A tool a profile declares but the harness does not grant is available in
principle and refused in practice, silently. That is how one implementer built a
component without the design-system validation its own profile required.

### Branch naming convention

Every repository's work for a story lands on one branch, named
`<prefix>/<TICKET-ID>-<slug>`, where `<TICKET-ID>` is the exact Jira issue key
(e.g. `R3DA-13330`) and `<slug>` is a short kebab-case summary of the story
(e.g. `configurable-columns`). `<prefix>` comes from the story's Jira issue
type, not fixed to `feature`:

| Jira issue type | prefix |
|---|---|
| Bug | `hotfix` |
| Chore, Technical task | `chore` |
| Documentation-only change | `docs` |
| Release | `release` |
| Story, Spike, everything else | `feature` |

Cartographer proposes the full branch name once per story in the implementation
plan; the dispatcher copies it verbatim into `child_repos[].branch` and the
`branch` dispatch field for every work package against that repository. It does
not invent a different name per work package, does not substitute a different
prefix, and does not let a repository's own worktree-naming defaults override it.

`gates/child_ready.sh` rejects a branch whose prefix is not in the table above.
A repository whose convention differs changes its mapping, not the gate.

The child names its working branch to match, and echoes that value back in its
report. A `branch` that does not match the dispatched value is a contract
violation, not a detail to reconcile silently — record it as a gap and require
the child to fix it before the repository is marked `ready`.

### `test_ids` are assigned, not chosen

The names in `test_ids` come from the approved plan and are binding.
`gates/child_ready.sh` greps the pull request diff for those literal strings, so
a test that does the right thing under a different name fails the gate and the
repository stays in `implementation`.

A child that believes an assigned name violates its own conventions reports that
in `remaining_gaps` and uses the assigned name regardless. Changing a planned
test name is a plan change, and plan changes go back through `plan_review`.

### `open_pr`

`open_pr: true` goes to exactly one dispatch per repository — the last work
package for that repo. That agent commits, pushes, and opens the pull request.
Every other dispatch gets `open_pr: false`.

`gates/plan.sh` rejects a plan with two `open_pr: true` in one repository, or
with none. Known gap: the flag is not enforced at dispatch time, and an agent has
opened a pull request against it.

## What a child returns

Written to `.ahoy-report.json` in the worktree root, as a single JSON object.

| field | required | notes |
|---|---|---|
| `ticket_id`, `plan_ref`, `work_package_id` | always | echoed back |
| `repo`, `repo_slug`, `branch`, `head_sha` | always | `repo_slug` is `owner/name`. `gates/child_ready.sh` cannot address a repository it has no slug for |
| `status` | always | from the vocabulary below |
| `acceptance_criteria_mapping` | always | each assigned criterion id mapped to the files, observable behaviour, and the test proving it |
| `test_ids_delivered` | always | each assigned test name and where it lives, or `not-applicable` for review-only passes |
| `changed_files` | always | a list, or the exact string `none (review-only)` |
| `validation_commands` | always | exact commands run and concise results |
| `remaining_gaps` | always | unresolved gaps with severity |
| `pr_url`, `pr_number` | when `open_pr: true` | |
| `blocker_question` | when `blocked` | exactly one focused question |
| `handback_to` | when handing back | the work package id that must fix what this one found |
| `assumption_check` | always | for `ready` it must read `No unresolved assumptions remain.` |
| `phase` | always | the child's own phase name, for the log |

Repository-specific evidence fields — `density_evidence`, `figma_evidence`,
`e2e_evidence` and the like — are defined by the owning repository, not here.
They are recorded verbatim into `child_repos[].evidence` without interpretation.

### Reports are archived, not overwritten

The current report is `specs/<STORY-ID>/reports/<WP>.json`. Earlier attempts
become `<WP>.round1.json`, `<WP>.round2.json` and so on.

They used to be deleted before each re-dispatch, which destroyed the evidence of
what earlier attempts found. The reason to ask for a report is to have it
afterwards.

## Status vocabulary

Ahoy's values, written directly into `child_repos[].status`. Children report
them as-is; there is no translation layer, because a translation layer is
somewhere for meaning to quietly change.

| status | meaning | effect |
|---|---|---|
| `ready` | work package complete and evidenced | eligible for `gates/child_ready.sh` |
| `in_progress` | more work remains **that this agent can do** | dispatched again, up to a ceiling — not an error |
| `blocked` | the child needs an answer to proceed | repo stays in `implementation`; `blocker_question` is surfaced |
| `unverified` | work is done but a required check could not run | **never treated as `ready`** |

`unverified` carries weight. It means the change may well be correct, but a
needed check — a running app, a browser, an MCP integration — was unavailable,
so nobody has evidence. It must not be rounded up because it looks close to
done. It is the one status a child can only reach by being honest, and rounding
it up removes any reason to be.

A repository reaches `ready` only when its last work package returns `ready`.
`gates/child_ready.sh` then verifies that claim against GitHub, so a `ready` that
is not true fails there rather than travelling further.

### `in_progress` has a ceiling

Two consecutive rounds, then the package is marked `stalled` and the harness
stops with the agent's last `remaining_gaps` printed. Override with
`.in_progress_ceiling` in `state.json`.

Same reasoning as `gates/rework_ceiling.sh`: an agent that has reported the same
thing twice is not about to report something different on the third. The counter
resets when the package reaches `ready`.

**Only report `in_progress` when running you again could finish the job.** If
the remaining work needs a tool you do not have, running you again changes
nothing.

### `handback_to` — work this package found for someone else

A reviewer finds a defect it has no tool to fix. It cannot report `ready`, and
`in_progress` means "dispatch me again", which cannot help — the same agent with
the same tools reaches the same conclusion.

There was no word for it, so agents reached for `in_progress` anyway. One
review-only package looped indefinitely at roughly ten minutes and 3M tokens a
round, correctly reporting a real accessibility defect each time and having
nowhere to put it.

```jsonc
{
  "status": "in_progress",
  "handback_to": "WP1",
  "changed_files": "none (review-only)",
  "remaining_gaps": [
    { "severity": "high",
      "detail": "The separator sets aria-valuemin but never aria-valuenow or aria-valuemax, so a screen-reader user gets no feedback that the split changed (WCAG 4.1.2)." }
  ]
}
```

The dispatcher then sets the named package back to `pending`, writes
`remaining_gaps` into its `rework_note` — which appears at the top of that
agent's next prompt — and marks the handing-back package `waiting_on_handback`.

**A reviewer that finds a defect it cannot fix should hand back. That is the
normal outcome of review, not a failure.**

### Work package statuses

Written by the dispatcher into `work_packages[].status`, distinct from the
repository statuses above.

| status | meaning |
|---|---|
| `pending` | not yet dispatched, or reopened by a handback |
| `done` | reported `ready` and the claim survived what could be checked |
| `blocked` | the child asked a question it needs answered |
| `unverified` | done but unevidenced; never rounded up |
| `waiting_on_handback` | complete except for something another package must fix first |
| `stalled` | reported `in_progress` up to the ceiling without finishing; a human decides |
| `failed` | no report, invalid report, or a `ready` the repository contradicts |

### `ready` is checked where it can be

Self-reported status is trusted only where nothing can check it. A `ready`
claiming changed files while the branch never diverged from its base is rejected
as the contradiction it is.

The comparison is against the **base branch**, not the worktree HEAD at dispatch
time. A package that committed its work and then failed for an unrelated reason
already has its commits; re-running it correctly makes no new commit, and a
HEAD-at-start comparison would fail it a second time for succeeding.

A package with legitimately nothing to add is a real outcome. Say so with
`changed_files: "none (review-only)"` rather than inventing a change to prove
you ran.

## A note for planning

**Do not give a review-only agent a work package unless it can act on what it
finds.** Work packages are for agents that change things. Check the agent's
`tools:` in the child repository: no `write` and no `edit` means it cannot
finish a package it finds a problem in.

Two ways to place a reviewer properly:

- **Pair it.** Its package hands back to the implementer's via `handback_to`,
  and that agent fixes what it found.
- **Leave it out.** Review belongs in `pr_review`, where the two Lookouts
  already run against the opened pull request.

The general rule: a work package must name an agent that can produce the change
the package describes. Assigning work to an agent that cannot do it produces a
loop rather than an error.

## Schema additions

Add to `knowledge/process/state-schema.md`:

```
acceptance_criteria[]
  source_quote   string   verbatim from jira-source.md; gates/plan.sh checks it
                          appears there. Lets Cartographer split or clarify a
                          criterion while still proving it traces to the ticket.

work_packages[]
  status              string   see the work package status table above
  in_progress_rounds  integer  consecutive in_progress reports; reset on ready
  rework_note         string   what a handback asked this package to fix

child_repos[]
  slug           string   owner/name, for gh
  branch         string   head branch of this repo's pull request
  head_sha       string   commit the child claimed readiness for
  pr_number      integer  set by gates/pr.sh
  evidence       object   repository-specific evidence, recorded verbatim
  retry_count    integer  written by gates/rework_ceiling.sh

lookout_reviews[]
  model              string  must differ between the two entries; assigned and
                             recorded by bin/review.sh, not self-reported
  lens               string  must differ between the two entries
  reviewed_shas      object  repo alias -> sha actually read
  criteria_verdicts  object  AC id -> met|not_met|partially_met|untestable

human_gates
  <key>          object   {status, timestamp}; written ONLY by bin/approve.sh

revisions        object   gate key -> rounds used; ceiling defaults to 4
in_progress_ceiling integer  defaults to 2
session_ids      object   phase -> copilot session id, for resuming a revision
```

## Compatibility with other orchestrators

Child agents in repositories shared with another orchestrator still return this
shape. If that orchestrator expects different status values, it maps them on its
side. Ahoy's gates are written against the vocabulary above, and a child that
hedges between two vocabularies satisfies neither.