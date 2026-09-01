# Jira Source Snapshot: R3DA-13674

- **Issue Key:** R3DA-13674
- **URL:** https://atc.asdgroup.net/jira/browse/R3DA-13674
- **Source:** jira-mcp
- **Retrieval Timestamp:** 2026-08-30T12:30:59.696+01:00
- **Snapshot Version:** 1.0
- **Summary:** [niooo] Adjust height of tree views in Combined view
- **Issue Type:** Story
- **Project:** Realtime 3D Applications (R3DA)
- **Status:** New
- **Components:** CDM
- **Labels:** None
- **Reporter:** Daniel Radetic (sporting)
- **Created:** 2026-08-10T16:21:19.280+0000
- **Updated:** 2026-08-30T11:18:12.061+0000

## Description

As a planner I want to be able to resize the electrical and mechanical tree heights in the combined-view, so I more space to compare the elements that I want.

Currently, the combined-view allows users to resize all tree sections (trees container, electrical structure and mechanical structure) horizontally. However, within the trees container, it's not possible to resize vertically. This features enables the vertical resizing of the two trees.

User feedback indicates the feature is desirable.
Make the height of the tree structure viewports configurable by drag and drop just like the width of other elements already are.

### Technical Notes
- This user story is frontend only
- We should have a minimum height

## Acceptance criteria

- Tree structure viewport has adjustable height in Combined view
- Make the height of the tree structure viewports configurable by drag and drop just like the width of other elements already are.

## Boundaries

- Frontend only: backend changes are out of scope.
- Configurable height of tree structure viewports must respect a minimum height constraint.
