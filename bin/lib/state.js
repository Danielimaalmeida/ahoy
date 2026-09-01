'use strict';
// Shared state.json I/O for bin/*.js.
//
// Every writer in bin/ touches state.json the same way: build the new value,
// write it to a temp file beside the original, prove it is valid JSON, and only
// then rename over the original. A half-written state.json is a story the
// router can no longer read, and the file is the control flow — not an agent's
// conversation history — so losing it loses the delivery.
//
// The shape is the contract's, unchanged by the port. jq wrote this file with
// two-space indent and a trailing newline; so do we, so a story that was
// running before the port keeps a byte-identical diff shape afterwards and
// needs no migration.

const fs = require('fs');
const path = require('path');

// jq's default output: 2-space indent, trailing newline.
function serialise(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function read(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// Returns null rather than throwing, for the callers that treat an unreadable
// state file as "nothing recorded" rather than as an error. The bash these
// replace ended those reads with `2>/dev/null || true`.
function readQuiet(statePath) {
  try {
    return read(statePath);
  } catch {
    return null;
  }
}

function isValidJSON(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Atomic replace, with the same refusal the bash had.
//
// The `jq empty` check that guarded every one of these writes cannot fail the
// same way here — JSON.stringify does not emit invalid JSON. It can still
// return undefined (a function, a symbol) or throw (a circular reference), and
// either would truncate the file to nothing. So the guard stays, and it refuses
// exactly as loudly, because "refused to write invalid state" is a message the
// operators of this harness have learned to trust.
function write(statePath, value, label = 'state') {
  let text;
  try {
    text = serialise(value);
  } catch (err) {
    throw new StateWriteError(`${label}: refused to write invalid state (${err.message})`);
  }
  if (typeof text !== 'string' || !isValidJSON(text)) {
    throw new StateWriteError(`${label}: refused to write invalid state`);
  }

  // Beside the original, never in /tmp: rename is only atomic within one
  // filesystem, and specs/ may well be on a different one than TMPDIR.
  const dir = path.dirname(statePath);
  const tmp = path.join(dir, `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* the temp file may never have existed */ }
    throw err;
  }
}

// read -> mutate -> write, which is the shape of nearly every caller.
function update(statePath, fn, label = 'state') {
  const state = read(statePath);
  const next = fn(state) ?? state;
  write(statePath, next, label);
  return next;
}

// A best-effort update: the bash spelling was
//   jq ... > tmp && jq empty tmp && mv tmp state || rm -f tmp
// which leaves the original untouched on any failure and carries on. Used for
// bookkeeping that must never be able to stop a delivery.
function updateQuiet(statePath, fn) {
  try {
    update(statePath, fn);
    return true;
  } catch {
    return false;
  }
}

class StateWriteError extends Error {}

// The timestamp format every writer in this harness uses, and the one the
// gates' `date -u +%Y-%m-%dT%H:%M:%SZ` produces: whole seconds, Z, no
// milliseconds. Not cosmetic — gate_results entries written by gates/*.sh sit
// in the same array as entries written here, and the ledger in credits.sh
// compares timestamps as text.
function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = { read, readQuiet, write, update, updateQuiet, serialise, nowISO, StateWriteError };
