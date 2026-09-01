# Implementation Plan: R3DA-13673 — Mechanical tree instances order

## Jira source and readiness

- Snapshot: `specs/R3DA-13673/jira-source.md` (retrieved 2026-08-31T10:06:22Z, Snapshot Version 1)
- Summary: "[niooo] Mechanical tree instances order"
- Issue type: Story
- Navigator completeness: `FULL`, no open questions
- `gates/intake.sh` already recorded `pass` in `state.json.gate_results`

### Problem statement (from Jira)

Repeating instances of a mechanical element (e.g. `BG30#2`, `BG30#10`) are
currently ordered alphabetically in the Mechanical Tree Structure, so
`#10`–`#19` display above `#2`. The story asks that numbered repetitions of the
same article be listed in numerical order instead.

### Acceptance criterion (verbatim from Jira)

> When displaying the mechanical structure as a tree, repeating instances of
> elements in the same position are ordered numerically if there name strings
> match up until the "#" character.

### Boundaries (from Jira)

- Frontend only.
- Explicitly scoped to `mechanical-structure.mapper.ts`.
- Backend changes are out of scope.

## Technical context

Single affected repository: `frontend` (plan alias; GitHub slug
`zxc-github.azure.cloud.asd/qwerty/r3da_cdm_frontend`, default branch `main`).
Inspected at commit `da66a91c933242c59fc4641da62c3ca1e8fcc7c7` on `main`
(2026-08-28), via the shared read-only clone at `work/.clones/frontend`
(`bin/repo.sh frontend`).

Live repository context inspected:
- `.github/agents/frontend-implementer.agent.md`, `angular-test-engineer.agent.md`,
  `a11y-reviewer.agent.md` — no `.github/copilot-instructions.md` deviation found
  beyond these agent profiles.
- `.github/instructions/accessability-best-practices.instructions.md`,
  `architecture.instructions.md`, `general.instructions.md` (dev-server-required
  visual verification convention).
- `angular.json` — single workspace `r3da-cdm-frontend`, Angular 21, builder
  `@angular/build:application`, unit-test builder `@angular/build:unit-test`
  (`providersFile: src/test-providers.ts`); `package.json` `"test": "ng test
  --no-watch --no-progress"`.
- Source: `src/app/features/facility/mappers/mechanical-structure/mechanical-structure.mapper.ts`
  and its spec `mechanical-structure.mapper.spec.ts`.
- Call sites: `src/app/features/facility/facades/structures/mechanical-structure/mechanical-structure.facade.ts`
  (`sortItems`, `toTreeItems`) and `abstract-structure.facade.ts` (`sortItems`
  invoked on user-triggered sort-order toggle).

Curated `knowledge/repositories/agent-mappings.md` (v3.3) matched the live
agent set exactly — no drift found.

### Root cause

`MechanicalStructureMapper.compareItems(a, b, order)` first tries
`compareItemPositions` (only applies when a label contains the `%` code
separator — layout-element labels), then falls straight through to
`a.label.localeCompare(b.label)`. `MECHANICAL_INSTANCE` labels produced by
`getInstanceLabel` are `${name}#${instanceNumber}` (e.g. `BG30#2`, `BG30#10`)
and contain no `%`, so they always hit the `localeCompare` fallback, which
compares `#10` and `#2` as strings and puts `#10` before `#2`.

`getBaseNameFromLabel(label)` already exists (used by
`groupMechanicalInstances`) and strips the trailing `#N` via
`INSTANCE_NUMBER_REGEX = /#(\d+)$/`, so it is the same rule the story asks for
("name strings match up until the `#` character").

## Architecture and design decision

Add a new private static comparator, `compareInstanceNumbers`, and call it
inside `compareItems` between the existing position check and the
`localeCompare` fallback:

```
static compareItems(a, b, order) {
  const positionComparison = compareItemPositions(a, b, order);
  if (positionComparison !== null) return positionComparison;

  const instanceNumberComparison = compareInstanceNumbers(a, b, order);
  if (instanceNumberComparison !== null) return instanceNumberComparison;

  return order === 'asc' ? a.label.localeCompare(b.label) : b.label.localeCompare(a.label);
}

private static compareInstanceNumbers(a, b, order): number | null {
  if (getBaseNameFromLabel(a.label) !== getBaseNameFromLabel(b.label)) return null;

  const matchA = a.label.match(INSTANCE_NUMBER_REGEX);
  const matchB = b.label.match(INSTANCE_NUMBER_REGEX);
  if (!matchA || !matchB) return null;

  const numA = Number.parseInt(matchA[1], 10);
  const numB = Number.parseInt(matchB[1], 10);
  return order === 'asc' ? numA - numB : numB - numA;
}
```

Rationale:
- Reuses the existing `getBaseNameFromLabel`/`INSTANCE_NUMBER_REGEX` used by
  grouping, so "match up until the `#` character" is defined identically in
  both places rather than duplicated with a second regex.
- Runs only when both labels reduce to the same base name and both actually
  carry a trailing `#N`; otherwise returns `null` and falls through unchanged,
  so existing layout-element and non-instance ordering (already covered by
  passing specs) is untouched.
- `sortItems` already recurses into `node.children`, so this fixes ordering
  both for ungrouped `MECHANICAL_INSTANCE` siblings and for the children
  inside a `groupMechanicalInstances` virtual group node, without touching
  the grouping logic itself.

### Resolved decision: no `a11y-reviewer` work package

Asked the human (grill-me); no response was available in this run
(non-interactive continuation), so the stated recommendation is adopted and
recorded as the resolved decision: **skip `a11y-reviewer`**. Justification —
the change is confined to a sort comparator in a data mapper. It changes only
the sequence of already-accessible, already-rendered tree nodes; it adds no
markup, no ARIA, no focus-management code, and no new interactive elements.
DOM/tab order already follows the mapper's output order today, so a numeric
instead of alphabetical order is a data-correctness fix, not an accessibility
change. If a later reviewer disagrees, this is a one-line rework, not a
redesign. `angular-test-engineer` is likewise omitted: the comparator's
unit-testable surface is fully covered by `frontend-implementer`'s first-pass
tests, so there is no coverage gap for a hardening pass to close.

## Affected repositories and files

| repo (plan alias) | file | change |
|---|---|---|
| `frontend` | `src/app/features/facility/mappers/mechanical-structure/mechanical-structure.mapper.ts` | Add `compareInstanceNumbers`; wire into `compareItems` |
| `frontend` | `src/app/features/facility/mappers/mechanical-structure/mechanical-structure.mapper.spec.ts` | Add tests under a new `describe('AC1: ...')` block, matching the existing spec's convention |

No other repository is affected; no Figma reference is applicable (no visual/
markup change).

## Work packages and task breakdown

### WP1 — `frontend-implementer` (repo: `frontend`)

- Implement `compareInstanceNumbers` and wire it into `compareItems` as above.
- Add first-pass unit tests in `mechanical-structure.mapper.spec.ts`:
  - `sorts repeating instances with matching base name in ascending numerical order (#2 before #10)`
  - `sorts repeating instances with matching base name in descending numerical order (#10 before #2)`
  - `falls back to alphabetical order when base names do not match up to the # character`
- Verify existing `sortItems`/`compareItems`/`compareItemPositions` specs
  (layout-element position ordering, mixed items) still pass unmodified.
- `depends_on`: none.
- `open_pr`: `true` (only work package for this repository, so it also opens
  the pull request per `agent-mappings.md`'s "last in sequence" rule).

No `angular-test-engineer` or `a11y-reviewer` packages — see resolved decision
above.

## Acceptance-criterion mapping

| AC | text | source | repo | test_ids |
|---|---|---|---|---|
| AC1 | Repeating instances of elements in the same position are ordered numerically when their name strings match up to the `#` character (both ascending and descending). | See verbatim quote above | `frontend` | `sorts repeating instances with matching base name in ascending numerical order (#2 before #10)`; `sorts repeating instances with matching base name in descending numerical order (#10 before #2)`; `falls back to alphabetical order when base names do not match up to the # character` |

## Dependencies and sequence

Single work package, single repository. No cross-repo or cross-package
dependency. WP1 → PR.

## Validation and evidence

- `frontend-implementer` runs the project's unit test command (`ng test
  --no-watch --no-progress`, scoped to `mechanical-structure.mapper.spec.ts`
  if the Angular 21 unit-test builder supports path filtering, else the full
  suite) and reports pass/fail plus command text in `validation_commands`.
- No dev-server/browser verification is required (`general.instructions.md`'s
  visual-comparison rule applies to UI/markup changes; this change has none).
  If a reviewer nonetheless wants visual confirmation, that is a PR-review
  follow-up, not a blocker for this plan.
- `gates/child_ready.sh` will grep the PR diff for the three `test_ids` above.

## Risks and rollback

- **Risk:** a label whose base name coincidentally matches another label's
  base name but is not actually a repeating instance (e.g. two unrelated,
  non-instance labels that happen to reduce to the same string) — mitigated
  because `compareInstanceNumbers` requires both labels to also match
  `INSTANCE_NUMBER_REGEX` (`/#(\d+)$/`), which only real instance labels do.
- **Risk:** regression to existing layout-element ordering (`%`-separated
  labels) — mitigated because the new comparator returns `null` immediately
  when base names differ, and layout-element labels aren't stripped by
  `getBaseNameFromLabel` in a way that would make two different elements
  collide (it only strips a trailing `#N`).
- **Rollback:** single-file, single-method change; revert the PR commit.

## Post-approval Jira and implementation actions

- No Jira updates are needed before implementation; the ticket already states
  the AC as adopted here.
- After `human_gates.plan_accepted.status` is `approved`, `bin/dispatch.sh`
  creates a `frontend` worktree on branch `feature/R3DA-13673-numeric-instance-order`
  and dispatches WP1.
