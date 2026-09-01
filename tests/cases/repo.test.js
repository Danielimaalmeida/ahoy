'use strict';
// bin/repo.sh — one clone path, resolved from the mapping.
//
// Alias resolution only. Cloning needs a network and credentials, which this
// suite deliberately does not have — but resolution is where the bugs were:
// a slug with an https:// prefix broke both cloning and `gh --repo`, and an
// alias reset bug once let one repository inherit the previous one's slug.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace } = require('../lib/harness');
const mapping = require('../../bin/lib/mapping');

const MAPPING = `## Backend

| field | value |
|---|---|
| plan alias | \`backend\` |
| slug | \`host.example/qwerty/r3da_cdm_backend\` |

## Frontend

| field | value |
|---|---|
| plan alias | \`frontend\` |
| slug | \`host.example/qwerty/r3da_cdm_frontend\` |

## Repositories not yet mapped

| field | value |
|---|---|
| slug | \`host.example/qwerty/r3da_cdm_ops\` |
`;

function repoWS() {
  const ws = newWorkspace();
  ws.installBin('repo');
  ws.write('knowledge/repositories/agent-mappings.md', MAPPING);
  return ws;
}

function withWS(fn) {
  const ws = repoWS();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('--list shows only aliased repositories', () => {
  withWS((ws) => {
    const r = ws.bin('repo.sh', '--list');
    assert.strictEqual(r.stdout.trim(), 'backend\nfrontend');
  });
});

test('an unmapped alias is refused, not cloned', () => {
  withWS((ws) => {
    assert.strictEqual(ws.bin('repo.sh', 'ops').code, 1);
  });
});

test('an unknown alias prints no path to stdout', () => {
  withWS((ws) => {
    assert.strictEqual(ws.bin('repo.sh', 'nonexistent').stdout, '');
  });
});

// The alias/slug reset bug: without clearing BOTH at each `## ` heading, the
// unmapped section inherits frontend's slug and becomes silently clonable.
test('the unmapped section does not inherit the previous slug', () => {
  assert.strictEqual(mapping.resolveField(MAPPING, 'ops', 'slug'), '');
  assert.strictEqual(mapping.resolveField(MAPPING, 'backend', 'slug'),
    'host.example/qwerty/r3da_cdm_backend');
  assert.strictEqual(mapping.resolveField(MAPPING, 'frontend', 'slug'),
    'host.example/qwerty/r3da_cdm_frontend');
});

// A slug that already carries a scheme is used verbatim. An https:// prefix
// pasted into `git@host:...` produced a remote that resolved nowhere, and the
// same string then broke `gh --repo`.
test('a bare slug becomes an SSH remote by default', () => {
  assert.strictEqual(mapping.remoteFor('host.example/qwerty/r3da_cdm_backend', {}),
    'git@host.example:qwerty/r3da_cdm_backend.git');
});

test('HARNESS_CLONE_SCHEME=https is honoured', () => {
  assert.strictEqual(
    mapping.remoteFor('host.example/qwerty/r3da_cdm_backend', { HARNESS_CLONE_SCHEME: 'https' }),
    'https://host.example/qwerty/r3da_cdm_backend');
});

test('a slug that already has a scheme is left alone', () => {
  assert.strictEqual(mapping.remoteFor('https://host.example/a/b', {}), 'https://host.example/a/b');
  assert.strictEqual(mapping.remoteFor('git@host.example:a/b.git', {}), 'git@host.example:a/b.git');
});
