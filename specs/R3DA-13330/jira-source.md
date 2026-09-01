# Jira Source Snapshot: R3DA-13330

```
source: jira-mcp
retrieval_timestamp: 2026-08-20T14:16:50.653+01:00
snapshot_version: 1
issue_key: R3DA-13330
url: https://atc.asdgroup.net/jira/browse/R3DA-13330
```

## Summary

**[niooo] All Facilities list view has configurable columns**

## Description

### As a planner I want to to able to select and customize the columns in the list view for All Facilities so that I can quickly locate and compare relevant fields between different facilities.

### Implemented feature
Allow the user to choose more columns from all available in the database and configure which ones to display in the list view.
Being able to switch around the columns is a nice to have feature, but not a strict requirement.

### Design
https://www.figma.com/design/D5XZ38C2ANMW7YWUKniYNE/-niooo--All-facilities?node-id=2020-15927&t=ndGkZ6BYj2SF3zGs-1

## Acceptance Criteria

1. **[MANDATORY]** `When using the list view for the All Facilities screen, users can configure what columns they want to see` — id: 1, rank: 0, checked: false
2. **[optional]** `Re-ordering the columns could be useful for visual comparisons` — id: 2, rank: 1, checked: false
3. **[optional]** `Saving that configuration might be useful for repeating tasks` — id: 3, rank: 2, checked: false
4. **[MANDATORY]** `None of the current columns should disappear from the available columns for selection` — id: 4, rank: 3, checked: false
5. **[MANDATORY]** `New column "Description" should be added` — id: 5, rank: 4, checked: false

## Core Fields

| Field | Value |
|---|---|
| **Issue key** | R3DA-13330 |
| **Issue ID** | 29469649 |
| **Issue type** | Story |
| **Status** | In Progress |
| **Priority** | Low |
| **Story Points** | 5.0 |

## People

| Role | Name |
|---|---|
| **Assignee** | daniel almeida (sporting) |
| **Reporter** | Daniel Radetic (sporting) |

## Classification & Scheduling

| Field | Value |
|---|---|
| **Labels** | `niooo_Cycle_03/2026` |
| **Components** | `CDM` |
| **Fix Versions** | `Cycle 03/2026` |
| **Sprint** | `niooo 2026/11` (ACTIVE; ends 2026-08-25) |
| **Epic Link** | R3DA-11138 |
| **Team** | The Guardians |
| **Feature Team** | sporting |

## Timestamps

| Field | Value |
|---|---|
| **Created** | 2026-07-24 09:10:23 WEST |
| **Updated** | 2026-08-10 17:03:54 WEST |

## Comments

**2026-07-27** — Marta Meleiro: design added

**2026-08-10** — Daniel Radetic: If we can make every column support sorting, it would solve a topic on the feedback list about columns "supplier" and "responsible" while preventing the issue with other columns in the future.

## Open Questions

- The 2026-08-10 comment asks whether every column should support sorting to address feedback about "supplier" and "responsible" columns. This is not captured in any AC and may represent pending scope.
- No explicit out-of-scope list; column re-ordering and saving configuration are nice-to-have (mandatory: false).

## Boundaries / Out of Scope

The Jira ticket states no explicit out-of-scope items. Based on the description and acceptance criteria:
- Column re-ordering is explicitly a **nice-to-have** (AC #2, mandatory: false): *"Being able to switch around the columns is a nice to have feature, but not a strict requirement."*
- Saving the column configuration is a **nice-to-have** (AC #3, mandatory: false).
- Column sorting is mentioned in a comment (2026-08-10) but is **not formalised** into any acceptance criterion and is therefore out of scope for this delivery.
