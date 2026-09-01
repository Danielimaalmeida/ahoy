'use strict';
// tool grants — the profile decides, not a hardcoded string.
//
// A tool in the profile but not in --allow-tool is available in principle and
// refused in practice, silently, under --no-ask-user. That is how an implementer
// built a component without the design-system check its own profile required.
//
// The bash suite pasted dispatch.sh's awk pipeline into the test file and
// asserted against the paste. This imports the parser the three callers share,
// so a change to it is caught here rather than discovered in a run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { newWorkspace } = require('../lib/harness');
const profile = require('../../bin/lib/profile');

const MULTILINE = `---
name: impl
tools:
  [
    'read',
    'write',
    'edit',
    'shell',
    'Sonarqube-show_rule',
    'density-mcp/*',
  ]
model: gpt-5.3-codex
---
`;

const INLINE = `---
name: inline
tools: ['read', 'edit', 'search']
model: x
---
`;

function withWS(fn) {
  const ws = newWorkspace();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('a multi-line tools list is read whole, MCP wildcards included', () => {
  withWS((ws) => {
    ws.write('child/.github/agents/impl.agent.md', MULTILINE);
    assert.strictEqual(
      profile.childProfileTools(ws.path('child'), 'impl'),
      'read,write,edit,shell,Sonarqube-show_rule,density-mcp/*');
  });
});

test('an inline tools list is read too', () => {
  withWS((ws) => {
    ws.write('child/.github/agents/inline.agent.md', INLINE);
    assert.strictEqual(profile.childProfileTools(ws.path('child'), 'inline'), 'read,edit,search');
  });
});

test('a missing profile fails rather than returning a bogus grant', () => {
  withWS((ws) => {
    fs.mkdirSync(ws.path('child'), { recursive: true });
    assert.strictEqual(profile.childProfileTools(ws.path('child'), 'missing'), null);
  });
});

// Control-plane agents live in `.github/agents/` in this repository and in
// `agents/` in the newer layout. Looking in only one produced a silent fallback
// to shell,write,edit — which denied lookout-design the Sonarqube tools its own
// profile declares, so the design review ran without the analyser.
test('a profile in .github/agents is found', () => {
  withWS((ws) => {
    ws.write('cp/.github/agents/old.agent.md', "---\nname: old\ntools: ['read', 'Sonarqube-show_rule']\n---\n");
    assert.strictEqual(profile.controlPlaneTools(ws.path('cp'), 'old'), 'read,Sonarqube-show_rule');
  });
});

test('a profile in agents is found', () => {
  withWS((ws) => {
    ws.write('cp/agents/new.agent.md', "---\nname: new\ntools: ['read', 'write']\n---\n");
    assert.strictEqual(profile.controlPlaneTools(ws.path('cp'), 'new'), 'read,write');
  });
});

test('and one in neither still fails rather than guessing', () => {
  withWS((ws) => {
    fs.mkdirSync(ws.path('cp'), { recursive: true });
    assert.strictEqual(profile.controlPlaneTools(ws.path('cp'), 'nowhere'), null);
  });
});

// `agents/` wins when both exist: it is the newer layout, and a stale copy in
// `.github/agents/` silently overruling it would be the same class of bug the
// two-location lookup was added to fix.
test('agents/ takes precedence over .github/agents/', () => {
  withWS((ws) => {
    ws.write('cp/agents/both.agent.md', "---\ntools: ['new']\n---\n");
    ws.write('cp/.github/agents/both.agent.md', "---\ntools: ['old']\n---\n");
    assert.strictEqual(profile.controlPlaneTools(ws.path('cp'), 'both'), 'new');
  });
});

// The agent must be able to commit whatever else its profile says. A profile
// listing only MCP tools would otherwise lose the ability to touch .git, which
// is the failure that produced a four-minute run with +2 -2 and no commits.
test('shell is added to a grant that lacks it', () => {
  assert.strictEqual(profile.ensure('density-mcp/*', 'shell'), 'density-mcp/*,shell');
});

test('a grant that already has shell is not given it twice', () => {
  assert.strictEqual(profile.ensure('read,shell,edit', 'shell'), 'read,shell,edit');
});

// A prefix match must not count: `shellcheck` is not `shell`, and treating it
// as one leaves the agent unable to commit for a reason nothing would report.
test('a tool that merely starts with shell does not satisfy the requirement', () => {
  assert.strictEqual(profile.ensure('shellcheck,read', 'shell'), 'shellcheck,read,shell');
});

// The control plane's real profiles, read through the same parser the harness
// uses. A profile that stops parsing is a silent downgrade to shell,write,edit.
test('this repository\'s own agent profiles all parse', () => {
  const dir = path.resolve(__dirname, '..', '..', '.github', 'agents');
  const profiles = fs.readdirSync(dir).filter((f) => f.endsWith('.agent.md'));
  assert.ok(profiles.length > 0, 'there are profiles to check');
  for (const f of profiles) {
    const agent = f.replace(/\.agent\.md$/, '');
    const tools = profile.controlPlaneTools(path.resolve(__dirname, '..', '..'), agent);
    assert.ok(tools && tools.length > 0, `${f} yields a non-empty tool grant`);
  }
});
