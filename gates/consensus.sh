#!/usr/bin/env bash
# gates/consensus.sh <STORY-ID>
#
# Run by Captain before trusting Lookout's self-declared CONSENSUS_READY.
#
# The previous version checked that both reports said they were ready. Every
# input was a field Captain had transcribed from an agent, which makes it a
# schema validator rather than a gate. This version adds three things the
# reviewing agents do not control:
#
#   1. FRESHNESS  - each review names the commit it read, and that commit must
#                   still be the PR head. A review of an older commit does not
#                   describe the code you are about to merge.
#   2. INDEPENDENCE - the two reviews must come from different models with
#                   different lenses. Two runs of the same model with the same
#                   lens is one review recorded twice, and the whole value of
#                   the two-Lookout design is that they fail differently.
#   3. COVERAGE   - every acceptance criterion from plan.sh must carry an
#                   explicit verdict from BOTH reviewers. This is what makes
#                   the AC ids a spine running from planning to delivery
#                   rather than a table nobody reads after approval.
#
# Requires per entry in lookout_reviews[]:
#   model, lens, consensus_status, unresolved_high_or_blocking_count,
#   diminishing_returns_agreed, reviewed_shas {repo: sha},
#   criteria_verdicts {AC-id: met|not_met|partially_met|untestable}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 1 ]; then
  echo "usage: gates/consensus.sh <STORY-ID>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
gate_require_jq
gate_require_gh
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?

review_count=$(jq '.lookout_reviews | length' "$STATE_PATH")
if [ "$review_count" -ne 2 ]; then
  gate_fail "expected 2 independent lookout_reviews entries, found ${review_count}. If this is a later rework round, Captain must REPLACE the previous round's reviews, not append to them"
fi

# ------------------------------------------------------------------ verdicts
# Order matters. "Nothing is wrong" and "nothing is finished" are different
# states and must not collapse into one another:
#
#   blocking findings / unmet criteria  -> BRANCH to rework. There is work to do.
#   major findings raised by BOTH        -> BRANCH to rework. Two lenses agreeing
#                                          is evidence rather than taste.
#   major raised by only ONE             -> HALT. The other lens saw the same
#                                          diff and did not raise it; that is a
#                                          disagreement, and it is the human's.
#   one reviewer wants another pass     -> HALT for a human. There is nothing to
#                                          fix, so routing to rework hands the
#                                          fixer an empty findings list and burns
#                                          a rework round on a judgement call.
#   malformed reports                   -> FAIL. Re-run the reviewers.
#
# An earlier version treated `diminishing_returns_agreed: false` as a hard
# failure. That sent a story with zero blocking findings into rework, which is
# how a clean delivery ends up in a fix-it loop with nothing to fix.

# A reviewer reporting BLOCKED is not reporting a defect. Per the Lookout
# profiles it means a consequential disagreement it cannot resolve, and the
# named next reviewer is a human. There is no Captain to mediate a
# reconciliation round, and the profiles argue against one anyway: a
# disagreement that survives a round is usually about standards, and more
# rounds only decide it in favour of the reviewer with more stamina.
#
# So BLOCKED halts to a human. Anything else short of CONSENSUS_READY is work
# to do, and routes to rework.
blocked=$(jq -r '[.lookout_reviews[] | select(.consensus_status == "BLOCKED") | (.model // "?")] | join(", ")' "$STATE_PATH")
if [ -n "$blocked" ]; then
  info "reviewer(s) reported BLOCKED: ${blocked}"
  gate_halt "reviewer(s) ${blocked} reported BLOCKED — an unresolved disagreement or a missing input, not a defect a fixer can act on. Read specs/${STORY_ID}/reviews/ and decide"
fi

not_ready=$(jq '[.lookout_reviews[] | select(.consensus_status != "CONSENSUS_READY")] | length' "$STATE_PATH")
if [ "$not_ready" -ne 0 ]; then
  info "${not_ready} of 2 reviews are not CONSENSUS_READY"
  gate_branch "${not_ready} of 2 reviews not CONSENSUS_READY (this is a correct outcome, not a gate failure)"
fi

unresolved=$(jq '[.lookout_reviews[] | select((.unresolved_high_or_blocking_count // 1) > 0)] | length' "$STATE_PATH")
if [ "$unresolved" -ne 0 ]; then
  info "${unresolved} of 2 reviews still have unresolved high/blocking findings"
  gate_branch "${unresolved} of 2 reviews have unresolved high/blocking findings"
fi

# ------------------------------------------------------------ major findings
#
# A `major` finding used to pass straight through to the human delivery gate.
# The gate read `unresolved_high_or_blocking_count`, so only `blocking` stopped
# anything — and a review saying the structure will cost the team later, on code
# that happens to satisfy every acceptance criterion, arrived as a line in a
# file nobody was required to open.
#
# The Lookouts' own calibration is that `major` means it will genuinely cost the
# team. That is a rework round, not a footnote.
#
# BOTH reviewers must have raised one. A single `major` from one lens is one
# competent reviewer's judgement, and the other lens looked at the same diff and
# did not raise it — that is the disagreement case, and it belongs to a human
# rather than to a fixer who would be told to change something a reviewer says
# is fine. `minor` and `nit` never route anywhere: the fixer has a ceiling, and
# a round spent on taste is a round unavailable for a defect.
majors_r1=$(jq '[.lookout_reviews[0].findings[]? | select((.severity // "") == "major")] | length' "$STATE_PATH")
majors_r2=$(jq '[.lookout_reviews[1].findings[]? | select((.severity // "") == "major")] | length' "$STATE_PATH")

if [ "$majors_r1" -gt 0 ] && [ "$majors_r2" -gt 0 ]; then
  detail=$(jq -r '[.lookout_reviews[] | (.model // "?") as $m | .findings[]?
    | select((.severity // "") == "major")
    | "  [" + $m + "] " + ((.evidence // .summary // "?") | tostring)] | join("\n")' "$STATE_PATH")
  info "both reviewers raised major findings"
  gate_branch "both reviewers raised major finding(s):"$'\n'"${detail}"$'\n'"Two independent lenses agreeing something is major is evidence, not taste — routing to rework"
fi

if [ "$majors_r1" -gt 0 ] || [ "$majors_r2" -gt 0 ]; then
  only=$(jq -r '[.lookout_reviews[] | select([.findings[]? | select((.severity // "") == "major")] | length > 0) | (.model // "?") + " (" + (.lens // "?") + ")"] | join(", ")' "$STATE_PATH")
  detail=$(jq -r '[.lookout_reviews[] | (.model // "?") as $m | .findings[]?
    | select((.severity // "") == "major")
    | "  [" + $m + "] " + ((.evidence // .summary // "?") | tostring)] | join("\n")' "$STATE_PATH")
  info "only ${only} raised a major finding"
  gate_halt "only ${only} raised a major finding:"$'\n'"${detail}"$'\n'"The other lens reviewed the same diff and did not raise it. One reviewer's judgement is not grounds to send a fixer after something the other says is fine — read specs/${STORY_ID}/reviews/ and decide"
fi

# -------------------------------------------------------------- independence
models=$(jq -r '[.lookout_reviews[] | .model // ""] | @tsv' "$STATE_PATH")
m1=$(printf '%s' "$models" | cut -f1)
m2=$(printf '%s' "$models" | cut -f2)
if [ -z "$m1" ] || [ -z "$m2" ]; then
  gate_fail "both lookout_reviews entries must record the 'model' that produced them"
fi
if [ "$m1" = "$m2" ]; then
  gate_fail "both reviews ran on the same model (${m1}); the two-Lookout design depends on models that fail differently"
fi

lenses=$(jq -r '[.lookout_reviews[] | .lens // ""] | @tsv' "$STATE_PATH")
l1=$(printf '%s' "$lenses" | cut -f1)
l2=$(printf '%s' "$lenses" | cut -f2)
if [ -z "$l1" ] || [ -z "$l2" ]; then
  gate_fail "both lookout_reviews entries must record the review 'lens' assigned to them"
fi
if [ "$l1" = "$l2" ]; then
  gate_fail "both reviews used the same lens (${l1}); assign distinct lenses"
fi

# ----------------------------------------------------------------- freshness
# The sha each reviewer read must still be the PR head. Fetched from GitHub,
# not from state, because state is written by the same process that records
# the reviews.
while IFS=$'\t' read -r repo pr_url; do
  [ -n "$repo" ] || continue
  if [ -z "$pr_url" ]; then
    gate_fail "child repo '${repo}' has no pr_url; run gates/pr.sh first"
  fi

  head_sha=$("$GH_BIN" pr view "$pr_url" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)
  if [ -z "$head_sha" ]; then
    echo "gate error: could not read head commit of ${pr_url}" >&2
    exit 2
  fi

  idx=0
  while [ "$idx" -lt 2 ]; do
    reviewed=$(jq -r --arg r "$repo" --argjson i "$idx" \
      '.lookout_reviews[$i].reviewed_shas[$r] // ""' "$STATE_PATH")
    model=$(jq -r --argjson i "$idx" '.lookout_reviews[$i].model // "?"' "$STATE_PATH")
    if [ -z "$reviewed" ]; then
      gate_fail "review by ${model} records no reviewed sha for repo '${repo}'"
    fi
    if [ "$reviewed" != "$head_sha" ]; then
      gate_fail "review by ${model} read ${reviewed} of '${repo}' but the PR head is now ${head_sha}; the code was pushed after review, so re-review is required"
    fi
    idx=$((idx + 1))
  done
done < <(jq -r '.child_repos[] | [.repo, (.pr_url // "")] | @tsv' "$STATE_PATH")

# ------------------------------------------------------ criterion coverage
AC_IDS=()
while IFS= read -r line; do
  [ -n "$line" ] && AC_IDS+=("$line")
done < <(jq -r '.acceptance_criteria[].id' "$STATE_PATH")
if [ "${#AC_IDS[@]}" -eq 0 ]; then
  gate_fail "no acceptance_criteria recorded; gates/plan.sh should have caught this earlier"
fi

missing=""
unmet=""
disputed=""
for ac in "${AC_IDS[@]}"; do
  idx=0
  seen=()
  while [ "$idx" -lt 2 ]; do
    model=$(jq -r --argjson i "$idx" '.lookout_reviews[$i].model // "?"' "$STATE_PATH")
    verdict=$(jq -r --arg ac "$ac" --argjson i "$idx" \
      '.lookout_reviews[$i].criteria_verdicts[$ac] // ""' "$STATE_PATH")
    case "$verdict" in
      "")
        missing="${missing}  ${ac}: no verdict from ${model}"$'\n' ;;
      met) ;;
      not_met|partially_met|untestable)
        unmet="${unmet}  ${ac}: '${verdict}' from ${model}"$'\n' ;;
      *)
        gate_fail "invalid verdict '${verdict}' for ${ac} from ${model} (met|not_met|partially_met|untestable)" ;;
    esac
    seen+=("${model}=${verdict}")
    idx=$((idx + 1))
  done
  # Two reviewers reaching DIFFERENT verdicts on the same criterion is a
  # disagreement, not a defect. One of them believes the criterion is covered.
  # Sending that to rework tells a fixer to fix something a competent reviewer
  # says is already correct, which is how a loop starts that nobody can end.
  # It goes to a human instead.
  v1="${seen[0]#*=}"; v2="${seen[1]#*=}"
  if [ -n "$v1" ] && [ -n "$v2" ] && [ "$v1" != "$v2" ]; then
    disputed="${disputed}  ${ac}: ${seen[0]} vs ${seen[1]}"$'\n'
  fi
done

if [ -n "$missing" ]; then
  gate_fail "acceptance criteria without a verdict from both reviewers:"$'\n'"${missing}"
fi
if [ -n "$disputed" ]; then
  info "the two reviewers disagree about coverage:"
  info "${disputed}"
  gate_halt "reviewers disagree on acceptance criteria:"$'\n'"${disputed}"$'\n'"One reviewer holds these are covered. Read both reports in specs/${STORY_ID}/reviews/ and decide, rather than sending a fixer after something a reviewer says is already correct"
fi
if [ -n "$unmet" ]; then
  info "acceptance criteria not verified as met:"
  info "${unmet}"
  gate_branch "acceptance criteria not met, this is work to do rather than a malformed review:"$'\n'"${unmet}"
fi

# ------------------------------------------------- reviewer wants another pass
# Reached only when nothing is blocking and every criterion is met by both
# reviewers. A reviewer declining to agree that remaining items have diminishing
# returns is not reporting a defect - it is asking for more review. That is a
# judgement call about how much scrutiny this change deserves, and it belongs to
# a human, not to a rework loop.
not_diminishing=$(jq -r '[.lookout_reviews[] | select(.diminishing_returns_agreed != true) | (.model // "?")] | join(", ")' "$STATE_PATH")
if [ -n "$not_diminishing" ]; then
  info "all criteria met and no blocking findings, but these reviewer(s) want another pass: ${not_diminishing}"
  info "this is not a defect and there is nothing for a fixer to do"
  gate_halt "review is clean but ${not_diminishing} has not agreed remaining items have diminishing returns. Decide whether to accept as-is or commission another review round; do not route to rework, there are no findings to fix"
fi

gate_pass "2 independent reviews (${m1} / ${l1}, ${m2} / ${l2}) at current PR head, all ${#AC_IDS[@]} acceptance criteria met by both, no unresolved high/blocking findings, both agree on diminishing returns"