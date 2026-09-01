'use strict';
// Small shared bits every bin/*.js needs: where the repo root is, how to log,
// and how to leave.

const path = require('path');
const fs = require('fs');

// ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" — the repository this
// script lives in, not the current working directory. Every path in bin/ is
// resolved from here, which is what lets the scripts be run from anywhere.
function root() {
  return path.resolve(__dirname, '..', '..');
}

function statePath(rootDir, storyId) {
  return path.join(rootDir, 'specs', storyId, 'state.json');
}

function tablePath(rootDir) {
  return path.join(rootDir, 'knowledge', 'process', 'phases.tsv');
}

// Everything diagnostic goes to stderr, so a caller can use stdout for the
// value it asked for. bin/repo.js depends on this: `src="$(bin/repo.sh
// frontend)"` must receive a path and nothing else.
function makeLog(prefix, storyId) {
  return (...parts) => {
    process.stderr.write(`[${prefix}${storyId ? ' ' + storyId : ''}] ${parts.join(' ')}\n`);
  };
}

function err(...parts) {
  process.stderr.write(parts.join(' ') + '\n');
}

function out(...parts) {
  process.stdout.write(parts.join(' ') + '\n');
}

// die(2, ...) for usage and environment, die(1, ...) for "not in the required
// state". The distinction is the same one gates/README.md draws and for the
// same reason: a caller reading only the exit code must be able to tell a
// broken environment from a failed condition.
function die(code, ...lines) {
  for (const line of lines) err(line);
  process.exit(code);
}

function requireFile(p, message, code = 2) {
  if (!fs.existsSync(p)) die(code, message);
  return p;
}

// `command -v jq` — the dependency checks the bash did before touching
// anything. jq is still required: gates/*.sh are unchanged and every one of
// them needs it, so a harness without jq cannot enforce its gates whatever
// language the router is written in.
function haveCommand(cmd) {
  const { spawnSync } = require('child_process');
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd).slice(1, -1)}`], { stdio: 'ignore' });
  return probe.status === 0;
}

module.exports = { root, statePath, tablePath, makeLog, err, out, die, requireFile, haveCommand };
