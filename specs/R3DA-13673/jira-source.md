# Jira Source Snapshot: R3DA-13673

## Metadata
- **Issue Key**: R3DA-13673
- **Issue URL**: https://atc.asdgroup.net/jira/browse/R3DA-13673
- **Summary**: [niooo] Mechanical tree instances order
- **Issue Type**: Story
- **Project**: Realtime 3D Applications (`R3DA`)
- **Status**: New
- **Component**: CDM
- **Team**: The Guardians
- **Feature Team**: sporting
- **Sprint**: 2026/12 sporting Guardians
- **Reporter**: Daniel Radetic (sporting)
- **Created**: 2026-08-10T15:33:45.806+0000
- **Updated**: 2026-08-31T09:06:04.880+0000
- **Source**: jira-mcp
- **Retrieval Timestamp**: 2026-08-31T10:06:22Z
- **Snapshot Version**: 1

## Description

### User Story
As a planner I want to view all instances of an element in increasesing numerical order so that I can avoid confusion when reading data from niooo.

### Implemented feature / Problem Statement
Currently, instances from a mechanical element are alphabetically ordered in the Mechanical Tree Structure as seen below:
`!https://atc.asdgroup.net/confluence/download/attachments/7333611107/image-2026-2-6_14-54-31.png?version=1&modificationDate=1770386071484&api=v2!`

This makes elements #10 through #19 display above element #2 for example.
We want numbered repetitions of an article to be listed in their numerical order.

### Technical details
- This is frontend only
- This should be done in the mechanical-structure.mapper.ts

## Acceptance criteria

- When displaying the mechanical structure as a tree, repeating instances of elements in the same position are ordered numerically if there name strings match up until the "#" character.

## Boundaries and Out of scope

- The Jira ticket specifies no explicit out-of-scope section.
- Backend changes are out of scope (changes are strictly frontend only in `mechanical-structure.mapper.ts`).
