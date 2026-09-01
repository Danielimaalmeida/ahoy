---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
license: MIT
metadata:
  authors:
    - Matt Pocock <team@aihero.dev>
  maintainers:
    - Dennis Schmidt <dennis.sb.schmidt@asd.de>
  version: "1.1.0"
  tags:
    - requirement
    - prd
    - refine
  source: https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me
---

## Steps

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.
Ask the questions one at a time.
If a question can be answered by exploring the codebase, explore the codebase instead.

## Inputs

- A plan, design, or proposal that the user wants to be grilled on (e.g., a jira story, task, technical design or any plan that requires refinement and shared understanding).

## Outputs

- A refined plan covering all aspects and dependencies to have a shared understanding of the design between the agent and the human user. This will act as the single source of truth for the PRD (Product Requirements Document) and will be used to drive the implementation.
