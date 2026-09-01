# Jira integration conventions

## Routing

| Setting | Value |
| --- | --- |
| Primary Jira project | Realtime 3D Applications (`R3DA`) |
| Team Name | `The Guardians` |
| Feature Team | `sporting` |
| Confluence space | `R3DA` |

## Intake

Jira MCP is authoritative for story and bugfix intake. Retrieve an exact issue with `key = "{story_id}"` in the primary `R3DA` project; do not use fuzzy searches or invent alternate keys.

Required story fields: summary, description, acceptance criteria, status, labels, components, links, and Jira timestamps.

## Source snapshot

Persist the retrieved source as a versioned Markdown snapshot at `specs/<STORY-ID>/jira-source.md`. Metadata must include the exact issue key, source `jira-mcp`, retrieval timestamp, and snapshot version. Do not include secrets, credentials, or tokens. Later agents must consume the snapshot rather than silently re-querying or substituting source facts.

## Change and refresh policy

Compare new retrievals with the stored snapshot using the issue fields and Jira timestamps. If Jira data changes, refresh `jira-source.md`, increment its version, and re-run the specification gate before implementation. Report retrieval failures and stale or incomplete data explicitly.

## Credential boundary

Jira authentication and tokens come only from the configured Jira MCP. Never store, request, or infer Jira credentials or a Jira base URL in this repository.
