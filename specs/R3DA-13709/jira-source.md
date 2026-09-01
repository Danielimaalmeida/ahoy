# Jira Source Snapshot: R3DA-13709

```
source: jira-mcp
retrieval_timestamp: 2026-08-29T17:22:11.822+01:00
snapshot_version: 1
issue_key: R3DA-13709
url: https://atc.asdgroup.net/jira/browse/R3DA-13709
```

## Summary

**[niooo] API update for SAS**

## Description

### As a SAP user I want to exchange information with niooo's API so that I can work faster than manually utilizing both systems.

### Context

SAS uses niooo api /electrical-structures/{id}/eplan to push a JSON file that represents an electrical structure into niooo. We use that JSON, parse it and create an electrical structure. Until now, for nodes of type ARTICLE, SAS was setting a property called *articleData* (key-value pair), that niooo transforms into node properties. From now on, SAS will send an additional property in the other node types called *attributes.*

### Implemented feature

niooo's API is updated to keep up with changes to file structure from SAP.

Use the "attributes" fields to store and display any extra information provided by SAP. niooo should use the attributes property sent by SAS and use them as node properties in the electrical structure.

### What we know so far
* SAP may have more fields in the future and we want niooo to be able to respond without the need for changes in a rush.

### Technical Notes
* This is a r3da_cdm_backend only user story
* The /electrical-structures/{masterString}/eplan endpoint is the endpoint to be updated
* The current received payload expects nodes to have a property called "articleData" which is basically key-value objects
* SAS added a new properties called "attributes" in the other types of nodes.
* With the current change, we will start reading the attributes property and use the key-values as node attributes
* As of today, SAS is sending these attributes under a property called "articleData" in nodes of type ARTICLE and in a property called "attributes" for the other types of nodes
* A good solution is applying a generic rule: We first check if the node has attributes set, if it has, then we use the attributes property. If not, we check if the node has articleData set and use. If none of the properties are set, then we simply ignore and proceed.
* We can do this update on the API v2. There is no need to create a new API version, since SAS is the only consumer and is expecting this change.

## Acceptance Criteria

1. **[MANDATORY]** `Deploy new API to support SAP integration with changes from August 2026.` — id: 1, rank: 0, checked: false
2. `Use the "attributes" fields to store and display any extra information provided by SAP. niooo should use the attributes property sent by SAS and use them as node properties in the electrical structure.`
3. `We first check if the node has attributes set, if it has, then we use the attributes property. If not, we check if the node has articleData set and use. If none of the properties are set, then we simply ignore and proceed.`

## Core Fields

| Field | Value |
|---|---|
| **Issue key** | R3DA-13709 |
| **Issue ID** | 29703849 |
| **Issue type** | Story |
| **Status** | In Progress |
| **Priority** | Medium |

## People

| Role | Name |
|---|---|
| **Assignee** | daniel almeida (sporting) |
| **Reporter** | daniel almeida (sporting) |
| **Creator** | Daniel Radetic (sporting) |

## Classification & Scheduling

| Field | Value |
|---|---|
| **Labels** | None |
| **Components** | CDM |
| **Sprint** | 2026/12 sporting Guardians (ACTIVE; ends 2026-09-15) |
| **Epic Link** | R3DA-9962 |
| **Team** | The Guardians |
| **Feature Team** | sporting |

## Timestamps

| Field | Value |
|---|---|
| **Created** | 2026-08-13T08:11:31.038+0000 |
| **Updated** | 2026-08-28T17:26:16.382+0000 |

## Open Questions

- None.

## Boundaries / Out of Scope

- Scope is strictly backend-only (`r3da_cdm_backend`).
- Update `/electrical-structures/{masterString}/eplan` endpoint on API v2.
- No new API versioning needed.
- No frontend changes required.
