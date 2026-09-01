'use strict';
// Agent sessions, recorded against the phase that opened them.
//
// Copilot keeps conversation state per session, and `--resume=<id> --prompt`
// was measured to be ONE-SHOT: it answers, remembering the earlier turns, and
// returns to the shell. So a session is something the harness can drive rather
// than only something a person sits inside.
//
// That matters most for revisions. Without it, every round starts cold: the
// agent re-reads the plan, re-derives the context it had ten minutes ago, and
// has no idea what was already tried or rejected. With it, "the frontend
// criteria miss the empty state" lands in a session that already knows what the
// frontend criteria are.
//
// The id is ASSIGNED rather than parsed out of the agent's output. Parsing a
// banner is a dependency on formatting; --session-id is a documented flag and
// the value is ours either way.
//
// It is an OPTIMISATION, not state the harness depends on. Sessions live under
// ~/.copilot, outside the repo: they can be pruned and do not survive moving
// machines. A resume that fails must fall back to a cold prompt, because the
// plan on disk is the source of truth and the session is only a shortcut to it.
// Clearing an id must therefore leave the story perfectly workable.

const crypto = require('crypto');
const state = require('./state');

function idFor(statePath, phase) {
  return ((state.readQuiet(statePath) || {}).session_ids || {})[phase] || '';
}

// Best-effort, like the bash it replaces: a failed write leaves the original
// untouched and the harness carries on with a cold session.
function remember(statePath, phase, id) {
  return state.updateQuiet(statePath, (s) => {
    s.session_ids = { ...(s.session_ids || {}), [phase]: id };
  });
}

function newId() {
  return crypto.randomUUID();
}

module.exports = { idFor, remember, newId };
