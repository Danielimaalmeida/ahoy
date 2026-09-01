'use strict';
// Spawning, and the terminal.
//
// The line this port draws: the shell asks GitHub questions, JS decides what to
// do with the answers. gates/*.sh are `gh` and `jq` with an exit code on the
// end, and they are invoked here with the same argv and the same environment
// they have always had. The exit code is read and routed on unchanged.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Run a gate and return its exit code WITHOUT throwing.
//
// The exit code is the routing decision, so it must survive intact:
//   0 pass  1 not yet  2 environment  3 branch  4 halt
// A gate that could not be spawned at all is an environment problem, which is
// exactly what 2 means — never a pass, and never a delivery condition.
function runGate(gatesDir, script, args, opts = {}) {
  const r = spawnSync(path.join(gatesDir, script), args, {
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
    cwd: opts.cwd,
  });
  if (r.error) {
    process.stderr.write(`gate error: could not run gates/${script}: ${r.error.message}\n`);
    return { code: 2, out: '' };
  }
  // A signal-killed gate has no exit code. It did not report a verdict, so the
  // only honest reading is that the gate could not run.
  if (r.status === null) return { code: 2, out: (r.stdout || '') + (r.stderr || '') };
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// A plain subprocess whose exit code the caller wants, with the terminal
// inherited. Used for agents, which own their own I/O.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: opts.stdio || 'inherit',
    encoding: 'utf8',
    env: opts.env || process.env,
    cwd: opts.cwd,
  });
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
  return {
    code: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// Capture stdout, the shape of `x="$(cmd)"`. Trailing newline stripped, as
// command substitution does.
function capture(cmd, args, opts = {}) {
  const r = run(cmd, args, { ...opts, stdio: ['ignore', 'pipe', opts.stderr || 'pipe'] });
  return { code: r.code, out: (r.stdout || '').replace(/\n$/, ''), err: r.stderr || '' };
}

function git(repoDir, args, opts = {}) {
  return capture('git', ['-C', repoDir, ...args], opts);
}

// ---------------------------------------------------------------- the terminal
//
// A menu appears only when someone is actually there. Piped or scheduled, the
// harness prints the command and stops — a prompt that blocks forever in CI is
// worse than no prompt.
function haveTTY() {
  if (!process.stdin.isTTY) return false;
  try {
    fs.accessSync('/dev/tty', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// FROM /dev/tty, NOT FROM STDIN. This is load-bearing.
//
// The stuck-package menu iterates a list it is being fed. A read that consumes
// inherited stdin eats the package list rather than the keystroke, hits EOF
// immediately, and the menu prints its options and gives up in the same
// breath — which is exactly what it did the first time a package needed a
// decision. Naming the source is the fix, and it is why nothing in this harness
// reads a human answer from stdin.
//
// Synchronous on purpose: these are blocking questions in a linear script, and
// an async prompt would turn the router inside out for no gain.
function readLineFromTTY() {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'r');
  } catch {
    return null;
  }
  try {
    const byte = Buffer.alloc(1);
    let line = '';
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, byte, 0, 1, null);
      } catch (err) {
        if (err.code === 'EAGAIN') continue;   // non-blocking tty; try again
        if (err.code === 'EOF') return line === '' ? null : line;
        throw err;
      }
      if (n === 0) return line === '' ? null : line;   // EOF
      const ch = byte.toString('utf8');
      if (ch === '\n') return line;
      if (ch !== '\r') line += ch;
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { runGate, run, capture, git, haveTTY, readLineFromTTY };
