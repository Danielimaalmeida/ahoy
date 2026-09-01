# Implementation Plan: R3DA-13674

[niooo] Adjust height of tree views in Combined view

## 1. Jira source and readiness

- Snapshot: `specs/R3DA-13674/jira-source.md` (retrieved 2026-08-30T12:30:59.696+01:00, snapshot v1.0).
- Navigator completeness: `FULL`, no open questions. `gates/intake.sh` passed 2026-08-30T11:31:40Z.
- Summary: as a planner, resize the electrical/mechanical tree heights inside the Combined view's trees container, the same way horizontal resizing already works, so more vertical space can be given to whichever tree needs it.
- Two Jira acceptance-criteria bullets plus an explicit boundary ("must respect a minimum height constraint") and a technical note ("We should have a minimum height", "frontend only"). All three are mapped to `acceptance_criteria[]` below (the boundary is split out as its own criterion, AC3, because it is independently testable and explicitly required).
- Re-checked Jira directly at planning-round 2 for new comments or an updated description: none found (`updated` unchanged at 2026-08-30T11:18:12Z; zero comments). The single attached mockup screenshot (`image-2026-08-10-17-39-51-329.png`) and the linked Confluence feedback-list image were reviewed for additional textual/numeric spec beyond what is already quoted here; neither tool available to this session can render the image content itself, so no additional fact was extracted from it beyond the text already captured above.

### Revision (round 2)

Round 1 was sent back from `plan_review` (`decision_log`, 2026-08-30T11:43:08Z) without a recorded reason in `state.json` (revision feedback is delivered interactively, per `bin/revise.sh`, and this round ran unattended). Re-reading the round-1 plan against this profile's own instruction — that an unresolved judgment call handed to the approval gate is a deferral, not a resolution — found exactly that shape in two places, both now fixed:

1. §4.5 (minimum height) previously read as a question for the approver ("surfaced here for the human plan-approval gate; if rejected, replan"). It is now a decided value (`150px`) with rationale, that the implementer ships as specified.
2. §4.7 (accessibility) previously described keyboard resize as merely "expected". It is now tied explicitly to the repository's own accessibility policy ("Preserve semantic HTML and keyboard operability", `.github/instructions/accessability-best-practices.instructions.md`), given its own test id under AC1, and called out in the risk section as a policy-driven requirement outside the literal Jira AC text.

No other content changed: the architecture, work-package sequence, and acceptance-criterion set are unchanged from round 1.

## 2. Technical context

- Single affected repository: `r3da_niooo_frontend` (plan alias `frontend`), Angular v21 workspace, one project `r3da-cdm-frontend`, selector prefix `cdm`, `sourceRoot: src`, style language SCSS, unit tests via `@angular/build:unit-test` + Vitest (`vitest.config.ts`, `src/test-providers.ts`, `src/test-setup.ts`), Playwright E2E under `playwright/tests/`.
- Inspected live repository at commit `da66a91c933242c59fc4641da62c3ca1e8fcc7c7` on branch `main` (checked out read-only via `bin/repo.sh frontend` into `work/.clones/frontend`).
- Live sources inspected: `.github/copilot-instructions.md` tree, `.github/instructions/{accessability-best-practices,architecture,general,branching-instructions}.instructions.md`, `.github/skills/testing-standards/SKILL.md`, `.github/agents/frontend-implementer.agent.md`, `angular.json`, `package.json`, and the source files listed below.
- Knowledge sources inspected: `knowledge/INDEX.md`, `knowledge/process/delivery-phases.md`, `knowledge/process/state-schema.md`, `knowledge/system/repository-inventory.md`, `knowledge/repositories/agent-mappings.md` (frontend section, v3.3, reviewed 2026-08-26).
- Relevant existing feature code (all under `src/app/features/facility/components/containers/combined-structure/`):
  - `combined-structure.component.html` / `.ts` / `.scss` / `.spec.ts` — the Combined view container. Already renders three horizontally-resizable flex panels (`.main__trees`, then a `<cdm-dual-structure>` for electrical, then one for mechanical), separated by two `<div class="resizer">` bars whose `mousedown` is wired in `ngAfterViewInit` to `onResizerMouseDown`, which resizes the two flex siblings adjacent to the dragged bar (`getAdjacentPanels`, `startDrag`, `resizePanels`, `getMinWidth`), clamped between each sibling's computed `min-width` (falling back to `MIN_PANEL_SIZE = 50`).
  - `dual-tree/dual-tree.component.ts` / `.html` / `.scss` — renders one tree panel (`cdm-dual-tree`) with a title bar and a scrollable `.tree__block__items` region. Two instances (`electrical`, `mechanical`) sit stacked inside `.main__trees` (`display: flex; flex-direction: column`) with **no resizer between them today** and no explicit per-instance `flex-basis`/`min-height` — this is exactly the gap the story asks to close.
  - `dual-structure/dual-structure.component.*` — unaffected; referenced only as the existing pattern for the (already resizable) neighbouring panels.
- A separate, unrelated mechanism, `shared/directives/resizable/resizable.directive.ts` (`cdm-resizable`), makes a **single** host element self-resize via its own edge handle (used today only by `horizontal-collapsible-menu`). It is not used by `combined-structure` and is not the right fit here — see Architecture decision below.
- No Figma reference is present in `jira-source.md`; none is passed to the frontend work package.

## 3. Affected repositories and files

| Repository | Plan alias | Files expected to change |
|---|---|---|
| `r3da_niooo_frontend` | `frontend` | `src/app/features/facility/components/containers/combined-structure/combined-structure.component.html`, `.ts`, `.scss`, `.spec.ts`; a new Playwright spec under `playwright/tests/facility-pages/`; no other repository is touched (frontend-only, per Jira boundary) |

No backend, ops, or other repository is affected. `r3da_cdm_backend`, `r3da_cdm_ops`, etc. are out of scope for this story.

## 4. Architecture and design decisions

1. **Reuse and generalize the existing sibling-panel resizer, not the `ResizableDirective`.** The Jira ask is explicitly "just like the width of other elements already are" — that existing pattern is the bespoke resizer-bar + adjacent-flex-sibling mechanism already in `combined-structure.component.ts`, not the self-resizing `cdm-resizable` directive (a different UX: one element resizing itself via its own edge, used only by the collapsible menu). Introducing a second resize mechanism for the same UI would create two divergent implementations of "drag to resize" in one component; generalizing the one that already matches the requested behavior is the smaller, more consistent change.
2. **Add a fourth resizer bar** in `combined-structure.component.html`, between the electrical and mechanical `<cdm-dual-tree>` elements inside `.main__trees` (currently there is no separator there at all).
3. **Make the existing resize handling orientation-aware** instead of adding a parallel vertical-only code path:
   - `onResizerMouseDown`, `startDrag`, `resizePanels`, and `getMinWidth` currently assume a horizontal drag (`clientX`, `width`, computed `min-width`). Generalize them (e.g. an orientation resolved from a marker on the new resizer element, such as a `resizer--vertical` class / `data-orientation` attribute) so the same `viewChildren('resizer')` list continues to drive all four bars: for the vertical bar, read `clientY` instead of `clientX`, read/set height instead of width, and add a `getMinHeight` mirroring `getMinWidth` but reading computed `min-height`.
   - Because `.main__trees` has a fixed `height: 100%` and exactly two flex children, the sibling's min implicitly caps the other panel's max — identical to how the three existing horizontal panels already behave. No separate max-height constraint is needed.
4. **New `.resizer--vertical` SCSS**, mirroring the existing `.resizer` styling exactly (same background/hover token) but `height: 1px; width: 100%; cursor: row-resize;` growing to `height: 3px` on hover, instead of the horizontal bar's `width`/`cursor: col-resize`.
5. **Minimum height value — decided: `min-height: 150px` per tree panel (`cdm-dual-tree` instance).** Jira states only "We should have a minimum height" with no number, so this is a judgment call, not a Jira fact — but it is a *resolved* decision, not an open question left for the plan-approval gate to answer. Reading the codebase found no existing vertical precedent (the horizontal case uses `min-width: 320px` / `min-width: 350px` on the two outer panel classes, with a generic `MIN_PANEL_SIZE = 50` fallback for anything without a specified `min-width`). `150px` is set following the same pattern as those existing constants: it is large enough to keep the title bar plus a few tree rows usable, and small enough that the sibling panel is never starved when one tree needs most of the vertical space. This value ships as-is; `frontend-implementer` implements it directly rather than re-opening the question. It may only be revisited if the running-app comparison during implementation surfaces a concrete usability defect (e.g. clipped content) at that value, in which case the replacement value and the reason are recorded as evidence, not silently substituted.
6. **No persistence across reloads.** The existing three horizontal resizers do not persist size to `localStorage`/`sessionStorage` (confirmed by inspection) — sizes reset on navigation/reload. The new vertical resizer follows the same behavior for consistency; no new persistence mechanism is introduced.
7. **Accessibility — decided, not optional.** `.github/instructions/accessability-best-practices.instructions.md` states plainly: "Preserve semantic HTML and keyboard operability" for user-facing UI changes, and treats high-severity regressions as blockers. The new drag handle is exactly such UI, so keyboard operability is in scope for this story, not an extra the implementer may skip:
   - Add `role="separator"` and `aria-orientation="vertical"` to the new bar (align the pre-existing three horizontal bars to equivalent semantics only if trivial; do not expand scope to rework them if it is not).
   - Add arrow-key resize (Up/Down adjusts the vertical split, mirroring how the existing horizontal bars would need Left/Right — implement for the new vertical bar; do not block this story on retrofitting the existing bars if they currently lack it).
   - `a11y-reviewer` (WP2) verifies this in the running app and treats any high-severity finding as blocking per repository policy, per its own review contract — it is a verification step, not the mechanism that decides whether keyboard support is built.

## 5. Work packages and task breakdown

All work is in `r3da_niooo_frontend`. Sequence and specialists per `knowledge/repositories/agent-mappings.md` (frontend section):

| id | agent | phase | depends_on | open_pr | summary |
|---|---|---|---|---|---|
| WP1 | `frontend-implementer` | `coding` | — | **true** | Implement the vertical resizer per the design above (template, orientation-aware resize logic, SCSS, min-height), write first-pass unit tests (Vitest) and a Playwright E2E covering AC1–AC3, open the PR, post `@copilot` |
| WP2 | `a11y-reviewer` | `accessibility-verification` | WP1 | false | Review the new resizer handle and the two tree panels for WCAG 2.1/2.2 findings (role/orientation, keyboard operability, focus visibility); review-only, no edit tool, dispatched after WP1's PR is open, before `gates/child_ready.sh` |

`angular-test-engineer` is **not** included as a planned work package: the frontend-implementer owns first-pass unit + Playwright coverage for everything it implements, and per the mapping this specialist is only added when a coverage gap is later identified (by review, CI, or verification) — not by default at plan time.

`open_pr: true` is on WP1 because `a11y-reviewer` has no edit/push capability and cannot open a pull request (per the mapping's explicit rule for when the review step is last in the sequence).

## 6. Acceptance-criterion mapping

| id | text | repo | test_ids |
|---|---|---|---|
| AC1 | The trees container in the Combined view (electrical and mechanical tree panels) supports adjustable height via a new vertical resize handle, in addition to the existing horizontal resizing. | frontend | `resizes tree panel height via vertical drag handle`, `resizes tree panel height via keyboard arrow keys on the separator`, `combined-structure-tree-height-resize.e2e.spec.ts` |
| AC2 | Tree structure viewport height is configurable by drag and drop, using the same drag-to-resize interaction pattern already used for the width of the other Combined-view panels. | frontend | `drag handle updates electrical and mechanical tree heights independently`, `combined-structure-tree-height-resize.e2e.spec.ts` |
| AC3 | Vertical resizing of the tree structure viewports respects a configured minimum height and cannot shrink either panel below it. | frontend | `clamps tree panel height at configured minimum during drag` |

`source_quote` values (verbatim from `jira-source.md`) are recorded in `state.json`, not repeated here, per the plan gate's requirement that they be checked programmatically.

## 7. Dependencies and sequence

```
WP1 (frontend-implementer, opens PR)
  └── WP2 (a11y-reviewer, post-PR accessibility pass)
```

No cross-repository dependencies exist; this is a single-repository, frontend-only delivery.

## 8. Validation and evidence

Per `.github/skills/testing-standards/SKILL.md` and the `frontend-implementer` agent profile:

- `npm run test` / `npm run test:coverage` — Vitest unit/integration coverage for the generalized resize logic (`combined-structure.component.spec.ts`), including the new orientation-aware branches, `getMinHeight`, and the arrow-key handler for the new separator.
- `npm run playwright` — new/updated Playwright spec exercising AC1–AC3 in the running app (drag the new vertical handle, observe both tree panel heights change, observe the clamp at the minimum, operate the handle via arrow keys), started via `npm run start:keycloak` per repository convention.
- `npm run lint` / `npm run format`.
- SonarQube quality gate checked via the frontend-implementer's documented flow before reporting `ready`; any inherited (pre-existing) issue goes to `remaining_gaps`, not fixed as part of this scope.
- `a11y-reviewer` findings (WP2) recorded as `remaining_gaps`/blockers as appropriate; high-severity accessibility regressions are blocking per repository policy.
- Visual/behavioral confirmation of the drag interaction requires the running app (per `.github/instructions/general.instructions.md`); if the dev server cannot start, the affected evidence is `unverified` with a stated reason, never a code-only claim of `ready`.

## 9. Risks and rollback

- **Risk:** generalizing the shared resize-handling methods for orientation could regress the three existing horizontal resizers. Mitigation: existing `combined-structure.component.spec.ts` coverage for `onResizerMouseDown`/`getAdjacentPanels`/`resizePanels` must continue to pass unmodified in intent (horizontal behavior unchanged), plus new orientation-specific tests are additive.
- **Risk:** `150px` minimum height is a Cartographer judgment call, not a Jira-supplied number. Mitigation: this plan resolves the value now, with rationale tied to the existing `min-width` constants, rather than leaving it as an open question at the approval gate; the implementer ships it as specified and only deviates if a concrete usability defect is found during implementation, recording the change and reason as evidence.
- **Risk:** keyboard operability for the new separator is a repository accessibility policy requirement, not an explicit Jira acceptance criterion, so it could be under-scoped by an implementer optimizing strictly to the AC text. Mitigation: called out as a decided (non-optional) requirement in §4.7, with its own test id in AC1, and re-verified by `a11y-reviewer` (WP2) before the repository is marked ready.
- **Rollback:** single, isolated frontend PR; revert is a normal PR revert with no data migration, backend, or ops coupling (frontend-only per Jira boundary).

## 10. Post-approval Jira and implementation actions

- On `plan_review` approval, Captain sets `human_gates.plan_accepted` and proceeds to `implementation`, dispatching WP1 to `frontend-implementer` on branch `feature/R3DA-13674-combined-view-tree-vertical-resize` against `main`, per the child dispatch contract.
- WP2 (`a11y-reviewer`) is dispatched once WP1's PR is open, before `gates/child_ready.sh` runs for the repository.
- No Jira transition or comment is made by planning; that is an implementation/delivery-phase action.
