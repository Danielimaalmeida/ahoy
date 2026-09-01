# Implementation Plan: R3DA-13330

## Jira Source and Readiness

| Field | Value |
|---|---|
| Issue key | R3DA-13330 |
| Summary | [niooo] All Facilities list view has configurable columns |
| Status | In Progress |
| Sprint | niooo 2026/11 (ends 2026-08-25) |
| Snapshot | `specs/R3DA-13330/jira-source.md` (retrieved 2026-08-20T14:16:50) |
| Navigator completeness | FULL |
| Open questions | None |

All five acceptance criteria are clearly stated in the Jira snapshot. The story is ready for implementation.

---

## Technical Context

### Prior attempt / retrospective

A previous attempt at this story was recorded in `knowledge/retrospectives/R3DA-13330/` (sourced from the `r3da_niooo_ai_workspace/solid-train` control-plane). Key lessons:

- **Root cause tags**: `design-parity-missed`, `wrong-component-selection`, `false-green-tests`, `requirements-drift`, `orchestration-handoff-gap`
- **Primary failure**: Implementation drifted to alternate component composition instead of using the correct Density/CDM components for column management. Tests remained green against non-design assertions.
- **Corrective actions applied in prior attempt**: Fixed Density wrapper misuse, updated stale E2E column indexes, removed Sonar code smell, hardened brittle data-dependent E2E.
- **Remaining remediation required**: Reconcile implementation with latest Figma / header-menu-footer contract; enforce design parity evidence gate before PR progression.

**This plan therefore requires explicit Figma parity evidence and `cdm-menu` + `ds-list-item` (selectable=true, checkbox) composition as non-negotiable implementation constraints.**

### Figma design

| Ref | Detail |
|---|---|
| File | `D5XZ38C2ANMW7YWUKniYNE` |
| Node | `2020-15927` |
| URL | https://www.figma.com/design/D5XZ38C2ANMW7YWUKniYNE/-niooo--All-facilities?node-id=2020-15927&t=ndGkZ6BYj2SF3zGs-1 |
| Covers | All Facilities list view — configurable columns, column picker UI, table header/actions/footer layout |

The `frontend-implementer` **must** retrieve this Figma node and record screenshot comparison evidence before claiming completion. Given the prior failure on this exact story, Figma parity is a hard gate.

---

## Affected Repositories and Files

Only the **frontend** repository is affected. This story is a pure UI feature.

| Plan alias | Git remote | Default delivery branch |
|---|---|---|
| `frontend` | `qwerty/r3da_cdm_frontend` (`https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_frontend`) | `develop` |

### Expected files to change (frontend)

- All Facilities list component (table/list view), likely under `src/app/features/facilities/` or similar Angular module path — exact paths to be confirmed by `frontend-implementer` during local discovery
- Column configuration service or state (new or existing)
- Facility model / column definition (to add `description` column)
- `cdm-menu` + `ds-list-item` column-picker integration (table header action area)
- Playwright E2E test file for All Facilities list view
- Unit/component tests for the column configuration logic

---

## Architecture and Design Decisions

### Column picker — `cdm-menu` with `ds-list-item`

The column picker must use the project-local `cdm-menu` component as the outer container. Inside the menu, each selectable column entry must be rendered as a `ds-list-item` with `selectable=true` and a checkbox. The implementer must consult the Density MCP to confirm the exact `ds-list-item` API (props, checkbox variant, selectable binding) before writing code. Do not substitute `ds-menu` alone or any other combination — this constraint is set by the product owner.

### Column set — no columns removed

AC4 mandates that every column currently shown in the All Facilities list view must remain available for selection. The implementer must inventory all existing columns before adding the "Description" column.

### Description column (AC5)

A new "Description" column must be added to the available column pool. The data field backing it is expected to already be present in the facility entity returned by the API (component label `CDM`); if it is absent from the API response, the implementer should surface this as a blocker rather than guessing at a field name.

### Column re-ordering (AC2 — explicitly out of scope)

Product owner has confirmed column re-ordering is **not to be implemented** in this delivery. AC2 is optional in Jira and is explicitly descoped. No drag-and-drop or re-ordering logic should be built.

### Saving configuration (AC3 — optional)

Nice-to-have. If implemented, must use a persistence mechanism consistent with existing user-preference patterns in the repository (e.g. `localStorage`, user-settings API). Implementer must verify what is already used in the codebase.

### Sorting (not in scope)

The 2026-08-10 Jira comment requests per-column sorting. This is **not** formalised in any acceptance criterion and is out of scope for this delivery.

---

## Work Packages

### WP-1 — `frontend-implementer` (coding)

**Repository:** `frontend`  
**Agent:** `frontend-implementer` (`.github/agents/frontend-implementer.agent.md`)  
**Branch:** `feature/R3DA-13330-configurable-columns`  
**`open_pr`:** `false` (a11y-reviewer follows)

**Scope:**

1. Discover All Facilities list component, existing column definitions, and table action area in the `r3da_cdm_frontend` source tree.
2. Inventory all currently rendered columns — none may be removed from the available-column pool (AC4).
3. Add "Description" column to the column definition set (AC5); raise a blocker if the field is absent from the API DTO.
4. Implement a column-picker UI using `cdm-menu` as the outer container, with each column entry as `ds-list-item` with `selectable=true` and a checkbox, in the table header / actions area, aligned to Figma node `2020-15927` (AC1). Consult the Density MCP for the exact `ds-list-item` API before writing code.
5. ~~Column re-ordering (AC2)~~ — explicitly out of scope per product owner decision. Do not implement.
6. Implement configuration persistence if an existing mechanism is available and scope permits (AC3 — optional).
7. Retrieve Figma node `2020-15927` from file `D5XZ38C2ANMW7YWUKniYNE`; compare running UI with Playwright browser screenshots and record alignment or deviations as `figma_evidence`.
8. Write/update Playwright E2E test proving each mandatory AC in the running application.
9. Write/update unit/component tests for column configuration logic.
10. Run CI/lint/test suite; provide `validation_commands` output.

**Mandatory evidence:**

- `figma_evidence`: Figma node retrieved, screenshot comparison made, parity confirmed or deviations listed
- `e2e_evidence`: Playwright E2E test results for AC1, AC4, AC5
- `density_evidence`: `cdm-menu` outer container confirmed; `ds-list-item` with `selectable=true` and checkbox confirmed in column-picker implementation

**Figma references for dispatch:**

| Figma file | Node | Covers |
|---|---|---|
| `D5XZ38C2ANMW7YWUKniYNE` | `2020-15927` | All Facilities list — column picker, table header/footer, layout |

---

### WP-2 — `angular-test-engineer` (test-hardening)

**Repository:** `frontend`  
**Agent:** `angular-test-engineer` (`.github/agents/angular-test-engineer.agent.md`)  
**Phase:** `test-hardening`  
**Triggered:** Only if WP-1 leaves coverage gaps identified during review or CI  
**`open_pr`:** `false` (a11y-reviewer follows)

Closes any coverage gaps in column-picker component tests, E2E flows for optional ACs, and edge cases (all columns hidden, single column forced visible). Re-ordering tests are not required (AC2 is descoped).

---

### WP-3 — `a11y-reviewer` (accessibility-verification)

**Repository:** `frontend`  
**Agent:** `a11y-reviewer` (`.github/agents/a11y-reviewer.agent.md`)  
**Phase:** `accessibility-verification`  
**`open_pr`:** **N/A** — `a11y-reviewer` cannot open PRs; `open_pr: true` is assigned to **WP-1** (or WP-2 if triggered). The accessibility review runs **after** the PR is open, before `gates/child_ready.sh`.

Reviews WCAG 2.1/2.2 compliance for:
- Column-picker `cdm-menu` + `ds-list-item` (keyboard navigation, focus management, ARIA roles, checkbox semantics)
- Table column headers (scope attributes, reading order after column visibility changes)
- Any new interactive control added in the column-management UI

---

## Acceptance-Criterion Mapping

| AC id | Text | Jira source | Mandatory | Repo | Test IDs |
|---|---|---|---|---|---|
| AC1 | Users can configure what columns they want to see in the All Facilities list view | `When using the list view for the All Facilities screen, users can configure what columns they want to see` | Yes | `frontend` | `should open column picker and toggle column visibility`, `all-facilities configurable columns - user can show and hide columns` |
| AC2 | ~~Re-ordering~~ (explicitly descoped by product owner) | `Re-ordering the columns could be useful for visual comparisons` | No | — | — |
| AC3 | The column configuration can be saved and restored (optional) | `Saving that configuration might be useful for repeating tasks` | No | `frontend` | `should persist column configuration across page reloads` |
| AC4 | All current columns remain available for selection | `None of the current columns should disappear from the available columns for selection` | Yes | `frontend` | `should include all existing columns in column picker`, `all-facilities column picker - all existing columns are selectable` |
| AC5 | A new "Description" column is available | `New column "Description" should be added` | Yes | `frontend` | `should display Description column when enabled`, `all-facilities Description column - is available in column picker` |

---

## Dependencies and Sequence

```
WP-1 (frontend-implementer)
  └─> WP-2 (angular-test-engineer) [conditional on coverage gap]
        └─> WP-3 (a11y-reviewer) [always, after PR open]
```

No backend, ops, or infrastructure changes are required. This delivery touches only `r3da_cdm_frontend`.

---

## Validation and Evidence

| Check | Owner | How verified |
|---|---|---|
| Figma design parity | WP-1 | Playwright screenshots compared to node `2020-15927`; deviations listed in `figma_evidence` |
| `cdm-menu` + `ds-list-item` usage | WP-1 | `density_evidence` confirms `cdm-menu` outer container and `ds-list-item` with `selectable=true` and checkbox |
| AC1 E2E — column toggle | WP-1 | Playwright: `all-facilities configurable columns - user can show and hide columns` |
| AC4 E2E — all columns present | WP-1 | Playwright: `all-facilities column picker - all existing columns are selectable` |
| AC5 E2E — Description column | WP-1 | Playwright: `all-facilities Description column - is available in column picker` |
| WCAG 2.1/2.2 | WP-3 | `a11y-reviewer` report (read-only, no code edits) |
| CI (lint, unit, E2E) | WP-1 | `validation_commands` output in WP-1 return |

---

## Risks and Rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Description field absent from API DTO | Medium | WP-1 raises blocker immediately; do not guess at field name |
| Wrong component usage (prior failure) | High (prior failure) | WP-1 must use `cdm-menu` outer container + `ds-list-item` selectable+checkbox; `density_evidence` is mandatory and verified against Density MCP output |
| Figma drift from design (stale node) | Medium | WP-1 retrieves node fresh at implementation time; deviations recorded and escalated if blocking |
| E2E column index staleness (prior failure) | Medium | WP-1 must not use hardcoded column indexes in E2E tests; use column header text selectors |
| AC3 (saving configuration) scope creep | Low | Optional; implementer scopes out if time/design insufficient. AC2 (re-ordering) is already explicitly descoped. |

**Rollback:** Feature branch only — no merge to `develop` until all mandatory ACs pass `gates/child_ready.sh` and `gates/consensus.sh`. The PR can be closed without impact to main.

---

## Post-Approval Jira and Implementation Actions

1. Captain sets `human_gates.plan_accepted.status = "approved"` after human approval.
2. Captain updates `phase` to `implementation` and dispatches WP-1 to `frontend-implementer`.
3. After WP-1 returns `ready` with `open_pr: true` evidence, Captain runs `gates/child_ready.sh R3DA-13330 frontend`.
4. Captain dispatches WP-3 (`a11y-reviewer`) against the open PR.
5. Captain runs two independent Lookout reviews (different models, `correctness-architecture` and `adversarial-risk` lenses).
6. Captain runs `gates/consensus.sh R3DA-13330`.
7. On consensus, Captain advances to `delivery_gate` and awaits `HUMAN_GATE: DELIVERY_ACCEPTED`.

---

## Sources Inspected

| Source | Path / URL | Notes |
|---|---|---|
| Jira snapshot | `specs/R3DA-13330/jira-source.md` | Retrieved 2026-08-20T14:16:50 |
| State file | `specs/R3DA-13330/state.json` | Phase: planning, gate: intake passed |
| Knowledge index | `knowledge/INDEX.md` | — |
| Agent mappings | `knowledge/repositories/agent-mappings.md` | Commit on worktree HEAD |
| Repository inventory (ahoy) | `knowledge/system/repository-inventory.md` | — |
| Repository inventory (ai ws) | `r3da_niooo_ai_workspace/solid-train/knowledge/system/repository-inventory.md` | Confirms `develop` as delivery branch |
| Agent routing registry | `r3da_niooo_ai_workspace/solid-train/knowledge/system/agent-routing.md` | Confirms `frontend-implementer` → `angular-test-engineer` → `a11y-reviewer` sequence |
| Postmortem | `r3da_niooo_ai_workspace/solid-train/knowledge/retrospectives/R3DA-13330/postmortem.md` | Prior attempt analysis |
| Retrospective metrics | `r3da_niooo_ai_workspace/solid-train/knowledge/retrospectives/R3DA-13330/metrics.json` | Root cause tags, corrective actions |
| Child dispatch contract | `knowledge/process/child-dispatch-contract.md` | — |
| State schema | `knowledge/process/state-schema.md` | — |
| Plan gate | `gates/plan.sh` | — |
| Frontend repo local checkout | `/Users/sporting01183/copilot-worktrees/r3da_niooo_frontend` | Empty — no git history; live source to be discovered by `frontend-implementer` in child session |

**Frontend repository inspected commit/branch:** Not available locally — `frontend-implementer` must perform live discovery at dispatch time from `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_frontend` on branch `develop`.
