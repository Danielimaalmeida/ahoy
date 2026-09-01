# Delivery state schema

Every story or bugfix delivery has exactly one durable state file:
`specs/<STORY-ID>/state.json`. It is the authoritative record of where a
delivery is in its lifecycle. Captain reads this file at the start of every
invocation and writes it back at the end of every step; no phase, decision,
or gate result should exist only in conversation history.

This file is the **parent** state for the story. It tracks story-level phase,
acceptance-criterion-to-test mapping, and a rolled-up status per affected
child repository. It does not track the fine-grained implement/rework
mechanics inside a child repository (open review comments, local retry
bookkeeping) — that detail belongs to the child repository's own session,
per the rule that repository-specific implementation detail stays in the
owning repository.

What it does carry per child repository is the minimum the gates need to
**verify** a claim rather than record it: the slug, branch and head commit,
plus whatever evidence the child returned, stored verbatim and uninterpreted.
See [child-dispatch-contract.md](/knowledge/process/child-dispatch-contract.md)
for where those field names come from.

## Template

See [state.template.json](/knowledge/process/state.template.json)
for a copyable seed. Captain copies this template to
`specs/<STORY-ID>/state.json` at intake, once a valid existing Jira issue key
is confirmed.

## Fields

- `story_id` (string): the Jira issue key, e.g. `PROJ-1234`.
- `jira_url` (string|null): link to the Jira issue, set once Navigator
  returns a `FULL` snapshot.
- `phase` (string): one of `intake`, `planning`, `plan_review`,
  `implementation`, `pr_review`, `rework`, `delivery_gate`, `done`,
  `blocked`. See [delivery-phases.md](/knowledge/process/delivery-phases.md)
  for the fixed transition table. This is the single field Captain reads
  first on every invocation.
- `plan_path` (string|null): path to `specs/<STORY-ID>/implementation-plan.md`,
  set by Cartographer.
- `rework_ceiling` (integer, default `3`): story-level maximum rework cycles
  per child repository before Captain must stop and escalate. A repository may
  override it with its own `child_repos[].rework_ceiling`; the story-level value
  stays at the default in that case, and `gates/rework_ceiling.sh` prefers the
  per-repo value when present.

- `navigator` (object|null): Navigator's intake report, persisted by Captain.
  Read by `gates/intake.sh`.
    - `completeness` (string): `FULL`, `PARTIAL`, or `NOT_FOUND`.
    - `sources` (array of strings): what Navigator actually read.
    - `open_questions` (array): each `{question, blocking}`. A blocking question
    fails the intake gate.

- `acceptance_criteria` (array): one entry per acceptance criterion from the
  Jira issue, populated by Cartographer during `planning` and updated by
  later phases. Each entry:
    - `id` (string): a stable short id, `AC1`, `AC2`, … No hyphen. These are the
    join key used by the plan, the tests, the PR body, and both Lookout
    reviews, so they are permanent — never renumbered, never reused.
    - `text` (string): the criterion as it will be implemented and tested.
    Cartographer may split a compound Jira criterion into several entries.
    - `source_quote` (string): the sentence from `jira-source.md` this criterion
    derives from, **verbatim**. `gates/plan.sh` checks it appears there. This is
    what permits splitting and clarifying while still proving every criterion
    traces to the ticket rather than to a plausible-sounding invention.
    - `status` (string): `planned`, `implemented`, or `verified`.
    - `repo` (string): the plan alias of the repository that owns satisfying
    this criterion. Must match a `child_repos[].repo`; `gates/pr.sh` rejects a
    criterion assigned to a repository nobody is implementing.
    - `test_ids` (array of strings): the concrete test name(s) that verify this
    criterion. Must be non-empty before the plan gate passes, and must be real
    names rather than prose — `gates/child_ready.sh` greps the pull request
    diff for these literal strings.

- `child_repos` (array): one entry per affected repository, created by
  Captain when it opens the child session. Each entry:
    - `repo` (string): the plan alias, as used in `acceptance_criteria[].repo`.
    - `slug` (string|null): the fully qualified `host/owner/name` from
    `knowledge/repositories/`. Never shortened to `owner/name` — we have two
    GitHub Enterprise hosts, so a bare `owner/name` resolves to github.com and
    every `gh` call fails with "Could not resolve to a Repository". Required
    before `gates/child_ready.sh` can verify anything — it cannot address a
    repository it cannot name.
    - `session_ref` (string|null): reference to the isolated child session.
    - `branch` (string|null): the working branch, per the branch naming
    convention.
    - `head_sha` (string|null): the commit the child claimed readiness for.
    Compared against the live PR head.
    - `pr_url` (string|null), `pr_number` (integer|null): set once the pull
    request is open.
    - `status` (string): `not_started`, `in_progress`, `ready`, `blocked`, or
    `unverified`. Reported by the child in Ahoy's own vocabulary and recorded
    verbatim — there is no translation step.
        - `ready` means the child claims the work package is complete and
      evidenced. `gates/child_ready.sh` then verifies that claim against
      GitHub before it counts.
        - `unverified` means the work is done but a required check could not run,
      so nobody has evidence. **It is never recorded as `ready`.** It keeps the
      repository in `implementation`, polled again, exactly like `in_progress`.
    - `evidence` (object|null): repository-specific evidence returned by the
    child (`density_evidence`, `figma_evidence`, `e2e_evidence`, and so on).
    Recorded verbatim; Captain does not interpret it.
    - `rework_ceiling` (integer|null): per-repo override of the story-level value.
    - `retry_count` (integer): rework cycles this repo has been sent back for.
    **Written by `gates/rework_ceiling.sh`, not by Captain** — see Ownership.

- `lookout_reviews` (array): exactly two entries, populated by Captain from
  each independent Lookout session once the pull request is open.
  **Replaced on every review round, never appended** — `gates/consensus.sh`
  requires exactly two entries, so appending wedges the story on round two.
  Each entry:
    - `model` (string): the model that produced this review. The two entries must
    differ; the gate rejects a match.
    - `lens` (string): `design-fit` or `defect-failure`. The two
    entries must differ.
    - `reviewed_shas` (object): repo alias → the commit sha actually read. Each
    must still match the live PR head at gate time, or the review describes
    superseded code.
    - `criteria_verdicts` (object): acceptance criterion id → `met`, `not_met`,
    `partially_met`, or `untestable`. Every criterion needs a verdict from
    both reviewers.
    - `consensus_status` (string|null): `CONSENSUS_READY` or `BLOCKED`, taken
    verbatim from the Lookout report — and never trusted on its own.
    - `unresolved_high_or_blocking_count` (integer): count of findings at
    blocking or high severity without a resolved disposition.
    - `diminishing_returns_agreed` (boolean): whether this reviewer explicitly
    agreed that remaining items have diminishing returns.

- `gate_results` (array): appended every time a gate script runs. Each
  entry: `gate` (script name), `subject` (story id or `repo` name the gate
  ran against), `result` (`pass`|`fail`|`error`), `timestamp` (ISO-8601),
  `detail` (stderr summary on failure). `error` records exit code `2` — the
  gate could not run. Recording an `error` as a `fail` would misreport a broken
  environment as a failed delivery condition.
- `decision_log` (array): judgment calls and human decisions only — not
  routine phase transitions. Append an entry for: a `BLOCKED` reason, a
  grill-me resolution, a reviewer disagreement, or a human gate decision.
  Each entry: `timestamp`, `actor` (`captain`|`navigator`|`cartographer`|
  `lookout-design`|`lookout-defect`|`human`), `type` (`blocked`|
  `grill_me_resolution`|`disagreement`|`human_gate`|`rework_escalation`),
  `summary`.
- `human_gates` (object): `plan_accepted` and `delivery_accepted`, each
  `{status: "pending"|"approved", timestamp}`. These are the only two points
  a human must explicitly act; Captain must never set either to `approved`
  itself.

## Ownership rules

- Captain is the primary writer of `specs/<STORY-ID>/state.json`. Navigator,
  Cartographer, and Lookout are read-only against this file; they return
  structured payloads to Captain, which Captain persists.
- **Two exceptions**, both deliberate:
    - Cartographer may append to `acceptance_criteria` directly, since it is the
    only agent that produces that mapping. It must not modify `phase`,
    `human_gates`, or any other story-level field.
    - `gates/rework_ceiling.sh` writes `child_repos[].retry_count` itself,
    atomically. A counter that guards a loop must be incremented by the thing
    that checks it — if the gate checks and the caller increments, a caller
    that forgets loops forever, and the participant guaranteed to run is the
    gate. Captain must therefore never increment `retry_count`, and the gate
    must be called exactly once per rework decision.
- No agent may set its own `phase` transition without the corresponding gate
  in [delivery-phases.md](/knowledge/process/delivery-phases.md)
  passing. A gate failure keeps the phase unchanged and appends a `fail`
  entry to `gate_results`.
