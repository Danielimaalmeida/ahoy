# Delivery phase table

This is the fixed lookup `bin/tick.sh` uses on every tick. Nothing infers the
next action from conversation history: the router reads `phase` from
`specs/<STORY-ID>/state.json`, finds the matching row below, runs that row's
actor, runs that row's gate, and writes the next phase **from the gate's exit
code**. It loops until a human gate or a terminal phase.

The machine-readable projection of this table is
[phases.tsv](/knowledge/process/phases.tsv), which is what the router actually
reads. This document stays authoritative for humans and for what each actor
does. [tests/check-phase-table.sh](/tests/check-phase-table.sh) fails if the two
disagree on phase names or on-pass targets.

**Gates are run by the shell, not by an agent.** An agent does a phase's work;
it never decides whether the gate passed and never writes `phase`. That is the
whole design. An agent reporting on its own gate is grading its own homework, and
the report is indistinguishable from the truth until something independent
checks — which is how three gate scripts stayed broken for weeks without anyone
noticing (see [tests/run.sh](/tests/run.sh)).

The only other way a phase advances is an explicit human decision recorded in
`human_gates`, written **only** by [bin/approve.sh](/bin/approve.sh).

Gate scripts live in [gates/](/gates); see [gates/README.md](/gates/README.md)
for invocation and exit-code conventions. Child-repository agents are dispatched
per the [child dispatch contract](/knowledge/process/child-dispatch-contract.md).

| phase | actor this step | action | gate | on pass → | on fail/blocked → |
|---|---|---|---|---|---|
| *(no state file yet)* | `bin/start.sh` | Run `gates/preflight.sh`; validate the Jira key's shape; copy [state.template.json](/knowledge/process/state.template.json) to `specs/<STORY-ID>/state.json` with `story_id` set | `gates/preflight.sh` | `intake` | Exit 2; no state file is created without a well-formed key or a working harness |
| `intake` | Navigator | Fetch Jira/Confluence facts and linked URLs. Navigator writes `specs/<STORY-ID>/jira-source.md` and `navigator.completeness` itself | `gates/intake.sh` — it inspects the persisted snapshot; Navigator's own `completeness` is an input, not the check | `planning` | `blocked`; append `decision_log` entry `type: blocked` |
| `planning` | Cartographer **(interactive)** | Produce `specs/<STORY-ID>/implementation-plan.md` with work packages, their assigned specialists from `knowledge/repositories/`, and their dependency order. Populate `acceptance_criteria[]` (id, text, source_quote, repo, test_ids), `work_packages[]` and `branch_prefix`. Use grill-me for ambiguity | `gates/plan.sh` | `plan_review` | `stay` — an interactive session that ends without a plan is unfinished, not failed. Re-run to resume |
| `plan_review` | Human | Approve, revise, or reject the plan | *(human decision only)* | `implementation`, once `human_gates.plan_accepted.status` is `approved` | Stays here until a human responds. `bin/revise.sh` sends it back to `planning`; `--reject` sends it to `blocked` |
| `implementation` | `bin/dispatch.sh` → child-repo specialists, one worktree per repository | Dispatch work packages one at a time, in the plan's order, to the specialist the plan assigned. `open_pr: true` goes to the last work package of each repository. Each child writes a handoff report; dispatch routes on its `status` | `gates/child_ready.sh` per repo; once **all** repos pass, `gates/pr.sh` | `pr_review` | `stay`. `in_progress`, `blocked` and `unverified` are polled again, not treated as failures. `unverified` is never recorded as `ready` |
| `pr_review` | `bin/review.sh` → `lookout-design` and `lookout-defect`, one process each | Fetch existing Copilot review comments into `open_findings`, then review the pull request under two lenses on two models, plus a verdict per acceptance criterion. `review.sh` **replaces** `lookout_reviews[]` and records the model it assigned | `gates/consensus.sh` — a self-declared `CONSENSUS_READY` is never trusted | `delivery_gate` | `rework` on exit 3, after `gates/rework_ceiling.sh` runs per repo. Exit 4 halts for a human |
| `rework` | — | Pure routing row. The ceiling was already checked and incremented on entry from `pr_review` | *(none)* | `implementation` | — |
| `delivery_gate` | Human | Final acceptance and merge decision | *(human decision only)* | `done`, once `human_gates.delivery_accepted.status` is `approved` | Stays here until a human responds |
| `done` | — | Terminal. No further action. | — | — | — |
| `blocked` | Human | Resolve the blocker (update Jira, answer an open question, accept an escalation) | — | A human sets `phase` back to the appropriate earlier value to resume | Stays `blocked` |

## Exit-code contract

The router switches on this and nothing else.

| code | meaning | router does |
|---|---|---|
| 0 | pass | advance to `on pass` |
| 1 | not yet | stay, or route to `on fail`. With `--wait`, sleep and poll |
| 2 | environment broken | stop; the story is untouched |
| 3 | branch | route to `on branch` (rework), via the ceiling |
| 4 | halt | stop without changing phase; a human decides |

Exit 2 is never a delivery condition and never a pass. It means the gate could
not run — missing `jq`, missing `gh`, unreachable state file. Fix the
environment.

## Notes

- **Human gates are written only by `bin/approve.sh`**, as
  `{status, timestamp}`. The router accepts that shape and rejects every other
  one loudly, including a bare boolean. The timestamp is the half a boolean
  cannot carry: a plan approved three rounds of change ago is not
  self-evidently still approved. Hand-editing this field is how a story once
  reached `done` with its delivery gate never opening.
- **`planning` is the only interactive phase.** The router hands Cartographer
  the terminal, without `--no-ask-user`, so it can ask questions and a human can
  answer. Everywhere else that flag is set, and under it a question becomes a
  silent denial rather than a prompt.
- **`bin/revise.sh` sends a story back from a human gate** to the phase that
  produced the artifact, carrying a reason into the agent's prompt and resuming
  the same agent session. It clears the recorded decision first: an approval is
  a judgement about a specific artifact, and revising changes the artifact.
  There is a ceiling, default 4.
- **`gates/rework_ceiling.sh` writes state.** It increments
  `child_repos[].retry_count` itself, because the participant guaranteed to run
  is the gate, not the caller. `bin/tick.sh` is the only thing that calls it,
  from the `pr_review` branch path only, so it cannot be called twice or from
  the wrong row.
- **`lookout_reviews[]` is replaced on every round, never appended.**
  `gates/consensus.sh` requires exactly two entries, so appending wedges the
  story permanently on the second round.
- **The two Lookouts are separate profiles** (`lookout-design` on
  `gpt-5.6-terra`, `lookout-defect` on `claude-sonnet-5`) rather than two
  sessions of one profile, because a profile pins a single model and
  `gates/consensus.sh` rejects two reviews reporting the same `model` or the
  same `lens`. `bin/review.sh` records the model it assigned, not one the
  reviewer reported about itself.
- **Reviewer disagreement goes to a human, not to rework.** Where both
  reviewers agree a criterion is unmet, that is work and routes to rework.
  Where they *disagree*, or either reports `BLOCKED`, the gate halts: sending
  that to rework would tell a fixer to fix something a competent reviewer says
  is already correct, and that loop has no exit condition. There is no
  reconciliation round.
- **Tool grants come from each agent's own profile.** `bin/dispatch.sh` reads
  `tools:` from `.github/agents/<agent>.agent.md` in the child repository;
  `bin/tick.sh` and `bin/review.sh` read it from `agents/` here. A fixed grant
  in the harness silently overrules every profile — which is how an implementer
  built a component without the design-system check its own profile required.
- **Nothing decides which specialist implements a work package**, nor the
  internal order of a repository's phases. The plan assigns both, from the
  mappings under `knowledge/repositories/`. Keeping that out of the control
  plane is what stops repository-specific sequencing leaking into it.
- **Routine passing transitions are not logged** to `decision_log`; the `phase`
  history plus `gate_results` already reconstructs them. Only judgment calls,
  human decisions and revisions go in `decision_log`.