# R3DA Repository Inventory

**Version:** 1.3
**Reviewed:** 2026-08-26

## Purpose

Provide concise routing context for the active R3DA child repositories. This inventory does not replace repository-local guidance.

| Canonical remote | URL | Role | Default branch | Feature team | Ownership |
| --- | --- | --- | --- | --- | --- |
| `qwerty/r3da_niooo_frontend` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_frontend` | Frontend application | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_cdm_backend` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_backend` | Backend application | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_cdm_ops` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_ops` | GitOps deployment repository — Helm charts for TEST/INT/PROD, reconciled by the cluster's ArgoCD; also hosts cert-operator and External Secrets configuration | `main` (INT/PROD) · `develop` (TEST) [^ops] | `sporting` | `The Guardians` |
| `qwerty/r3da_cdm_terraform` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_terraform` | Infrastructure as code | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_niooo_mcp_server` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_niooo_mcp_server` | MCP integration server | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_cdm_import_data` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_cdm_import_data` | Data import | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_the_guardians_workflows` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_the_guardians_workflows` | Team workflow automation | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_niooo_fv_poi_manager_job` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_niooo_fv_poi_manager_job` | FV POI manager background job | `main` | `sporting` | `The Guardians` |
| `qwerty/r3da_niooo_facilities_import` | `https://zxc-github.azure.cloud.asd/qwerty/r3da_niooo_facilities_import` | Facilities data import script | `main` | `sporting` | `The Guardians` |

[^ops]: `r3da_cdm_ops` is the one repository here with two working lines. Day-to-day
TEST work is committed directly to `develop` with no pull request; INT and PROD
changes go via a pull request straight into `main`. Only the `main` line can carry
an Ahoy delivery, because `gates/child_ready.sh` and `gates/pr.sh` both require an
open pull request. See `knowledge/repositories/agent-mappings.md`.

## Planning context

Cartographer must inspect the live target repository's `.github/copilot-instructions.md`, `.github/instructions/`, applicable `.github/skills/`, workflows/CI, manifests, README, and relevant source. This inventory is routing context, not a copy of those files.
