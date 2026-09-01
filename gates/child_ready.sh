#!/usr/bin/env bash
# gates/child_ready.sh <STORY-ID> <REPO>
#
# Run by Captain before recording a child repository as ready in child_repos[].
#
# The child agent's self-reported status is an input, not evidence. This gate
# reads the state record for the *claim* and then verifies that claim against
# GitHub, which the child agent does not control:
#
#   1. the PR exists, is open, not a draft, and its head is the claimed commit
#   2. CI on that head is green, and there are actually checks configured
#      (both CheckRun and StatusContext nodes - see the normalisation below)
#   3. every planned test id for this repo appears in the PR's added lines
#   4. the PR adds no skipped or disabled tests
#
# Captain needs no local checkout - all evidence comes from `gh`.
#
# On a pass it records pr_number, pr_url and head_sha back into the entry, so
# gates/pr.sh can find the pull request this gate already resolved.
#
# Requires in child_repos[]: repo, status, slug (owner/name), branch (must
# match <feature|hotfix|chore|docs|release>/<STORY_ID>-<slug>, per
# child-dispatch-contract.md).
# Optional: head_sha (checked when present), pr_number (discovered when absent).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"
gate_strict

if [ $# -ne 2 ]; then
  echo "usage: gates/child_ready.sh <STORY-ID> <REPO>" >&2
  exit 2
fi

STORY_ID="$1"
GATE_STORY_ID="$STORY_ID"
REPO="$2"
gate_require_jq
gate_require_gh
STATE_PATH="$(gate_require_state "$STORY_ID")" || exit $?

entry=$(jq --arg r "$REPO" '.child_repos[] | select(.repo == $r)' "$STATE_PATH")
if [ -z "$entry" ]; then
  gate_fail "no child_repos entry for repo '${REPO}'"
fi

# ---------------------------------------------------------------- the claim
status=$(printf '%s' "$entry" | jq -r '.status // empty')
if [ "$status" != "ready" ]; then
  # Not an error: a repo still working is polled again, per the phase table.
  # in_progress, blocked and unverified all land here and all mean "not yet".
  gate_fail "repo '${REPO}' status is '${status:-<missing>}', not 'ready'"
fi

slug=$(printf '%s' "$entry" | jq -r '.slug // empty')
branch=$(printf '%s' "$entry" | jq -r '.branch // empty')
claimed_sha=$(printf '%s' "$entry" | jq -r '.head_sha // empty')
pr_number=$(printf '%s' "$entry" | jq -r '.pr_number // empty')
pr_url=$(printf '%s' "$entry" | jq -r '.pr_url // empty')

[ -n "$slug" ]   || gate_fail "child_repos entry for '${REPO}' has no 'slug' (owner/name); the gate cannot verify a repo it cannot address"
[ -n "$branch" ] || gate_fail "child_repos entry for '${REPO}' has no 'branch'"

# Branch naming convention: <prefix>/<TICKET-ID>-<slug>, per
# knowledge/process/child-dispatch-contract.md. <prefix> depends on the
# story's Jira issue type (feature/hotfix/chore/docs). A branch that doesn't
# match is evidence the child never renamed its worktree away from the
# session default.
if ! printf '%s' "$branch" | grep -qE "^(feature|hotfix|chore|docs|release)/${STORY_ID}-[a-z0-9-]+$"; then
  gate_fail "branch '${branch}' must be <feature|hotfix|chore|docs|release>/${STORY_ID}-<kebab-case-slug>"
fi

# slug and pr_url are written separately and can disagree. Catch that here as a
# precise config error rather than as a confusing "could not read PR" later.
if [ -n "$pr_url" ]; then
  case "$pr_url" in
    *"/${slug}/"*) ;;
    *) gate_fail "pr_url ${pr_url} does not belong to slug ${slug}; one of the two is wrong in child_repos[] or in knowledge/repositories/" ;;
  esac
fi

# ---------------------------------------------------------------- 1. the PR
# Every `gh` assignment whose failure is handled below needs `|| true`, or the
# ERR trap aborts before the handling runs.
if [ -z "$pr_number" ]; then
  pr_number=$("$GH_BIN" pr list --repo "$slug" --head "$branch" --state open \
                --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || true)
fi
if [ -z "$pr_number" ]; then
  gate_fail "repo '${REPO}' reports ready but no open PR exists for branch '${branch}' in ${slug}"
fi

pr=$("$GH_BIN" pr view "$pr_number" --repo "$slug" \
       --json state,isDraft,headRefOid,url,statusCheckRollup 2>/dev/null || true)
if [ -z "$pr" ]; then
  echo "could not read PR #${pr_number} in ${slug} (gh auth, wrong slug, or network)" >&2
  exit 2
fi

pr_state=$(printf '%s' "$pr" | jq -r '.state')
[ "$pr_state" = "OPEN" ] || gate_fail "PR #${pr_number} is ${pr_state}, not OPEN"

if [ "$(printf '%s' "$pr" | jq -r '.isDraft')" = "true" ]; then
  gate_fail "PR #${pr_number} is still a draft; a draft PR is not a readiness claim"
fi

head_sha=$(printf '%s' "$pr" | jq -r '.headRefOid')
if [ -n "$claimed_sha" ] && [ "$claimed_sha" != "$head_sha" ]; then
  # Print both in full. Abbreviating identifiers in a message about identifiers
  # not matching hides exactly the difference being reported.
  gate_fail "report claimed head ${claimed_sha} but PR head is ${head_sha}; the readiness report describes a different commit than the one under review"
fi

# ---------------------------------------------------------------- 2. CI green
checks=$(printf '%s' "$pr" | jq '[.statusCheckRollup[]? ]')
n_checks=$(printf '%s' "$checks" | jq 'length')

if [ "$n_checks" -eq 0 ]; then
  # Vacuous truth is the failure mode here: no checks means nothing verified
  # the build. Passing on an empty rollup would make this gate decorative.
  gate_fail "PR #${pr_number} has no status checks. Configure CI in ${slug} and make it a required check, or this gate cannot verify anything"
fi

# statusCheckRollup mixes TWO node types and they do not share a schema:
#
#   CheckRun       has .status (QUEUED|IN_PROGRESS|COMPLETED) and .conclusion
#   StatusContext  has NEITHER - it has .state (SUCCESS|PENDING|FAILURE|ERROR)
#
# A commit status posted by an external system (SonarQube, a linter bot, a
# legacy CI integration) is a StatusContext. Reading only .status makes every
# one of them look permanently unfinished, so a fully green pull request never
# advances and the gate blocks the delivery forever with no way to tell why.
#
# Normalise both into one shape before judging: `phase` is COMPLETED or not,
# `verdict` is the outcome.
norm=$(printf '%s' "$checks" | jq '[.[] |
  if has("state") and (.status == null) then
    { name: (.context // .name // "status"),
      phase: (if ((.state // "") | ascii_upcase) == "PENDING" then "PENDING" else "COMPLETED" end),
      verdict: ((.state // "") | ascii_upcase),
      detailsUrl: (.targetUrl // .detailsUrl // null) }
  else
    { name: (.name // .context // "check"),
      phase: ((.status // "") | ascii_upcase),
      verdict: ((.conclusion // "") | ascii_upcase),
      detailsUrl: (.detailsUrl // null) }
  end]')

pending=$(printf '%s' "$norm" | jq -r '
  [.[] | select(.phase != "COMPLETED")] | length')
if [ "$pending" -gt 0 ]; then
  names=$(printf '%s' "$norm" | jq -r '[.[] | select(.phase != "COMPLETED") | .name] | join(", ")')
  gate_fail "PR #${pr_number} has ${pending} check(s) still running (${names}); poll again rather than recording ready"
fi

# Include detailsUrl: this stderr is fed back to the agent on retry, and a
# check name alone ("SonarQube Quality Gate") says nothing about what to fix.
failed=$(printf '%s' "$norm" | jq -r '
  [.[] | select(.verdict | IN("SUCCESS","NEUTRAL","SKIPPED","EXPECTED") | not)
       | "  \(.name) -> \(.detailsUrl // "no details url")"]
  | join("\n")')
if [ -n "$failed" ]; then
  # BRANCH, not fail.
  #
  # A red check is not "not yet". Nothing outside will turn it green — the code
  # has to change — so exit 1 was wrong: with --wait the router polled a
  # permanently failing build until the wait budget ran out, printing the same
  # two check names every thirty seconds.
  #
  # Exit 3 routes back to implementation with the failing checks attached, which
  # is the same shape as a Lookout finding: evidence from outside the agent,
  # handed to the agent that can act on it. gates/rework_ceiling.sh bounds it,
  # so a build that cannot be fixed stops for a human instead of looping.
  gate_branch "PR #${pr_number} has failing check(s):"$'\n'"${failed}"$'\n'"CI is red and will not go green on its own; routing back to implementation"
fi

# ---------------------------------------------------- 3. planned tests exist
# This is what makes plan.sh's acceptance_criteria mapping mean something.
# Cartographer promised these test ids at planning time; the diff must contain
# them. A test name recorded in state and absent from the PR is the exact
# failure "the agent said it wrote tests" is meant to catch.
#
# No mapfile: it is bash 4+ and macOS ships bash 3.2.
planned=()
while IFS= read -r line; do
  [ -n "$line" ] && planned+=("$line")
done < <(jq -r --arg r "$REPO" '
  .acceptance_criteria[]? | select(.repo == $r) |
  . as $ac | (.test_ids // [])[] | "\($ac.id)\t\(.)"' "$STATE_PATH")

if [ "${#planned[@]}" -eq 0 ]; then
  gate_fail "no acceptance_criteria with test_ids are assigned to repo '${REPO}'; either the plan mapping is wrong or this repo should not be in child_repos[]"
fi

# `grep -E '^[[:space:]]*\+'` rather than `grep '^+'`: output filters such as
# RTK reformat a diff by indenting it, which leaves the +/- markers intact but
# no longer at column zero. A plain `^+` then matches nothing and this gate
# reports "planned tests missing" on a pull request that contains them. Pinning
# $GH_BIN should prevent that, but the tolerant pattern costs nothing and this
# failure is silent.
diff_added=$("$GH_BIN" pr diff "$pr_number" --repo "$slug" --patch 2>/dev/null \
             | grep -E '^[[:space:]]*\+' || true)
if [ -z "$diff_added" ]; then
  gate_fail "PR #${pr_number} has no added lines"
fi

TAB=$(printf '\t')
missing=""
for item in "${planned[@]}"; do
  ac_id=${item%%${TAB}*}
  test_id=${item#*${TAB}}
  [ -n "$test_id" ] || continue
  if ! printf '%s\n' "$diff_added" | grep -qF -- "$test_id"; then
    missing="${missing}  ${ac_id}: '${test_id}' not found in the PR diff"$'\n'
  fi
done

if [ -n "$missing" ]; then
  gate_fail "planned tests missing from PR #${pr_number}:"$'\n'"${missing}"
fi

# ------------------------------------------------- 4. no tests neutralised
skipped=$(printf '%s\n' "$diff_added" | grep -EI \
  '\b(it|test|describe)\.skip\b|@Ignore\b|@Disabled\b|xit\(|xdescribe\(|pytest\.mark\.skip|\.skip\(' \
  || true)
if [ -n "$skipped" ]; then
  gate_fail "PR #${pr_number} adds skipped or disabled tests:"$'\n'"$(printf '%s\n' "$skipped" | head -10)"
fi

# ------------------------------------------------- 5. record what was verified
# This gate DISCOVERS pr_number from the branch when it is absent, then throws
# the answer away — and gates/pr.sh subsequently fails with "ready repositories
# have no pr_url set", because nothing else knows the PR exists. The dispatcher
# cannot supply it: at dispatch time there is no pull request yet.
#
# So the participant that resolved the identifier records it. This is the same
# reasoning as rework_ceiling.sh owning its counter: the gate is the one
# guaranteed to run, and a value it verified against GitHub is better evidence
# than the same value written by an agent.
#
# Only the two identifiers are written, and only after every check above has
# passed. Status stays whatever the caller recorded — this gate judges
# readiness, it does not declare it.
pr_url_actual=$(printf '%s' "$pr" | jq -r '.url // empty')
if [ -n "$pr_url_actual" ]; then
  gate_state_update "$STATE_PATH" \
    '(.child_repos[] | select(.repo == $r)) += {pr_number: $n, pr_url: $u, head_sha: $s}' \
    --arg r "$REPO" --argjson n "$pr_number" --arg u "$pr_url_actual" --arg s "$head_sha"
fi

gate_pass "repo '${REPO}' ready: PR #${pr_number} open at ${head_sha}, ${n_checks} check(s) green, ${#planned[@]} planned test(s) present in the diff"