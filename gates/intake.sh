#!/usr/bin/env bash
# gates/intake.sh <STORY-ID>
#
# Run by Captain before advancing intake -> planning.
#
# Previously this transition was checked "inline (no script)" against
# Navigator's own `completeness` field — the one remaining place where an agent
# declared its own success, which is the pattern the rest of this repository
# exists to prevent. A story that starts from an under-read ticket produces a
# confident plan, confident tests, and confident reviews of the wrong thing.
#
# So: the field is read, but the persisted snapshot is inspected independently.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 1 ]; then
  echo "usage: gates/intake.sh <STORY-ID>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
gate_require_jq
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?
REPO_ROOT="$(gate_repo_root)" || exit $?

SNAPSHOT="${REPO_ROOT}/specs/${STORY_ID}/jira-source.md"
if [ ! -f "$SNAPSHOT" ]; then
  gate_fail "jira-source.md not found at ${SNAPSHOT}; Captain must persist Navigator's snapshot before planning"
fi

# --- the reported assessment
completeness=$(jq -r '.navigator.completeness // .completeness // empty' "$STATE_PATH")
case "$completeness" in
  FULL) ;;
  PARTIAL|NOT_FOUND)
    gate_fail "Navigator reported completeness '${completeness}'; resolve the gap in Jira or answer the open questions before planning" ;;
  "")
    gate_fail "no Navigator completeness recorded in state.json" ;;
  *)
    gate_fail "invalid completeness '${completeness}' (FULL|PARTIAL|NOT_FOUND)" ;;
esac

# --- independent inspection of the artifact itself
if ! grep -qF "$STORY_ID" "$SNAPSHOT"; then
  gate_fail "snapshot does not mention ${STORY_ID}; it may belong to a different story"
fi

body_chars=$(tr -d '[:space:]' < "$SNAPSHOT" | wc -c)
if [ "$body_chars" -lt 200 ]; then
  gate_fail "snapshot is ${body_chars} characters of content; that is too thin to plan from regardless of the reported completeness"
fi

if ! grep -qiE '^#{1,3}[[:space:]]*(description|summary)' "$SNAPSHOT"; then
  gate_fail "snapshot has no Description or Summary section"
fi

if ! grep -qiE '^#{1,3}[[:space:]]*acceptance[[:space:]]+criteria' "$SNAPSHOT"; then
  gate_fail "snapshot has no 'Acceptance criteria' section; Cartographer cannot cite source_quote values that do not exist"
fi

# Count criterion-ish lines under the acceptance criteria heading: bullets,
# numbered items, or Gherkin-style lines.
ac_lines=$(awk '
  tolower($0) ~ /^#{1,3}[[:space:]]*acceptance[[:space:]]+criteria/ { inac=1; next }
  inac && /^#{1,3}[[:space:]]/ { inac=0 }
  inac && /^[[:space:]]*([-*+]|[0-9]+[.)]|[Gg]iven|[Ww]hen|[Tt]hen)[[:space:]]+/ { n++ }
  END { print n+0 }' "$SNAPSHOT")

if [ "$ac_lines" -lt 1 ]; then
  gate_fail "the Acceptance criteria section contains no discrete criteria (expected bullets, numbered items, or Given/When/Then lines)"
fi

if ! grep -qiE '^#{1,3}[[:space:]]*(boundaries|out of scope|scope)' "$SNAPSHOT"; then
  gate_fail "snapshot has no Boundaries / Out of scope section; state explicitly that the ticket defines none rather than omitting it"
fi

blocking=$(jq -r '[.navigator.open_questions[]? // empty | select(.blocking == true) | .question] | join(" | ")' "$STATE_PATH" 2>/dev/null || echo "")
if [ -n "$blocking" ]; then
  gate_fail "blocking open questions remain from intake: ${blocking}"
fi

gate_pass "snapshot present with description, ${ac_lines} acceptance criteria and stated boundaries; Navigator reported FULL"