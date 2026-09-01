#!/usr/bin/env bash
# tests/run.sh — the harness test suite, offline.
#
# Requires: node, bash, jq, git. Does NOT require gh, credentials, network, or a
# model. `gh` is stubbed at the seam gates/lib.sh already had (HARNESS_GH_BIN),
# which is what lets the exit-code contract be tested instead of asserted in a
# README.
#
# Why this is the test that matters: the exit code is the routing decision
# (bin/tick.js switches on it and nothing else). Until this suite existed, the
# contract in gates/README.md was a claim about the scripts rather than a
# property of them — and two of the codes it described were unreachable.
# `consensus.sh` called a function that did not exist, so every branch and halt
# route in it was dead. `rework_ceiling.sh` returned "poll again" on reaching the
# ceiling, which is precisely the loop a ceiling exists to stop.
# `child_ready.sh` misread GitHub's check API and would have blocked a green
# pull request indefinitely.
#
# The cases live in tests/cases/*.test.js and run under node:test. The gates
# they exercise are still bash and are still run as bash: the exit-code contract
# does not care what language calls it, and a test that ran a JavaScript
# imitation of a gate would be testing the imitation.
#
# This file stays a .sh because README.md, docs/setup.md and everyone's habits
# name it. Run one file directly while iterating:
#
#     node --test tests/cases/tick.test.js
#
# tests/check-phase-table.sh is separate and still bash: it compares the prose
# phase table against the TSV, and touches no harness code.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "tests: node is required (the harness is Node; the gates are bash)" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "tests: jq is required by every gate under gates/" >&2; exit 2; }
command -v git  >/dev/null 2>&1 || { echo "tests: git is required; each case runs in a throwaway repo" >&2; exit 2; }

exec node --test --test-reporter=spec "${DIR}/cases/"*.test.js
