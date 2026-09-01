---
name: jira-intake
description: Retrieve and snapshot the authoritative Jira source for a story or bugfix before implementation planning.
license: MIT
---

## Procedure

Use this skill when Captain or the Cartographer receives a story or bugfix key.

1. Accept a `STORY-ID` and query the configured Jira MCP with the exact filter `key = "{story_id}"` in the primary `R3DA` project. Do not use fuzzy searches or infer alternate issue keys.
2. Retrieve the exact issue's summary, description, acceptance criteria, status, labels, components, links, and Jira timestamps.
3. Write or refresh the versioned snapshot at `specs/<STORY-ID>/jira-source.md`. Include the issue key, source `jira-mcp`, retrieval timestamp, snapshot version, and the retrieved fields. Never include credentials, tokens, or other secrets.
4. If `specs/<STORY-ID>/state.json` does not exist yet, seed it from `knowledge/process/state.template.json` with `story_id` set and `phase: "intake"`, per `knowledge/process/state-schema.md`. If it already exists, only update `jira_url`; do not touch `phase` or any other field here — Captain owns phase transitions per `knowledge/process/delivery-phases.md`.
5. Report the source metadata and any retrieval failure explicitly. Do not present an incomplete or stale snapshot as authoritative.

Team routing metadata: Team Name `The Guardians`; Feature Team `sporting`.

Do not write application code, create child-repository sessions, or advance to implementation planning, implementation, or later lifecycle phases.
