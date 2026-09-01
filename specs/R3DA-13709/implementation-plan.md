# Implementation Plan: R3DA-13709

## Jira Source and Readiness

| Field | Value |
|---|---|
| Story | R3DA-13709 — [niooo] API update for SAS |
| Snapshot | `specs/R3DA-13709/jira-source.md` (retrieved 2026-08-29T17:22:11+01:00) |
| Navigator completeness | FULL |
| Acceptance criteria | 3 (AC1 mandatory) |
| Blocking open questions | None |

---

## Technical Context

### Affected repository

| Field | Value |
|---|---|
| Alias | `backend` |
| Slug | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_backend` |
| Default branch | `main` |
| Inspected commit | `a554a64927984a32432994e386c645c718b87d82` (branch: `main`) |
| Branch convention | `feature/R3DA-13709-sas-attributes-eplan` |

Only one repository is affected. Per the Jira technical notes, this is
explicitly a `r3da_cdm_backend`-only story: API v2 update, no new API version,
no frontend change.

### Sources inspected

- `knowledge/system/repository-inventory.md`
- `knowledge/repositories/agent-mappings.md` (`r3da_cdm_backend` section, v3.3)
- `knowledge/system/business-context.md` (electrical structure / node hierarchy)
- Live `r3da_cdm_backend@a554a64` (`.github/agents/backend-implementer.agent.md`,
  `.github/agents/backend-test-engineer.agent.md`,
  `.github/skills/delivery-handoff/SKILL.md`)
- `src/main/java/com/asd/ito/resource/electrical/structure/ElectricalStructureResourceV2.java`
- `src/main/java/com/asd/ito/dtos/electrical/structure/sas/SASPartDTO.java`
- `src/main/java/com/asd/ito/dtos/electrical/structure/sas/SASFileUploadDTO.java`
- `src/main/java/com/asd/ito/service/mappers/electrical/structure/sas/SASPartMapper.java`
- `src/main/java/com/asd/ito/service/file/FacilityFileService.java`
  (`uploadSASFileAndUpdateElectricalStructure`)
- `src/main/java/com/asd/ito/domain/facility/ElectricalPart.java`
- `src/main/java/com/asd/ito/domain/facility/Part.java`
- `src/test/java/com/asd/ito/service/mappers/electrical/structure/sas/SASPartMapperTest.java`
- `src/test/java/com/asd/ito/integration/electrical/structure/ElectricalStructureResourceIT.java`
- `src/test/resources/eplan/3DF5MBG24/sas_v8.json`

### Key codebase facts

1. The endpoint in scope is `POST /v2/electrical-structures/{masterString}/eplan`
   (`ElectricalStructureResourceV2.createFromSASFile`), which delegates directly
   to `FacilityFileService.uploadSASFileAndUpdateElectricalStructure`. This is
   the only inbound path for SAS's JSON payload — confirmed no other
   constructor call site builds `SASPartDTO` outside tests, so the change is
   fully isolated to this ingestion path (no impact on the Excel/AML internal
   upload flow, which builds structures a different way).
2. `SASPartDTO` (record) currently exposes only `articleData` (`Map<String,
   String>`) alongside `fullCode`, `code`, `type`, `children`. It has no
   `attributes` field today — this is the gap the story closes.
3. `SASPartMapper.toElectricalPart` is the single place that turns a
   `SASPartDTO` node into a persisted `ElectricalPart`:
   - When `articleData != null`, it derives `code` from
     `articleData.get("artikelnummer")` (falling back to `dto.code()`), builds
     the `ElectricalPart`, and calls `articleData.forEach(part::addAttribute)`
     to store each key/value as a node attribute.
   - Otherwise it builds a plain `ElectricalPart` from `dto.code()`.
4. **Design-relevant bug already present, load-bearing for this story:** in the
   `articleData != null` branch, `dto.children()` is **never processed** — the
   branch returns immediately after adding attributes. This is currently
   harmless because, per the business model, `articleData` is only ever sent
   for `ARTICLE` nodes, and Articles are leaf nodes (business-context.md:
   "Articles are leaf nodes"). The new `attributes` property is sent for
   **other node types** (`FUNCTIONAL_GROUP`, `FUNCTIONAL_UNIT`, `BMK`, per the
   V8/L7 hierarchy), which **do** have children. Reusing the existing branch
   unmodified would silently drop every child of any non-leaf node that
   carries `attributes` — a correctness regression, not a hypothetical. The
   mapper must always recurse into `dto.children()` regardless of which
   attribute source was used.
5. `ElectricalPart.addAttribute(key, value)` (overridden from `Part`) is
   type-agnostic — it already works for any `ElectricPartType`, so no change
   is needed there. The generic key/value store is reused; only the *source*
   of the map presented to it changes.
6. `Part.ATTRIBUTES` (`"attributes"`) is the existing generic property bucket
   already returned to clients on every node (`getAttributes()`), so no
   separate "display" change is needed — the existing GET endpoints already
   surface whatever `addAttribute` stored. AC2's "store and display" is
   satisfied by correct storage; display is pre-existing, generic behaviour.
7. No AGE graph repository, `QueryBuilder`, `CypherFunctionCaller`, or
   `GraphInsertDataGenerator` code is touched — the change is confined to the
   DTO/mapper layer, before any graph persistence call. `graph_performance_evidence`
   is **not applicable**.
8. Test fixture `src/test/resources/eplan/3DF5MBG24/sas_v8.json` and
   `ElectricalStructureResourceIT.uploadSASFileShouldReturnOk` already exercise
   the `/eplan` endpoint end-to-end against a real facility, giving a pattern
   to extend for a new `attributes`-bearing fixture/IT test.
9. No Figma/design references apply — backend-only, no UI.

---

## Architecture and Design Decisions

### 1. `SASPartDTO` — add `attributes` field

Add `Map<String, String> attributes` alongside the existing `articleData`
field. Both remain nullable/optional (SAS may omit either), matching how
`articleData` behaves today.

### 2. `SASPartMapper.toElectricalPart` — precedence + always recurse

Implement the exact precedence rule from the ticket:

> We first check if the node has attributes set, if it has, then we use the
> attributes property. If not, we check if the node has articleData set and
> use. If none of the properties are set, then we simply ignore and proceed.

Concretely:

1. Resolve `nodeAttributes = dto.attributes() != null ? dto.attributes() : dto.articleData()`.
2. If `nodeAttributes != null`: derive `code` the same way as today
   (`defaultIfBlank(nodeAttributes.get("artikelnummer"), dto.code())` — kept
   for backward compatibility with `ARTICLE` nodes; harmless no-op for other
   types since they will not carry an `artikelnummer` key), build the
   `ElectricalPart`, call `nodeAttributes.forEach(part::addAttribute)`.
3. If `nodeAttributes == null`: build the `ElectricalPart` from `dto.code()`
   as today ("ignore and proceed" — no attributes are set, the node is still
   created normally).
4. **In both branches**, recurse into `dto.children()` and attach mapped
   children — fixing the dropped-children gap in fact 4 above. This is
   required for correctness now that non-leaf node types can carry
   `attributes`.

This is a pure backend/domain change: no new Flyway migration, no new API
version (confirmed by the ticket: "We can do this update on the API v2.
There is no need to create a new API version, since SAS is the only
consumer"), no resource-layer signature change — `SASFileUploadDTO` and the
`/eplan` endpoint signature are unchanged; only the nested DTO gains a field
and the mapper gains the precedence/recursion logic.

### 3. Forward-compatibility note (non-blocking)

The ticket states "SAP may have more fields in the future ... without the
need for changes in a rush." The generic `Map<String, String>` shape for both
`attributes` and `articleData`, combined with `addAttribute` writing straight
into the generic `attributes` node property bucket, already satisfies this —
any new key SAP adds inside either map is stored and displayed with no code
change. No additional abstraction is required for this story.

---

## Work Packages

### WP1 — Implementation + first-pass tests

| Field | Value |
|---|---|
| id | WP1 |
| repo | `backend` |
| agent | `backend-implementer` |
| phase | `implementation` |
| dependency | none |
| open_pr | `false` |

**Scope:**

1. `src/main/java/com/asd/ito/dtos/electrical/structure/sas/SASPartDTO.java` —
   add `Map<String, String> attributes` field.
2. `src/main/java/com/asd/ito/service/mappers/electrical/structure/sas/SASPartMapper.java` —
   implement the attributes-then-articleData-then-ignore precedence rule, and
   fix child recursion so it always runs regardless of which branch was taken.
3. `src/test/java/com/asd/ito/service/mappers/electrical/structure/sas/SASPartMapperTest.java` —
   first-pass unit tests for the precedence rule and the children-preserved
   fix (see Acceptance Criterion Mapping below).
4. `src/test/java/com/asd/ito/integration/electrical/structure/ElectricalStructureResourceIT.java` —
   first-pass `@QuarkusTest` + REST Assured coverage proving the `/eplan`
   endpoint accepts and persists `attributes` on non-`ARTICLE` nodes
   end-to-end (new JSON fixture alongside the existing `sas_v8.json` pattern).

**Acceptance criteria covered:** AC1, AC2, AC3

### WP2 — Test hardening (mandatory `*IT.java` + unit coverage)

| Field | Value |
|---|---|
| id | WP2 |
| repo | `backend` |
| agent | `backend-test-engineer` |
| phase | `testing` |
| dependency | WP1 |
| open_pr | `true` |

**Scope:** Always dispatched after WP1, per this repository's mapping (not
conditional on a coverage gap). Hardens/broadens the unit suite in
`SASPartMapperTest` and owns the mandatory `*IT.java` endpoint suite for the
`/eplan` attributes behaviour — augmenting the IT test WP1 added rather than
leaving it as the only coverage. Opens the pull request (last work package
for this repository) and posts `@copilot` per the delivery-handoff skill.

**Acceptance criteria covered:** AC1, AC2, AC3

No `security-remediation` work package: no CVE/vulnerability finding is in
scope for this story.

---

## Acceptance Criterion Mapping

| ID | Text | Source quote | Repo | Test IDs |
|---|---|---|---|---|
| AC1 | The `/electrical-structures/{masterString}/eplan` endpoint (API v2) accepts and persists the new `attributes` property sent by SAS for non-ARTICLE nodes, end to end | `Deploy new API to support SAP integration with changes from August 2026.` | `backend` | `uploadSasFileWithAttributesShouldStoreNonArticleNodePropertiesAndPreserveChildren` |
| AC2 | niooo uses the `attributes` property sent by SAS as node properties in the electrical structure (stored and displayed via the existing generic attributes mechanism), and children of a node carrying `attributes` are preserved | `Use the "attributes" fields to store and display any extra information provided by SAP. niooo should use the attributes property sent by SAS and use them as node properties in the electrical structure.` | `backend` | `toElectricalPartMapsAttributesAsNodePropertiesForNonArticleNodes`, `toElectricalPartPreservesChildrenWhenAttributesArePresent` |
| AC3 | Precedence rule: use `attributes` if present; else use `articleData` if present; else leave the node without attributes and continue processing normally | `We first check if the node has attributes set, if it has, then we use the attributes property. If not, we check if the node has articleData set and use. If none of the properties are set, then we simply ignore and proceed.` | `backend` | `toElectricalPartPrefersAttributesOverArticleDataWhenBothPresent`, `toElectricalPartFallsBackToArticleDataWhenAttributesAbsent`, `toElectricalPartLeavesNodeUnattributedWhenNeitherPropertyPresent` |

---

## Dependencies and Sequence

```
WP1 (backend-implementer, implementation)
  └─> WP2 (backend-test-engineer, testing) — opens the pull request
```

No other repositories affected; no cross-repo sequencing.

---

## Validation and Evidence

- `./mvnw test` — unit tests, including all `SASPartMapperTest` additions.
- `./mvnw verify -DskipITs=false` — unit + `*IT.java` suite, including the new
  `ElectricalStructureResourceIT` coverage (bare `./mvnw verify` skips ITs by
  default in this repo and must not be used as the sole evidence).
- `./mvnw checkstyle:check` — lint.
- PR diff must contain the literal test method name strings listed in
  `test_ids` above — `gates/child_ready.sh` greps for them verbatim.
- `graph_performance_evidence`: not applicable (no AGE graph repository,
  `QueryBuilder`, `CypherFunctionCaller`, or `GraphInsertDataGenerator` code
  changed) — record as `N/A` with that reason.
- `lookout-defect` and `lookout-design` review after the pull request is open,
  per this repository's mapping (no repo-local reviewer agent exists here).

---

## Risks and Rollback

| Risk | Mitigation |
|---|---|
| Reusing the existing `artikelnummer`-based code-override logic against a non-ARTICLE node's `attributes` map could coincidentally match a key named `artikelnummer` | Extremely unlikely given SAP's field naming is specific to article data; `defaultIfBlank` falls back to `dto.code()` when absent, matching today's safe default. Flagged here as an accepted, low-probability risk rather than adding type-gating not requested by the ticket. |
| Fixing the dropped-children bug changes existing `ARTICLE`-branch behaviour if `dto.children()` is ever unexpectedly non-null for an `ARTICLE` node | Existing behaviour already assumes `ARTICLE` nodes are leaves (business-context.md) and existing fixtures/tests reflect that; the fix is additive (recurse always) and does not change output when `children()` is null/empty, which is the existing case for every current ARTICLE fixture. |
| SAP adds further fields beyond `attributes`/`articleData` in the future | Explicitly out of scope per the ticket ("without the need for changes in a rush"); already accommodated by the generic `Map<String,String>` shape — no action needed now. |

Rollback: revert the pull request. No Flyway migration, no data migration, no
API version bump — a revert fully restores prior behaviour.

---

## Post-Approval Jira and Implementation Actions (blocked until `HUMAN_GATE: PLAN_ACCEPTED`)

1. Captain advances phase to `implementation`.
2. Captain/`bin/dispatch.sh` dispatches WP1 to `backend-implementer` on
   `feature/R3DA-13709-sas-attributes-eplan`.
3. After WP1 reports `ready`, Captain dispatches WP2 to `backend-test-engineer`,
   which opens the pull request and posts `@copilot`.
4. Captain runs `gates/child_ready.sh` once `backend-test-engineer` reports
   `ready`.
5. Captain runs dual Lookout reviews (`lookout-defect`, `lookout-design`) after
   the pull request is verified open.
