# Agent-to-repository mapping

**Version:** 3.3
**Reviewed:** 2026-08-26

## Purpose

Register which repository-local agents own implementation, testing, and review
work for each child repository, so Cartographer can route work packages
without guessing at ownership (operating rule 3).

This mapping is load-bearing. Cartographer assigns a specialist agent per work
package from the names below, and Captain dispatches to whatever name it finds
in the plan. A stale name means Captain dispatches to an agent that does not
exist — so refresh this whenever a child repository's `.github/agents/` changes,
and treat the live files as authoritative when they differ.

Each repository section must supply everything the
[child dispatch contract](/knowledge/process/child-dispatch-contract.md)
needs Captain to send: the plan alias, the GitHub slug, the default branch, the
agents with their phases, and the order they run in.

---

## `r3da_niooo_frontend`

| field | value |
|---|---|
| plan alias | `frontend` |
| slug | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_frontend` |
| default branch | `main` |
| branch prefix | `feature` \| `hotfix` \| `chore` \| `release` |

### Agents

| agent | source | phase | writes code | notes |
|---|---|---|---|---|
| `frontend-implementer` | `.github/agents/frontend-implementer.agent.md` | `coding` | yes | Primary Angular implementation worker for scoped frontend work packages (Angular, Density, Figma). Owns first-pass tests for what it implements, including the Playwright E2E. |
| `angular-test-engineer` | `.github/agents/angular-test-engineer.agent.md` | `test-hardening` | yes (tests only) | Closes coverage gaps identified by review, CI, or verification. Not the agent that writes the implementer's first-pass tests. |
| `a11y-reviewer` | `.github/agents/a11y-reviewer.agent.md` | `accessibility-verification` | **no** | Reports WCAG 2.1/2.2 findings. Review-only, no edit tool. Never assign a work package that requires code changes. |

### Work package sequence

Cartographer orders frontend work packages as:

1. `frontend-implementer` — implementation plus first-pass tests
2. `angular-test-engineer` — only when a coverage gap is identified; skip it
   when the implementer's tests cover the assigned criteria
3. `a11y-reviewer` — whenever the work package changes user-facing UI

`open_pr: true` goes to the **last** work package in the sequence for this
repository. Note that `a11y-reviewer` cannot open a pull request — it has no
edit or push capability — so when it is last, assign `open_pr: true` to the
preceding agent and dispatch the accessibility review afterwards, before
running `gates/child_ready.sh`.

### Repository-specific evidence

Returns `density_evidence`, `figma_evidence` and `e2e_evidence` in addition to
the contract's required fields. Captain records these into
`child_repos[].evidence` verbatim without interpreting them.

### Accessibility ownership

This repository owns accessibility review for the delivery, pre-PR, where a
running app and browser inspection are available. `lookout-defect` therefore does
**not** cover accessibility — two reviewers on one concern produce contradictory
findings, which strands the fixer.

---

## `r3da_cdm_backend`

| field | value |
|---|---|
| plan alias | `backend` |
| slug | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_backend` |
| default branch | `main` |
| branch prefix | `feature` \| `hotfix` \| `release` |

### Agents

| agent | source | phase | writes code | notes |
|---|---|---|---|---|
| `backend-implementer` | `.github/agents/backend-implementer.agent.md` | `implementation` | yes | Quarkus/Java implementation by layer (domain -> persistence -> service -> resource -> tests). Owns first-pass unit + `@QuarkusTest`/REST Assured tests for what it implements. Flags graph-performance evidence when AGE repository/query code changes. |
| `backend-test-engineer` | `.github/agents/backend-test-engineer.agent.md` | `testing` | yes (tests only) | Always dispatched after the implementer (not conditional on a coverage gap, unlike frontend). Adds/updates unit tests and mandatory `*IT.java` endpoint tests. |
| `security-remediation` | `.github/agents/security-remediation.agent.md` | `security-remediation` | yes (fixes only) | Only in scope when a CVE/vulnerability finding exists. Follows Assess -> Analyze -> Act; requires graph-performance evidence if the fix touches AGE code. |

All three agents take the dispatch contract from this repository's
`.github/skills/delivery-handoff/SKILL.md`, which restates
[the child dispatch contract](/knowledge/process/child-dispatch-contract.md)
locally so the three cannot drift apart from each other. Ahoy remains
authoritative where the two disagree.

These three are the **complete** agent set for this repository — every agent
present is dispatched by Captain, and there are no repo-local agents outside
this table. A repo-local `code-review` agent used to exist here; it was deleted
during the Ahoy alignment because its checklist (architecture, code quality,
DB/migrations, security, testing, Jira/PR standards) was a pure diff/text review
with no capability the Ahoy lookouts lack. Unlike `a11y-reviewer` in the
frontend repo, it needed no running app or browser: `lookout-design` already
covers convention, boundaries and craft, and `lookout-defect` already covers
security and error paths. Do not reintroduce it — a second reviewer on the same
diff is duplicated surface that drifts.

### Work package sequence

1. `backend-implementer` — implementation plus first-pass tests
2. `backend-test-engineer` — unit + mandatory `*IT.java` endpoint test hardening
3. `security-remediation` — only when a CVE/vulnerability is in scope

Review is handled entirely by `lookout-defect` and `lookout-design` after
the pull request is open — not by a repo-local agent.

`open_pr: true` goes to the **last** work package in the sequence:
`backend-test-engineer` normally, or `security-remediation` when it is in
scope and last.

### Repository-specific evidence

Returns `graph_performance_evidence` in addition to the contract's required
fields whenever AGE graph repositories, `QueryBuilder`, `CypherFunctionCaller`,
or `GraphInsertDataGenerator` are touched; otherwise `N/A`. Captain records
this into `child_repos[].evidence` verbatim without interpreting it.

---

## `r3da_niooo_fv_poi_manager_job`

| field | value |
|---|---|
| plan alias | `poi-manager-job` |
| slug | `zxc-github.azure.cloud.asd/qwerty/r3da_niooo_fv_poi_manager_job` |
| default branch | `main` |
| branch prefix | `feature` \| `hotfix` \| `release` |

### Agents

Same agent *names* as `r3da_cdm_backend` (`backend-implementer`,
`backend-test-engineer`, `security-remediation`), adapted to this service's
Panache-based persistence — no AGE graph code in this repo, so
`graph_performance_evidence` does not apply here.

> **Not yet aligned to the child dispatch contract.** Unlike
> `r3da_cdm_backend`, this repository's agents still carry the older inline
> handoff contract: the `READY_FOR_VERIFICATION` \| `CONTINUE` \| `BLOCKED`
> status vocabulary, no `repo_slug`/`branch`/`head_sha`/`pr_url` return, no
> `open_pr` ownership, and no `delivery-handoff` skill. `gates/child_ready.sh`
> cannot verify a readiness claim from these agents. Treat this repository as
> **unmapped for Ahoy deliveries** until it receives the same migration, and
> stop as `BLOCKED` rather than dispatching into it.

| agent | source | phase | writes code | notes |
|---|---|---|---|---|
| `backend-implementer` | `.github/agents/backend-implementer.md` | `implementation` | yes | Quarkus/Java implementation by layer. Owns first-pass unit + `@QuarkusTest`/REST Assured tests. |
| `backend-test-engineer` | `.github/agents/backend-test-engineer.md` | `testing` | yes (tests only) | Always dispatched after the implementer. Adds/updates unit tests and mandatory `*IT.java` endpoint tests. |
| `security-remediation` | `.github/agents/security-remediation.md` | `security-remediation` | yes (fixes only) | Only in scope when a CVE/vulnerability finding exists. |

Repo-local `user-story-orchestrator` and `start-story` agents coordinate this
sequence when a human works directly in the repository. Captain does not
dispatch to them — Captain and Cartographer own planning and phase ordering per
the child dispatch contract. This repo also has a local `code-review` agent,
likewise not dispatched by Captain: it duplicates
`lookout-defect`/`lookout-design` with no capability they lack — see the
`r3da_cdm_backend` section above for the full rationale.

### Work package sequence

1. `backend-implementer`
2. `backend-test-engineer`
3. `security-remediation` — only when in scope

Review is handled entirely by `lookout-defect` and `lookout-design` after
the pull request is open.

`open_pr: true` rules are identical to `r3da_cdm_backend`: assign to
`backend-test-engineer` normally, or to `security-remediation` when it is in
scope and last.

---

## `r3da_niooo_mcp_server`

| field | value |
|---|---|
| plan alias | `mcp-server` |
| slug | `zxc-github.azure.cloud.asd/qwerty/r3da_niooo_mcp_server` |
| default branch | `main` |
| branch prefix | `feature` \| `hotfix` \| `release` |

### Agents

| agent | source | phase | writes code | notes |
|---|---|---|---|---|
| `mcp-tool-developer` | `.github/agents/mcp-tool-developer.md` | `implementation` | yes | Implements/refactors `@Tool`-annotated MCP methods and REST client interfaces that proxy the niooo API. Owns unit tests (JUnit 5 + Mockito) and JaCoCo coverage (80% line + branch) as part of the same pass — this repo has **no separate test-engineer agent**. |
| `security-remediation` | `.github/agents/security-remediation.md` | `security-remediation` | yes (fixes only) | Only in scope when a WIZ/AAA finding exists (dependency CVE, container image CVE, IaC misconfiguration, or code-level issue). Follows Triage -> Research -> Apply -> Verify -> Document. |

There is **no repository-local `code-review` agent** for this repository.
Cartographer must rely on Ahoy's own `lookout-defect`/`lookout-design`
reviewers for the review phase of deliveries here; do not invent a
repo-local reviewer.

### Work package sequence

1. `mcp-tool-developer` — implementation plus tests, in one pass
2. `security-remediation` — only when in scope

`open_pr: true` goes to the last work package in the sequence:
`mcp-tool-developer` normally, or `security-remediation` when it is invoked
and is last.

---

## `r3da_cdm_ops`

`r3da_cdm_ops` is the GitOps repository: Helm charts for all three
environments (TEST, INT, PROD), reconciled by the cluster's ArgoCD, plus the
cert-operator configuration that issues certificates and the External Secrets
configuration that pulls Terraform-provisioned secrets out of the key vault.
There is no application runtime to unit-test here — "testing" means proving
the rendered manifests are well-formed and that the intended value actually
changed, not exercising business logic. Most work is narrow and repetitive:
image tag bumps, ConfigMap env-var changes, ingress rule changes; less often a
chart is modified or a new one configured.

#### Two working lines — only one is Ahoy's

| line | environment | how work lands | Ahoy delivery? |
|---|---|---|---|
| `develop` | TEST | committed and pushed directly; no pull request | **no** |
| `main` | INT, PROD | pull request opened directly against `main` | **yes** |

This split is the single most important fact about routing into this
repository, and it is not a style preference — it is a hard capability
boundary: `gates/child_ready.sh` will not pass a repository without an open
pull request with at least one green status check, and `gates/pr.sh`
re-verifies the same. TEST-only work pushed straight to `develop` cannot reach
`ready` or `pr_review` and cannot be evidenced. **Ahoy deliveries into
`r3da_cdm_ops` are scoped to the `main` line — INT and PROD.** TEST/`develop`
work stays with the interactive `ops-assistant` agent, outside the delivery
flow. Cartographer must not plan a TEST-only work package into an Ahoy
delivery; if a story's ops change is TEST-only, say so and stop rather than
routing it here.

| field | value |
|---|---|
| plan alias | `ops` |
| slug | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_ops` |
| base branch for deliveries | `main` — never `develop`, per the boundary above |
| branch prefix | `gitops/<ticket_id>-<short-desc>` (no enforced convention pre-existed on `main`; this is the convention the two agents below use) |

#### Agents

| agent | source | phase | writes code | notes |
|---|---|---|---|---|
| `gitops-implementer` | `.github/agents/gitops-implementer.md` | `implementation` | yes | The workhorse. Image tag bumps in `values-<env>.yaml`, ConfigMap env-var changes, ingress rule changes, chart template edits, new-chart onboarding, and cert-operator / External Secrets manifest changes. Verifies which `values-<env>.yaml` files actually exist for the touched chart before assuming coverage — it is **not uniform** across charts (e.g. `niooo-mcp-server` has only `values-test.yaml`; `niooo-postgres-exporter` has no `values-test.yaml`; `niooo-alerts` has no `values-int.yaml`). Runs `helm lint` / `helm template` per affected environment plus the manual security/limits/probes checklist in `.github/instructions/helm-charts.instructions.md`, and captures an ArgoCD diff when cluster access is available. |
| `gitops-manifest-validator` | `.github/agents/gitops-manifest-validator.md` | `validation-hardening` | yes (validation only) | Conditional, not mandatory — dispatched only when a specific named gap exists: an unrendered environment overlay, a missed policy/checklist item, or a missing ArgoCD diff. Does not touch chart or values files; a values change discovered while closing a gap routes back to `gitops-implementer` via `remaining_gaps`. |
| `security-remediation` | not yet present in this repository | `security-remediation` | yes (fixes only) | Not yet built. Would only be in scope for a CVE or misconfiguration finding (image CVE, Helm/IaC misconfiguration, an External Secrets/cert-operator exposure), mirroring `r3da_cdm_backend` and `r3da_niooo_mcp_server`. Until it exists, route any such finding to `gitops-implementer` as a normal work package or stop `BLOCKED` and say so. |

Both `gitops-implementer` and `gitops-manifest-validator` take the dispatch
contract from this repository's `.github/skills/delivery-handoff/SKILL.md`,
which restates
[the child dispatch contract](/knowledge/process/child-dispatch-contract.md)
locally so the two cannot drift apart. Ahoy remains authoritative where the
two disagree.

No repo-local reviewer exists here, consistent with every other mapped
repository. `lookout-defect` covers security and failure modes — missing
resource limits, overly broad RBAC, unpinned or floating image tags, a secret
referenced but never provisioned, an ingress opened wider than intended.
`lookout-design` covers chart and manifest structure, naming, and consistency
across the three environment value sets.

`ops-assistant` (`.github/agents/ops-assistant.md`) is left unchanged and not
dispatched by Captain — it is the correct tool for interactive TEST/`develop`
work, which Ahoy does not govern.

**A known CI gap to compensate for:** the only pull-request-triggered
workflow in this repository (`on-pull-request-opened.yml`) posts a Teams
notification and produces a passing status check, but runs no helm lint,
template, or schema validation. That check being green satisfies
`gates/child_ready.sh` mechanically but proves nothing about the manifests —
all manifest validation must happen agent-side and be recorded as evidence,
never inferred from the PR's CI status.

#### Work package sequence

1. `gitops-implementer` — manifest/chart changes plus first-pass `helm lint` /
   `helm template` / checklist validation for each affected environment
2. `gitops-manifest-validator` — only when a specific validation gap is named
3. `security-remediation` — not yet built; only when a CVE or misconfiguration
   is in scope and the agent exists

`open_pr: true` goes to the last work package in the sequence, against `main`,
following the same rule as the other mapped repositories.

#### `test_ids` in a repository with no tests

This repository has no application test suite. `gates/child_ready.sh` still
requires at least one acceptance criterion with a `test_id`, and greps the
**added lines of the pull request diff** for each `test_id` as a literal
string — it does not run anything. So Cartographer assigns `test_ids` here as
the **literal asserted manifest value** the change must produce: the exact
image tag being deployed, the exact ConfigMap key introduced, the exact
ingress host/path added — not a test-file name. The assigned string must be
specific enough to be meaningful (`1.42.0` or
`ghcr.io/.../cdm-backend:1.42.0`, not `tag`). A child that disagrees with an
assigned string reports it in `remaining_gaps` and uses it anyway — the
literal is binding exactly as the
[child dispatch contract](/knowledge/process/child-dispatch-contract.md)
states.

#### Repository-specific evidence

Modeled on `graph_performance_evidence` in `r3da_cdm_backend`:

| field | contents |
|---|---|
| `manifest_validation_evidence` | the `helm lint` / `helm template` / checklist commands actually run, and their results, per affected environment |
| `argocd_diff_evidence` | a rendered ArgoCD diff or dry-run against the target `Application`, or `N/A — no cluster access in session` when unavailable |
| `environments_touched` | which of TEST / INT / PROD this change actually affects, verified against which `values-<env>.yaml` files exist for the touched chart — never assumed |

Captain records all three into `child_repos[].evidence` verbatim without
interpreting them. Where cluster access is genuinely unavailable, the correct
status is `unverified`, not `ready` — this repository is the most likely place
in the estate for that status to be earned honestly, since ArgoCD access from
a delivery session is not guaranteed.

---

## Repositories not yet mapped

These repositories exist in `knowledge/system/repository-inventory.md` but do
not have a phase-based agent (implementer / test-engineer / reviewer) that
conforms to the [child dispatch contract](/knowledge/process/child-dispatch-contract.md).
Cartographer must stop as `BLOCKED` naming the missing mapping rather than
inventing an agent name or dispatching to a non-conforming agent, unless the
user explicitly asks to work in the repository outside the Ahoy delivery flow.

| repository | slug | what exists today | why it is not mapped |
|---|---|---|---|
| `r3da_cdm_terraform` | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_terraform` | No `.github/agents/` directory | No implementation, test, or review agent defined at all. |
| `r3da_cdm_import_data` | `zxc-github.azure.cloud.asd/qwerty/r3da_cdm_import_data` | `.github/copilot-instructions.md` only (Jira conventions) | No implementation, test, or review agent defined. |
| `r3da_the_guardians_workflows` | `zxc-github.azure.cloud.asd/qwerty/r3da_the_guardians_workflows` | `.github/copilot-instructions.md` only (Jira conventions); this repo hosts reusable CI/CD workflow templates consumed by the other repositories | No implementation, test, or review agent defined. |
| `r3da_niooo_facilities_import` | `zxc-github.azure.cloud.asd/qwerty/r3da_niooo_facilities_import` | No `.github/` directory at all — a small standalone Node.js facilities-import script | No implementation, test, or review agent defined. |

Add a section per repository above, following the same shape as the mapped
repositories, once each gets a conforming agent set — following the same
shape: plan alias, slug, default branch, agents with phases and whether they
write code, work package sequence, and who may open the pull request.