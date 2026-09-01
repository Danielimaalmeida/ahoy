#!/usr/bin/env bash
# tests/check-phase-table.sh
#
# delivery-phases.md and phases.tsv describe the same state machine: one for
# humans, one for bin/tick.sh. Neither is generated from the other, so they can
# drift — and drift here is silent and severe, because tick.sh routes on the
# TSV while every agent profile points at the prose.
#
# This turns "keep them in sync" from an instruction into an exit code:
#   * the set of phase names must match exactly, both directions
#   * each phase's on_pass target must agree
#
# Deliberately NOT checked: the on-fail column. Those cells carry conditions
# ("blocked if the gate fails; append decision_log entry"), and a parser strict
# enough to read them would break on ordinary edits. Reconcile that column by
# hand when you touch it.
#
# Exit codes follow gates/README.md: 0 agree, 1 drift, 2 could not run.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MD="${ROOT}/knowledge/process/delivery-phases.md"
TSV="${ROOT}/knowledge/process/phases.tsv"

[ -f "$MD" ]  || { echo "check error: ${MD} not found" >&2; exit 2; }
[ -f "$TSV" ] || { echo "check error: ${TSV} not found" >&2; exit 2; }

# First `backticked` token of a markdown cell. The bootstrap row's phase cell
# (*(no state file yet)*) has none, so it yields nothing and is skipped — the
# router has nothing to route before a state file exists.
# Anchored at the start and excluding backticks before the capture, so this
# takes the FIRST backticked token. A greedy `.*` prefix silently takes the
# last one, which turns "`plan_review`, ending with `HUMAN_GATE: ...`" into
# the marker instead of the phase.
first_tick() { printf '%s' "$1" | sed -n 's/^[^`]*`\([^`]*\)`.*/\1/p' | head -1; }

md_phases=""; md_targets=""
while IFS= read -r line; do
  case "$line" in
    \|*) ;;
    *) continue ;;
  esac
  case "$line" in
    *---*) continue ;;
    *"| phase |"*) continue ;;
  esac
  phase="$(first_tick "$(printf '%s' "$line" | awk -F'|' '{print $2}')")"
  [ -n "$phase" ] || continue
  target="$(first_tick "$(printf '%s' "$line" | awk -F'|' '{print $6}')")"
  md_phases="${md_phases}${phase}"$'\n'
  md_targets="${md_targets}${phase}	${target}"$'\n'
done < "$MD"

tsv_phases="$(awk -F'\t' '$0 !~ /^#/ && NF > 1 { print $1 }' "$TSV")"
tsv_kinds="$(awk -F'\t' '$0 !~ /^#/ && NF > 1 { print $1 "\t" $2 }' "$TSV")"
tsv_targets="$(awk -F'\t' '$0 !~ /^#/ && NF > 1 { print $1 "\t" $5 }' "$TSV")"

fail=0

# Every row must carry all 10 columns. bin/tick.sh reads them positionally with
# `IFS=$'\t' read`, which pads a short row with empty strings rather than
# failing — so a row missing its last column silently reads `interactive` as
# empty and the phase quietly stops being interactive. Catch it here instead.
short="$(awk -F'\t' '$0 !~ /^#/ && NF > 1 && NF != 10 { print "  " $1 " has " NF " columns, expected 10" }' "$TSV")"
if [ -n "$short" ]; then
  echo "drift: phases.tsv rows with the wrong number of columns:" >&2
  printf '%s\n' "$short" >&2
  fail=1
fi

bad_interactive="$(awk -F'\t' '$0 !~ /^#/ && NF == 10 && $10 != "yes" && $10 != "no" { print "  " $1 ": interactive=\"" $10 "\"" }' "$TSV")"
if [ -n "$bad_interactive" ]; then
  echo "drift: interactive column must be exactly yes or no:" >&2
  printf '%s\n' "$bad_interactive" >&2
  fail=1
fi

# An interactive bin/ actor is a contradiction: tick.sh hands the terminal to an
# agent, but a bin/ actor is a script that owns its own I/O and never sees that
# branch. A `yes` there would read as a promise the router does not keep.
bad_actor="$(awk -F'\t' '$0 !~ /^#/ && NF == 10 && $10 == "yes" && ($3 ~ /^bin\// || $3 == "-") { print "  " $1 ": actor \"" $3 "\" cannot be interactive" }' "$TSV")"
if [ -n "$bad_actor" ]; then
  echo "drift: only agent actors can be interactive:" >&2
  printf '%s\n' "$bad_actor" >&2
  fail=1
fi

only_md="$(comm -23 <(printf '%s' "$md_phases" | sort -u) <(printf '%s\n' "$tsv_phases" | sort -u))"
if [ -n "$only_md" ]; then
  echo "drift: phases in delivery-phases.md but not in phases.tsv:" >&2
  printf '  %s\n' $only_md >&2
  echo "  tick.sh exits 2 on an unknown phase, so a story in one of these stalls." >&2
  fail=1
fi

only_tsv="$(comm -13 <(printf '%s' "$md_phases" | sort -u) <(printf '%s\n' "$tsv_phases" | sort -u))"
if [ -n "$only_tsv" ]; then
  echo "drift: phases in phases.tsv but not in delivery-phases.md:" >&2
  printf '  %s\n' $only_tsv >&2
  echo "  the router can reach a phase no agent profile describes." >&2
  fail=1
fi

# on_pass agreement, for non-terminal phases only. Terminal rows say things
# like "A human manually sets phase back", which is prose, not a target.
while IFS=$'\t' read -r phase target; do
  [ -n "$phase" ] || continue
  kind="$(printf '%s\n' "$tsv_kinds" | awk -F'\t' -v p="$phase" '$1 == p { print $2 }')"
  [ -n "$kind" ] || continue
  [ "$kind" != "terminal" ] || continue
  tsv_target="$(printf '%s\n' "$tsv_targets" | awk -F'\t' -v p="$phase" '$1 == p { print $2 }')"
  if [ "$target" != "$tsv_target" ]; then
    echo "drift: '${phase}' on pass -> md says '${target}', tsv says '${tsv_target}'" >&2
    fail=1
  fi
done <<< "$md_targets"

if [ "$fail" -ne 0 ]; then
  echo "phase tables disagree" >&2
  exit 1
fi

n="$(printf '%s' "$md_phases" | grep -c . || true)"
echo "phase tables agree: ${n} phases, on_pass targets match"
exit 0
