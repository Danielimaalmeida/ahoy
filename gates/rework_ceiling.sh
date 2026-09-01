#!/usr/bin/env bash
# gates/rework_ceiling.sh <STORY-ID> <REPO>
#
# Run by Captain before allowing another implementation → pr_review → rework
# loop for a repository. Prevents infinite reviewer/implementer ping-pong.
#
# Two changes from the previous version:
#
#   1. THE GATE INCREMENTS. Previously the gate checked retry_count and Captain
#      incremented it afterwards. A Captain that forgets that write loops
#      forever, and the phase table calls this gate from two rows (the
#      pr_review fail path and the rework row), which risks double counting.
#      The participant that is guaranteed to run is the gate, so the gate owns
#      the counter. Call it EXACTLY ONCE per rework decision — from the
#      pr_review fail path only. Remove it from the rework row.
#
#   2. PER-REPO CEILING. The docs promised "default 3, overridable per repo"
#      but only ever read the story-level value.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 2 ]; then
  echo "usage: gates/rework_ceiling.sh <STORY-ID> <REPO>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
REPO="$2"
gate_require_jq
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?

entry=$(jq --arg r "$REPO" '.child_repos[] | select(.repo == $r)' "$STATE_PATH")
if [ -z "$entry" ]; then
  gate_fail "no child_repos entry for repo '${REPO}'"
fi

dupes=$(jq --arg r "$REPO" '[.child_repos[] | select(.repo == $r)] | length' "$STATE_PATH")
if [ "$dupes" -ne 1 ]; then
  gate_fail "found ${dupes} child_repos entries for repo '${REPO}'; the counter cannot be tracked reliably against duplicates"
fi

story_ceiling=$(jq -r '.rework_ceiling // 3' "$STATE_PATH")
ceiling=$(printf '%s' "$entry" | jq -r --arg d "$story_ceiling" '.rework_ceiling // ($d | tonumber)')
retry_count=$(printf '%s' "$entry" | jq -r '.retry_count // 0')

if [ "$retry_count" -ge "$ceiling" ]; then
  # Halt, not fail. `fail` means "not in the required state yet, poll again",
  # which is precisely the loop this ceiling exists to stop. Reaching the
  # ceiling is terminal until a human intervenes, so it is exit 4.
  gate_halt "repo '${REPO}' retry_count (${retry_count}) has reached rework_ceiling (${ceiling}); set phase to blocked and escalate to a human rather than looping again"
fi

next=$((retry_count + 1))
gate_state_update "$STATE_PATH" \
  '(.child_repos[] | select(.repo == $r) | .retry_count) = $n' \
  --arg r "$REPO" --argjson n "$next"

written=$(jq -r --arg r "$REPO" '.child_repos[] | select(.repo == $r) | .retry_count' "$STATE_PATH")
if [ "$written" != "$next" ]; then
  echo "gate error: retry_count write did not persist (expected ${next}, found ${written})" >&2
  exit 2
fi

gate_pass "repo '${REPO}' rework round ${next} of ${ceiling} allowed"