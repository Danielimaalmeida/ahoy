#!/usr/bin/env node
'use strict';
// bin/repo.js <plan-alias> [--refresh]
// bin/repo.js --list
//
// Ensures a read-only checkout of a child repository exists locally and prints
// its path on stdout. Nothing else goes to stdout, so a caller can use it
// directly:
//
//     src="$(bin/repo.sh frontend)"
//     rg 'columnWidth' "$src/src"
//
// WHY THIS EXISTS. Cartographer needs to read child repository source to write a
// plan worth approving. A plan that assigns work packages to a repository nobody
// looked at is built from Jira and Confluence alone, and the ambiguity it cannot
// resolve gets deferred onto the implementer.
//
// Left to improvise, the agent cloned into /tmp with a hand-built URL. That
// works right up until it does not: an unbounded location outside the layout
// every other part of the harness uses, a second copy of the URL-building logic
// that can drift from dispatch's, and no shared cache — so the same repository
// is cloned again for every session.
//
// This is the same clone cache bin/dispatch.js warms, resolved from the same
// mapping file, over the same scheme. Planning populates it; implementation adds
// worktrees to it. One code path, one place on disk.
//
// READ-ONLY BY CONTRACT, NOT BY PERMISSION. This is a real git clone and nothing
// stops a determined caller committing in it. It is not a checkout to work in:
// dispatch creates a per-story worktree off this clone for that, on the branch
// the plan named. Read here; write there.
//
// Exit codes:
//   0 the checkout exists; its path is on stdout
//   1 the alias is not in the mapping
//   2 environment error, or the clone failed

const fs = require('fs');
const path = require('path');
const { root, makeLog, err, out, die, haveCommand } = require('./lib/cli');
const mapping = require('./lib/mapping');
const proc = require('./lib/proc');

const ROOT = root();
const MAPPING = process.env.HARNESS_REPO_MAPPING
  || path.join(ROOT, 'knowledge', 'repositories', 'agent-mappings.md');
const WORKTREES = process.env.HARNESS_WORKTREE_ROOT || path.join(ROOT, 'work');
const CLONES = path.join(WORKTREES, '.clones');

const log = makeLog('repo');

if (!fs.existsSync(MAPPING)) {
  die(2, `repo: mapping not found at ${MAPPING} (set HARNESS_REPO_MAPPING)`);
}
if (!haveCommand('git')) die(2, 'repo: git is required');

const argv = process.argv.slice(2);

if (argv[0] === '--list') {
  for (const alias of mapping.listAliasesFile(MAPPING)) out(alias);
  process.exit(0);
}

const ALIAS = argv.shift() || '';
if (!ALIAS) {
  die(2, 'usage: bin/repo.sh <plan-alias> [--refresh]', '       bin/repo.sh --list');
}

let REFRESH = false;
while (argv.length) {
  const a = argv.shift();
  if (a === '--refresh') { REFRESH = true; continue; }
  die(2, `unknown option: ${a}`);
}

const slug = mapping.resolveFieldFile(MAPPING, ALIAS, 'slug');
if (!slug) {
  err(`repo: no repository in ${MAPPING} has plan alias '${ALIAS}'.`);
  err('repo: known aliases:');
  for (const a of mapping.listAliasesFile(MAPPING)) err(`  ${a}`);
  err("repo: a repository under 'not yet mapped' has no plan alias and no conforming agent set.");
  process.exit(1);
}

const clone = path.join(CLONES, ALIAS);

if (!fs.existsSync(path.join(clone, '.git'))) {
  const remote = mapping.remoteFor(slug);
  fs.mkdirSync(CLONES, { recursive: true });
  log(`cloning ${ALIAS} from ${remote}`);
  // Full history, not --depth 1. dispatch adds worktrees to this same clone
  // and needs real history to branch from; a shallow clone would have to be
  // unshallowed later, at implementation time, when a failure costs more.
  const r = proc.run('git', ['clone', remote, clone], { stdio: ['ignore', 2, 2] });
  if (r.code !== 0) {
    die(2,
      'repo: clone failed. If this is an auth error, check that your SSH key',
      `repo: reaches ${slug.slice(0, slug.indexOf('/'))} — the harness clones over SSH by default`,
      'repo: because HTTPS picks up whatever the credential helper offers.');
  }
} else if (REFRESH) {
  log(`refreshing ${ALIAS}`);
  const r = proc.run('git', ['-C', clone, 'fetch', 'origin'], { stdio: ['ignore', 2, 2] });
  if (r.code !== 0) die(2, `repo: fetch failed for ${ALIAS}`);
}

out(clone);
