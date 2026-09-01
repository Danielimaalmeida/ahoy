'use strict';
// knowledge/repositories/agent-mappings.md — the alias-to-slug resolver.
//
// One parser, shared by bin/repo.js and bin/dispatch.js. They used to hold
// identical copies of this awk; two readers of one mapping that parse it
// differently is a drift waiting to happen, and the whole reason repo.sh exists
// is that a second copy of the URL-building logic had already drifted once.
//
// Each repository section carries rows like:
//     | plan alias | `backend` |
//     | slug       | `host.example/qwerty/r3da_cdm_backend` |
// Repositories under "not yet mapped" have no plan alias, so they never match.

const fs = require('fs');

// Both alias AND value reset at every `## ` heading.
//
// Resetting only one is a real bug with a name: without clearing both, the
// "Repositories not yet mapped" section inherits the previous section's slug
// and becomes silently clonable — a repository with no conforming agent set,
// dispatched into because a variable was left behind.
function resolveField(text, wantAlias, field) {
  const fieldRe = new RegExp(`\\| *${field} *\\|`);
  const aliasRe = /\| *plan alias *\|/;
  let alias = '';
  let val = '';
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) { alias = ''; val = ''; }
    if (fieldRe.test(line)) {
      const parts = line.split('`');
      if (parts.length >= 2) val = parts[1];
    }
    if (aliasRe.test(line)) {
      const parts = line.split('`');
      if (parts.length >= 2) alias = parts[1];
    }
    if (alias === wantAlias && val !== '') return val;
  }
  return '';
}

function listAliases(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/\| *plan alias *\|/.test(line)) {
      const parts = line.split('`');
      if (parts.length >= 2) out.push(parts[1]);
    }
  }
  return out;
}

function resolveFieldFile(mappingPath, alias, field) {
  return resolveField(fs.readFileSync(mappingPath, 'utf8'), alias, field);
}

function listAliasesFile(mappingPath) {
  return listAliases(fs.readFileSync(mappingPath, 'utf8'));
}

// Clone over SSH by default. On GitHub Enterprise, HTTPS goes through whatever
// credential helper answers first — on macOS that is usually the keychain,
// which commonly holds a stale read-only token and reports "Write access to
// repository not granted" even when `gh` is authenticated with the right
// scopes. SSH keys sidestep the helper entirely.
//
// Set HARNESS_CLONE_SCHEME=https to force HTTPS. A slug that already carries a
// scheme is used verbatim: an https:// prefix in the mapping used to be pasted
// into `git@host:...`, which broke both cloning and `gh --repo`.
function remoteFor(slug, env = process.env) {
  if (/^http/.test(slug) || slug.startsWith('git@')) return slug;
  const host = slug.slice(0, slug.indexOf('/'));
  const repoPath = slug.slice(slug.indexOf('/') + 1);
  return (env.HARNESS_CLONE_SCHEME || 'ssh') === 'https'
    ? `https://${host}/${repoPath}`
    : `git@${host}:${repoPath}.git`;
}

module.exports = { resolveField, listAliases, resolveFieldFile, listAliasesFile, remoteFor };
