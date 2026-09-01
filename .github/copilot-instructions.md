# R3DA niooo Ahoy Workspace Instructions

This repository is the shared control plane for the software development team's agentic AI workflow. It contains reusable agents, generic skills, delivery process definitions, and curated repository knowledge. It must not contain application code.

## Operating rules

1. Start deliveries only for user stories and bug fixes with an existing Jira issue key.
2. Read the relevant files in `knowledge/` before routing or planning work.
3. Select implementation agents from the registered agent and repository mappings; do not guess at ownership.
4. Make application changes only in isolated sessions for the affected child repository.
5. Read and follow each affected child repository's local instructions, conventions, workflows, and relevant files before implementation.
6. Keep repository-specific implementation details in the owning repository; keep shared process and reusable guidance here.
7. Require independent verification against every acceptance criterion before reporting completion.
8. Preserve human approval gates for pull requests, releases, and final acceptance. Agents must not approve or merge their own work.
9. When requested behavior, scope, ownership, or source facts are uncertain, ask a focused clarifying question instead of making an assumption.
10. Do not commit secrets, credentials, generated application artifacts, or local working copies.

## Default entry point

Captain is the default entry point for implementation requests. When the user
asks to implement, fix, or deliver an existing Jira user story or bugfix, route
through the user-invocable Captain agent unless the user explicitly requests a
different agent or a non-delivery task. Captain enforces the existing
Jira-key and plan-approval flow.

## Jira intake rules

11. Use the configured Jira MCP and the conventions in `knowledge/integrations/jira.md` and `.github/skills/jira-intake/SKILL.md` for story and bugfix intake.
12. Validate an exact issue key in the primary project, persist the result at `specs/<STORY-ID>/jira-source.md`, and require later agents to consume that snapshot.
13. If Jira data changes, refresh the snapshot and re-run the Navigator readiness and implementation-planning gate before implementation.

## Expected delivery flow

1. Validate the existing Jira issue and persist its authoritative source snapshot.
2. Identify affected repositories, owners, dependencies, and required specialists.
3. Create one approved implementation plan and stop at its human approval gate.
4. Create one isolated child-repository session per affected repository after approval.
5. Implement and test changes in the child sessions until every invoked child-repo agent reports readiness per that repository's own handoff contract, with no unresolved gaps, assumptions, or blocking findings.
6. Once every invoked agent reports readiness, open a pull request in the child repository.
7. Gather evidence for each acceptance criterion and review the resulting pull requests.
