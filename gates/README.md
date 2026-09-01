# Gates

Small process-automation scripts that turn phase-completion criteria from
this workspace's [knowledge/process/delivery-phases.md](/knowledge/process/delivery-phases.md)
into an exit code, instead of leaving them as a sentence an agent could talk
itself past. These are control-plane tooling for the delivery process
itself, not application code — the rule against application code in this
repository refers to the product being delivered, which stays in the owning
child repository.

No agent may advance a story's `phase` in `specs/<STORY-ID>/state.json`
without the relevant gate below passing. The agent about to declare a step
complete is the one that must run the gate on itself — see
`delivery-phases.md` for which agent owns which gate.

Child work is verified against
[knowledge/process/child-dispatch-contract.md](/knowledge/process/child-dispatch-contract.md);
the field names these scripts read are defined there.

## The rule these scripts exist to enforce

**A gate is only a gate if at least one of its inputs comes from somewhere the
agent does not control.** A script that reads a field an agent wrote and
confirms the field says what the agent said is a schema validator wearing a
gate's name, and it is worse than no gate at all because it produces evidence
in `gate_results` that nothing was actually checked.

Concretely: `plan.sh` requires a file on disk and quotes traceable to the Jira
snapshot. `child_ready.sh`, `pr.sh` and `consensus.sh` ask GitHub. Keep that
property when adding gates.

## Scripts

| script | run by | checks |
|---|---|---|
| `preflight.sh` | Captain, first action of its first invocation | shell is reachable at all; `jq`, `git`, `gh` present and `gh` authenticated; repo root found; `specs/` writable; every gate script present and syntactically valid. Prints a one-time token Captain must quote back, so a Captain that never ran it cannot claim it passed |
| `intake.sh <STORY-ID>` | Captain, before advancing `intake` → `planning` | Navigator's `completeness` is `FULL`, **and** `jira-source.md` independently contains the story key, ≥200 characters of content, a Description section, an Acceptance criteria section with at least one discrete criterion, and a stated boundaries section |
| `plan.sh <STORY-ID>` | Cartographer before emitting `HUMAN_GATE: PLAN_ACCEPTED`, **and Captain again** before writing the phase | `plan_path` exists on disk; every `acceptance_criteria[]` entry has `id`, `text`, `repo`, `source_quote` and at least one `test_ids` entry; ids are unique; each `source_quote` appears verbatim in `jira-source.md`; `test_ids` are concrete names rather than prose like "unit tests" |
| `child_ready.sh <STORY-ID> <REPO>` | Captain, before recording a child repository as `ready` | the agent's `ready` claim is verified against GitHub: an open non-draft PR exists on the recorded branch, its head matches the claimed `head_sha`, CI checks exist and are green (an empty check rollup fails), every planned `test_ids` string for that repo appears in the PR diff, and the diff adds no skipped or disabled tests |
| `pr.sh <STORY-ID>` | Captain, before moving to `pr_review` | every repo named by an acceptance criterion has a `child_repos[]` entry; every entry is `ready` with a `pr_url`; each PR is `OPEN`, not a draft, with the story id in its body |
| `consensus.sh <STORY-ID>` | Captain, before trusting a self-declared `CONSENSUS_READY` | exactly two `lookout_reviews[]` entries; both `CONSENSUS_READY` with zero unresolved high/blocking findings and explicit diminishing-returns agreement; the two entries report **different** `model` and **different** `lens`; each `reviewed_shas` entry still matches the live PR head; every acceptance criterion has a verdict of `met` from both reviewers |
| `rework_ceiling.sh <STORY-ID> <REPO>` | Captain, on the `pr_review` fail path **only** | the repo's `retry_count` is below its ceiling (per-repo `rework_ceiling`, else story-level, else 3) |

`lib.sh` is a shared helper, not a gate — it is sourced by the scripts
above, not invoked directly.

### One gate writes state

`rework_ceiling.sh` increments `child_repos[].retry_count` itself, atomically,
and verifies the write persisted. Every other gate is read-only.

This is deliberate. If the gate checks the counter and the caller increments it,
a caller that forgets loops forever — and the participant guaranteed to run is
the gate. It therefore must be called **exactly once per rework decision**, from
the `pr_review` fail path. Do not call it again from the `rework` row and do not
increment `retry_count` anywhere else.

## Exit codes

- `0` — pass.
- `1` — validation failure. The condition being checked is not met yet;
  message printed to stderr. This is an expected, non-exceptional outcome
  (e.g. "not all repos are ready yet") — the calling agent should not
  advance the phase and should report the reason.
- `2` — usage or environment error (missing argument, missing `jq` or `gh`,
  missing or malformed state file, unreachable GitHub). The gate could not run
  at all, which is different from the condition failing. Never treat it as a
  pass, and never record it as `blocked` phase.

`lib.sh` installs an `ERR` trap so that an unexpected non-zero command converts
to `2` rather than `1`. Without it, `set -e` turns any incidental failure — a
bare `grep` miss, `jq` choking on unexpected input — into exit 1, which Captain
would read as "the delivery is not in the required state" when the truth is "the
tooling broke". Exit `1` therefore only ever comes from an explicit `gate_fail`.

One consequence worth knowing: `gate_fail` called inside a command substitution
or subshell converts to `2`. No current gate does that, and a validation check
buried in a subshell would be a bug anyway.

## Requirements

- `bash`. The scripts avoid bash 4+ constructs (`mapfile`, associative arrays)
  so they run on the bash 3.2 that ships with macOS. Keep it that way — a gate
  that only runs on Linux silently stops being enforced on half the team's
  laptops.
- `jq` — required by every script.
- `gh`, authenticated — required by `child_ready.sh`, `pr.sh` and
  `consensus.sh`. **Its absence is exit `2`, not a warning.** An earlier version
  of `pr.sh` skipped the pull-request verification when `gh` was missing and
  passed on the strength of `pr_url` being a non-empty string, which meant any
  string an agent wrote would ship. A gate that degrades to "could not verify,
  therefore fine" is worse than no gate, because it logs a pass.
- `git` — scripts locate the repository root via `git rev-parse --show-toplevel`,
  so they can be run from any working directory inside the repository.

## Example

```sh
gates/preflight.sh
gates/intake.sh PROJ-1234
gates/plan.sh PROJ-1234
gates/child_ready.sh PROJ-1234 poi-manager-job
gates/pr.sh PROJ-1234
gates/consensus.sh PROJ-1234
gates/rework_ceiling.sh PROJ-1234 poi-manager-job
```

## Adding a gate

1. Source `lib.sh` and call `gate_strict` immediately after.
2. Validate arguments; `exit 2` on usage errors.
3. Declare dependencies with `gate_require_jq` / `gate_require_gh` — never skip
   a check because a tool is missing.
4. Use `gate_fail` for every validation failure and `gate_pass` once at the end.
5. Ask yourself which input the agent does not control. If the answer is none,
   you have written a schema validator; find an external source of truth or do
   not add the gate.
6. Register it in the table above and in `delivery-phases.md`, naming which
   agent runs it.