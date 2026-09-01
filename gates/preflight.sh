#!/usr/bin/env bash
# gates/preflight.sh
#
# Run by Captain as the first action of its first invocation in a session.
#
# This exists because of one specific failure mode: unrecognized tool names in
# an agent profile are silently ignored rather than raising an error. An agent
# whose shell tool did not resolve loads normally, routes phases confidently,
# and never runs a single gate — turning every "gate passed" in gate_results
# into the agent's own opinion, with no outward sign anything is wrong.
#
# The check is trivial. The point is that Captain cannot produce this output
# without a working shell, so its presence is proof rather than a claim.
#
# Exit codes follow the usual contract, except that everything here is an
# environment concern, so failures are 2.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

TOKEN="HARNESS-PREFLIGHT-$(date -u +%Y%m%dT%H%M%SZ)-$$"
missing=0

echo "preflight token: ${TOKEN}"
echo "gates dir:       ${SCRIPT_DIR}"

for tool in jq git "$GH_BIN"; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  ok      %-4s %s\n' "$tool" "$(command -v "$tool")"
  else
    printf '  MISSING %-4s\n' "$tool"
    missing=$((missing + 1))
  fi
done

if command -v "$GH_BIN" >/dev/null 2>&1; then
  gh_host="${HARNESS_GH_HOST:-zxc-github.azure.cloud.asd}"
  if [ -n "$gh_host" ]; then
    if "$GH_BIN" auth status --hostname "$gh_host" >/dev/null 2>&1; then
      echo "  ok      gh authenticated for ${gh_host}"
    else
      echo "  MISSING gh authentication for ${gh_host}"
      missing=$((missing + 1))
    fi
  elif "$GH_BIN" auth status >/dev/null 2>&1; then
    echo "  ok      gh authenticated (all hosts; set HARNESS_GH_HOST to scope)"
  else
    echo "  MISSING gh authentication for at least one configured host"
    missing=$((missing + 1))
  fi
fi

if root="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$root" ]; then
  echo "  ok      repo root ${root}"
  if [ -d "${root}/specs" ] && [ -w "${root}/specs" ]; then
    echo "  ok      specs/ writable"
  elif [ ! -d "${root}/specs" ]; then
    echo "  note    specs/ does not exist yet (created on first delivery)"
  else
    echo "  MISSING specs/ is not writable"
    missing=$((missing + 1))
  fi
else
  echo "  MISSING not inside a git repository"
  missing=$((missing + 1))
fi

for g in lib.sh intake.sh plan.sh child_ready.sh pr.sh consensus.sh rework_ceiling.sh; do
  if [ -f "${SCRIPT_DIR}/${g}" ]; then
    if bash -n "${SCRIPT_DIR}/${g}" 2>/dev/null; then
      printf '  ok      gate %s\n' "$g"
    else
      printf '  BROKEN  gate %s has a syntax error\n' "$g"
      missing=$((missing + 1))
    fi
  else
    printf '  MISSING gate %s\n' "$g"
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo "preflight failed: ${missing} problem(s). The harness cannot enforce its gates." >&2
  echo "Report BLOCKED and do not route any phase." >&2
  exit 2
fi

echo "preflight ok: shell, tooling and gate scripts all reachable"
echo "quote the token above back to the user as proof this ran"
exit 0