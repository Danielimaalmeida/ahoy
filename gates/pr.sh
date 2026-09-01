#!/usr/bin/env bash
# gates/pr.sh <STORY-ID>
#
# Run by Captain before treating "all child repositories ready" as satisfied
# and moving to pr_review.
#
# Changed from the previous version: gh is now REQUIRED. Previously, when gh
# was absent the gate printed a warning and passed on the strength of pr_url
# being a non-empty string — so any string an agent wrote would ship. Per the
# exit-code contract in lib.sh, a missing dependency is exit 2 (fix the
# environment), exactly as jq is already handled. A gate that degrades to
# "could not verify, therefore fine" is worse than no gate, because it reads
# as evidence in the gate_results log.
#
# Also added: every repo named by an acceptance criterion must have a
# child_repos entry. Without this, a criterion assigned to a repo nobody
# implemented passes silently, because this gate only iterates child_repos.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 1 ]; then
  echo "usage: gates/pr.sh <STORY-ID>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
gate_require_jq
gate_require_gh
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?

repo_count=$(jq '.child_repos | length' "$STATE_PATH")
if [ "$repo_count" -eq 0 ]; then
  gate_fail "child_repos is empty; no affected repositories recorded"
fi

# --- every AC's repo must actually be in scope for implementation
orphans=$(jq -r '
  (.child_repos | map(.repo)) as $impl
  | [.acceptance_criteria[]? | .repo | select(. != null and . != "")]
  | unique
  | map(select(. as $r | $impl | index($r) | not))
  | join(", ")' "$STATE_PATH")
if [ -n "$orphans" ]; then
  gate_fail "acceptance criteria are assigned to repo(s) with no child_repos entry: ${orphans}. Those criteria would never be implemented and no later gate would notice"
fi

not_ready=$(jq '[.child_repos[] | select(.status != "ready")] | length' "$STATE_PATH")
if [ "$not_ready" -ne 0 ]; then
  gate_fail "${not_ready} of ${repo_count} child repositories are not yet 'ready'"
fi

missing_pr=$(jq '[.child_repos[] | select((.pr_url // "" | length) == 0)] | length' "$STATE_PATH")
if [ "$missing_pr" -ne 0 ]; then
  gate_fail "${missing_pr} ready repositories have no pr_url set"
fi

while IFS= read -r pr_url; do
  [ -n "$pr_url" ] || continue
  pr_json=$("$GH_BIN" pr view "$pr_url" --json state,isDraft,body,headRefOid 2>/dev/null || true)
  if [ -z "$pr_json" ]; then
    echo "gate error: could not read ${pr_url} from GitHub" >&2
    exit 2
  fi

  pr_state=$(printf '%s' "$pr_json" | jq -r '.state')
  if [ "$pr_state" != "OPEN" ]; then
    gate_fail "pull request ${pr_url} is not OPEN (state: ${pr_state})"
  fi

  if [ "$(printf '%s' "$pr_json" | jq -r '.isDraft')" = "true" ]; then
    gate_fail "pull request ${pr_url} is still a draft; a draft is not a readiness claim"
  fi

  pr_body=$(printf '%s' "$pr_json" | jq -r '.body // ""')
  if ! printf '%s' "$pr_body" | grep -qF "$STORY_ID"; then
    gate_fail "pull request ${pr_url} body does not reference ${STORY_ID}"
  fi
done < <(jq -r '.child_repos[].pr_url' "$STATE_PATH")

gate_pass "all ${repo_count} child repositories ready with open pull requests linked to ${STORY_ID}"