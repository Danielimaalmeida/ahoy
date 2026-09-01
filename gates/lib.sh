#!/usr/bin/env bash
# Shared helpers for gates/*.sh. Not a gate itself — source it, don't run it.
#
# Exit code convention used by every gate script in this directory:
#   0 = pass
#   1 = validation failure (the thing being checked is not in the required
#       state; message printed to stderr)
#   2 = usage or environment error (missing argument, missing dependency,
#       missing state file, unexpected tooling failure)
#   3 = branch (nothing is broken; the delivery must take a different route,
#       e.g. review found real work to do -> rework)
#   4 = halt (nothing is wrong and nothing is finished; a human must decide,
#       and retrying changes nothing)
#
# 3 and 4 exist so the exit code alone is a routing decision. Previously
# `consensus.sh` used exit 2 for "route to rework", which is the same code a
# missing `jq` produces. A caller reading stderr can tell those apart; a caller
# reading only the exit code cannot, and would send a story into rework because
# `gh` was unauthenticated.
#
# `set -E` plus the ERR trap below exist to protect that contract. Without
# them, any incidental non-zero command (a bare `grep -q` miss, jq choking on
# unexpected input) aborts the script with status 1, which Captain reads as
# "the delivery is not in the required state" when the truth is "the tooling
# broke." Exit 1 must only ever come from an explicit gate_fail.

set -Eeuo pipefail


# ---------------------------------------------------------------------------
# Which `gh` the gates use.
#
# Pin this when the ambient `gh` is not the one you want. Two cases have
# actually bitten us:
#
#   - The Copilot desktop app ships its own `gh` and puts it first on PATH. It
#     cannot see your credentials, so every gate fails on authentication.
#   - Output filters such as RTK rewrite `gh` calls through a wrapper that
#     reformats the result. A reformatted `gh pr diff` still contains the diff
#     but indents it, so `grep '^+'` matches nothing and this gate reports
#     planned tests as missing on a pull request that contains them.
#
# Both are silent. Pinning the binary removes the ambient dependency:
#   export HARNESS_GH_BIN=/opt/homebrew/bin/gh
# ---------------------------------------------------------------------------
GH_BIN="${HARNESS_GH_BIN:-gh}"

gate__on_err() {
  local code="$1" line="$2" cmd="$3"
  echo "gate error: unexpected command failure (exit ${code}) at line ${line}: ${cmd}" >&2
  echo "gate error: this is an environment/tooling problem, not a failed delivery condition" >&2
  gate_record "error" "unexpected command failure (exit ${code}) at line ${line}: ${cmd}"
  exit 2
}

# Call once near the top of every gate, after sourcing this file.
gate_strict() {
  trap 'gate__on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR
}

# Diagnostic output that is not a verdict. consensus.sh already called this;
# lib.sh never defined it, so `info` fell through to the shell, returned 127,
# and the ERR trap converted every branch and halt path in that gate into
# exit 2. Both were unreachable in practice.
info() { echo "$*" >&2; }

gate_require_cmd() {
  local cmd="$1" why="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "gate error: ${cmd} is required but not installed${why:+ (${why})}" >&2
    exit 2
  fi
}

gate_require_jq() { gate_require_cmd jq; }

# A missing tool is an environment error, never a reason to skip a check and
# pass. A gate that degrades to "we could not verify, so fine" is not a gate.
gate_require_gh() {
  gate_require_cmd "$GH_BIN" "gates must verify pull requests against GitHub, not against fields an agent wrote"

  # Scoped to one host on purpose. `gh auth status` with no --hostname reports
  # across every configured host and returns non-zero if ANY of them fails, so a
  # stale credential for a host you never use fails the check while the host you
  # actually need is fine.
  local host="${HARNESS_GH_HOST:-zxc-github.azure.cloud.asd}"
  if [ -n "$host" ]; then
    if ! "$GH_BIN" auth status --hostname "$host" >/dev/null 2>&1; then
      echo "gate error: ${GH_BIN} is not authenticated for ${host} (run: gh auth login --hostname ${host})" >&2
      exit 2
    fi
  elif ! "$GH_BIN" auth status >/dev/null 2>&1; then
    echo "gate error: ${GH_BIN} is not authenticated (set HARNESS_GH_HOST to scope this check to one host)" >&2
    exit 2
  fi
}

gate_repo_root() {
  local root
  # `exit` inside a command substitution only kills that subshell, so capture
  # and propagate explicitly rather than exiting from a nested context.
  if ! root="$(git rev-parse --show-toplevel 2>/dev/null)" || [ -z "$root" ]; then
    echo "gate error: not inside a git repository" >&2
    return 2
  fi
  printf '%s' "$root"
}

gate_state_path() {
  local story_id="$1" root
  root="$(gate_repo_root)" || return 2
  printf '%s/specs/%s/state.json' "$root" "$story_id"
}

gate_require_state() {
  local story_id="$1" state_path
  state_path="$(gate_state_path "$story_id")" || return 2
  if [ ! -f "$state_path" ]; then
    echo "gate error: state file not found at ${state_path}" >&2
    return 2
  fi
  if ! jq empty "$state_path" >/dev/null 2>&1; then
    echo "gate error: state file at ${state_path} is not valid JSON" >&2
    return 2
  fi
  printf '%s' "$state_path"
}

# Atomic read-modify-write of state.json via a jq filter.
#
# Gates are read-only by default, with one deliberate exception: a counter that
# guards a loop must be incremented by the thing that checks it. If the gate
# checks and the caller increments, a caller that forgets to write loops
# forever — and the gate is the only participant guaranteed to run.
gate_state_update() {
  local state_path="$1" filter="$2"
  shift 2
  local tmp
  tmp="$(mktemp "${state_path}.XXXXXX")"
  if ! jq "$@" "$filter" "$state_path" > "$tmp"; then
    rm -f "$tmp"
    echo "gate error: failed to apply state update filter" >&2
    exit 2
  fi
  if ! jq empty "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "gate error: state update produced invalid JSON; original left untouched" >&2
    exit 2
  fi
  mv "$tmp" "$state_path"
}


# ---------------------------------------------------------------------------
# Self-recording
#
# Gates append their own result to state.json rather than relying on the caller
# to do it. The reason is specific: when the caller owns the record, a missing
# entry is ambiguous - the gate might not have run, or it ran and the caller
# forgot to write it. Asking the agent which happened gets you an answer, not
# evidence.
#
# With the gate writing its own entry, a missing entry means exactly one thing:
# the script never executed. `recorded_by: "gate"` distinguishes these from
# entries the caller wrote.
#
# Bookkeeping must never change a verdict. If the append fails, we warn and exit
# with the gate's own code anyway.
# ---------------------------------------------------------------------------

# Each gate sets this after parsing its arguments. gate_record no-ops without it.
GATE_STORY_ID="${GATE_STORY_ID:-}"

gate__now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

gate_record() {
  local result="$1" message="$2"
  [ -n "${GATE_STORY_ID:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local state_path tmp gate_name
  state_path="$(gate_state_path "$GATE_STORY_ID" 2>/dev/null)" || return 0
  [ -f "$state_path" ] || return 0
  local depth=$(( ${#BASH_SOURCE[@]} - 1 ))
  gate_name="$(basename "${BASH_SOURCE[$depth]:-unknown}")"

  tmp="$(mktemp "${state_path}.XXXXXX")" || return 0
  if jq --arg g "$gate_name" \
        --arg s "$GATE_STORY_ID" \
        --arg r "$result" \
        --arg m "$message" \
        --arg t "$(gate__now)" \
        '.gate_results = ((.gate_results // []) + [{
            gate: $g, story_id: $s, result: $r, message: $m,
            timestamp: $t, recorded_by: "gate"
         }])' "$state_path" > "$tmp" 2>/dev/null \
     && jq empty "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$state_path"
  else
    rm -f "$tmp"
    echo "warning: could not record gate result to ${state_path}" >&2
  fi
  return 0
}

gate_fail() {
  echo "gate fail: $1" >&2
  gate_record "fail" "$1"
  exit 1
}

# Exit 2 - the gate could not run. Recorded as `error`, never as a delivery
# condition, so a broken environment is distinguishable from failed work.
gate_error() {
  echo "gate error: $1" >&2
  gate_record "error" "$1"
  exit 2
}

# Exit 3 - the checked condition is well-formed but the delivery must take a
# different route (review found real work). Distinct from fail, because the
# caller should not stay in this phase and re-run the same gate.
gate_branch() {
  echo "gate branch: $1" >&2
  gate_record "branch" "$1"
  exit 3
}

# Exit 4 - nothing is wrong and nothing is finished: the gate is waiting on a
# human. Distinct from fail, because retrying changes nothing.
gate_halt() {
  echo "gate halt: $1" >&2
  gate_record "halt" "$1"
  exit 4
}

gate_pass() {
  echo "gate pass: $1"
  gate_record "pass" "$1"
  exit 0
}