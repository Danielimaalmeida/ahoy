#!/usr/bin/env bash
# gates/plan.sh <STORY-ID>
#
# Run by Cartographer itself before it is allowed to emit
# `HUMAN_GATE: PLAN_ACCEPTED`. Fails the plan if the AC-to-test mapping
# required by knowledge/process/state-schema.md is missing or incomplete —
# a plan is prose plus this table, not prose alone.
#
# NOTE FOR delivery-phases.md: Captain should re-run this gate before writing
# `phase: plan_review`. Cartographer cannot fake an exit code, but it can skip
# running the script and report that it passed. Re-running costs two seconds
# and removes the trust assumption entirely.
#
# Added since the previous version: each criterion must carry a `source_quote`
# that appears verbatim in jira-source.md. Cartographer is told not to rewrite
# Jira, and nothing checked. A plain text-equality check would not work,
# because Cartographer is correctly allowed to SPLIT compound criteria — so
# neither half appears verbatim. `source_quote` keeps the ground truth
# (the Jira sentence) separate from the derived criterion (`text`), which
# permits splitting while still anchoring every criterion to the ticket.
#
# This requires adding `source_quote` to the acceptance_criteria schema in
# knowledge/process/state-schema.md and to Cartographer's instructions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 1 ]; then
  echo "usage: gates/plan.sh <STORY-ID>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
gate_require_jq
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?
REPO_ROOT="$(gate_repo_root)" || exit $?

plan_path=$(jq -r '.plan_path // empty' "$STATE_PATH")
if [ -z "$plan_path" ]; then
  gate_fail "state.json has no plan_path set"
fi
if [ ! -f "${REPO_ROOT}/${plan_path}" ]; then
  gate_fail "plan_path ${plan_path} does not exist"
fi

ac_count=$(jq '.acceptance_criteria | length' "$STATE_PATH")
if [ "$ac_count" -eq 0 ]; then
  gate_fail "acceptance_criteria is empty; every Jira AC must be mapped"
fi

incomplete=$(jq '[.acceptance_criteria[] |
  select((.id // "" | length) == 0
      or (.text // "" | length) == 0
      or (.repo // "" | length) == 0
      or ((.test_ids // []) | length) == 0)] | length' "$STATE_PATH")
if [ "$incomplete" -ne 0 ]; then
  gate_fail "${incomplete} acceptance_criteria entries missing id, text, repo, or test_ids"
fi

dupe_ids=$(jq -r '[.acceptance_criteria[].id] | group_by(.) | map(select(length > 1)) | flatten | unique | join(", ")' "$STATE_PATH")
if [ -n "$dupe_ids" ]; then
  gate_fail "duplicate acceptance criterion ids: ${dupe_ids}. Ids are the join key used by every downstream gate and must be unique and stable"
fi

# --- every criterion must be traceable to the Jira snapshot
JIRA_SOURCE="${REPO_ROOT}/specs/${STORY_ID}/jira-source.md"
if [ ! -f "$JIRA_SOURCE" ]; then
  gate_fail "jira-source.md not found at ${JIRA_SOURCE}; intake must persist the snapshot before planning"
fi

# Normalise whitespace and case on both sides so formatting differences
# (wrapping, bullet markers, trailing spaces) do not cause false failures.
normalised_jira=$(tr '[:upper:]' '[:lower:]' < "$JIRA_SOURCE" | tr -s '[:space:]' ' ')

ungrounded=""
while IFS=$'\t' read -r ac_id quote; do
  [ -n "$ac_id" ] || continue
  if [ -z "$quote" ]; then
    ungrounded="${ungrounded}  ${ac_id}: no source_quote"$'\n'
    continue
  fi
  norm_quote=$(printf '%s' "$quote" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ')
  if ! printf '%s' "$normalised_jira" | grep -qF -- "$norm_quote"; then
    ungrounded="${ungrounded}  ${ac_id}: source_quote not found in jira-source.md"$'\n'
  fi
done < <(jq -r '.acceptance_criteria[] | [.id, (.source_quote // "")] | @tsv' "$STATE_PATH")

if [ -n "$ungrounded" ]; then
  gate_fail "criteria not traceable to the Jira snapshot (source_quote must be verbatim from jira-source.md):"$'\n'"${ungrounded}"
fi

# --- test ids must be distinguishable names, not prose
vague=$(jq -r '[.acceptance_criteria[] | . as $ac | (.test_ids // [])[]
  | select((. | ascii_downcase) as $t
           | ($t | length) < 8
             or ($t | test("^(unit|integration|e2e)? ?tests?$"))
             or ($t | test("^(tbd|n/a|covered)")))
  | "\($ac.id): \(.)"] | join("; ")' "$STATE_PATH")
if [ -n "$vague" ]; then
  gate_fail "test_ids must be concrete test names that a later gate can grep for, not descriptions: ${vague}"
fi

# --- work packages must be machine-readable, for the same reason criteria are
#
# The plan's prose says which specialist implements what, in what order, and
# which package opens the PR. Prose is not dispatchable: bin/dispatch.sh cannot
# read it, so the sequencing lived in whoever was reading the plan. These
# checks make the array the contract and the prose the explanation.

wp_count=$(jq '(.work_packages // []) | length' "$STATE_PATH")
if [ "$wp_count" -eq 0 ]; then
  gate_fail "work_packages[] is empty; the plan must name each work package, its repo, its specialist agent and its dependency order in state.json, not only in prose"
fi

wp_incomplete=$(jq -r '[(.work_packages // [])[] |
  select((.id // "" | length) == 0
      or (.repo // "" | length) == 0
      or (.agent // "" | length) == 0
      or (.open_pr | type) != "boolean")
  | (.id // "<no id>")] | join(", ")' "$STATE_PATH")
if [ -n "$wp_incomplete" ]; then
  gate_fail "work_packages missing id, repo, agent, or a boolean open_pr: ${wp_incomplete}"
fi

wp_dupes=$(jq -r '[(.work_packages // [])[].id] | group_by(.) | map(select(length > 1)) | flatten | unique | join(", ")' "$STATE_PATH")
if [ -n "$wp_dupes" ]; then
  gate_fail "duplicate work_package ids: ${wp_dupes}. dispatch.sh keys on these"
fi

# Exactly one open_pr per repo. Captain's profile states this in a paragraph
# and nothing checked it. Setting it on more than one package opens a pull
# request against incomplete work; setting it on none leaves gates/pr.sh
# waiting forever for a PR nobody was asked to open.
bad_open_pr=$(jq -r '
  [(.work_packages // []) | group_by(.repo)[] |
    {repo: .[0].repo, n: ([.[] | select(.open_pr == true)] | length)} |
    select(.n != 1) | "\(.repo) has \(.n)"] | join("; ")' "$STATE_PATH")
if [ -n "$bad_open_pr" ]; then
  gate_fail "each repo needs exactly one work package with open_pr: true (its last): ${bad_open_pr}"
fi

# depends_on must reference ids that exist, or dispatch order is undefined.
bad_deps=$(jq -r '
  ((.work_packages // []) | map(.id)) as $ids
  | [(.work_packages // [])[] | . as $w | (.depends_on // [])[]
     | select(. as $d | $ids | index($d) | not)
     | "\($w.id) -> \(.)"] | join(", ")' "$STATE_PATH")
if [ -n "$bad_deps" ]; then
  gate_fail "work_packages depend on ids that do not exist: ${bad_deps}"
fi

# A criterion whose repo has no work package is a criterion nobody implements.
uncovered=$(jq -r '
  ((.work_packages // []) | map(.repo) | unique) as $wp
  | [.acceptance_criteria[].repo] | unique
  | map(select(. as $r | $wp | index($r) | not)) | join(", ")' "$STATE_PATH")
if [ -n "$uncovered" ]; then
  gate_fail "acceptance criteria assigned to repo(s) with no work package: ${uncovered}"
fi

# ONE BRANCH PER REPOSITORY PER STORY.
#
# The contract says so in a paragraph and nothing checked it. A plan gave two
# packages in one repository the branches `feature/X` and `feature/X-a11y`.
# Both ran in the same worktree, so every commit landed on the first — but
# child_repos[].branch recorded whichever package finished last, and
# gates/child_ready.sh went looking for a pull request on a branch that did not
# exist. Everything was done and the gate correctly said no.
#
# Packages that name no branch are fine: they inherit the repository's.
split_branch=$(jq -r '
  [(.work_packages // []) | group_by(.repo)[] |
    {repo: .[0].repo,
     names: ([.[] | .branch // empty] | unique)} |
    select((.names | length) > 1) |
    .repo + " (" + (.names | join(" vs ")) + ")"] | join("; ")' "$STATE_PATH")
if [ -n "$split_branch" ]; then
  gate_fail "work packages in one repository name different branches: ${split_branch}. A repository's work for a story lands on ONE branch — Cartographer names it once per repository, and every package against that repository uses it verbatim"
fi

# The branch prefix is chosen from the Jira issue type, and gates/child_ready.sh
# rejects anything outside that set. Catching it here costs a re-plan; catching
# it there costs a full implementation run first.
bad_prefix=$(jq -r '
  [((.work_packages // []) | map(.branch // empty)) + [.branch // empty]
   | flatten | map(select(. != "")) | unique[]
   | select((. | test("^(feature|hotfix|chore|docs|release)/")) | not)] | join(", ")' "$STATE_PATH")
if [ -n "$bad_prefix" ]; then
  gate_fail "branch prefix must be one of feature|hotfix|chore|docs|release: ${bad_prefix}"
fi

repos=$(jq -r '[.acceptance_criteria[].repo] | unique | join(", ")' "$STATE_PATH")
gate_pass "plan_path exists, ${ac_count} acceptance criteria grounded in Jira with test_ids, ${wp_count} work package(s) across: ${repos}"