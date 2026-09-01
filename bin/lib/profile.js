'use strict';
// Tool grants come from the agent's own profile. Never a hardcoded list.
//
// A profile's `tools:` list says what the agent MAY use. `--allow-tool` says
// what it may use WITHOUT ASKING — and under --no-ask-user, anything outside
// that list is a silent denial rather than a prompt. So the two have to agree,
// and a fixed grant in the harness quietly overrules every profile.
//
// That is not theoretical. `frontend-implementer` declares `density-mcp/*` and
// got `shell,write,edit`, so its design-system validation was refused mid-run
// and it built a Splitter without ever checking the design system. Nothing
// failed. The work just happened without an input the repository said it
// needed, and the only evidence was a line in a log nobody had to read.

const fs = require('fs');
const path = require('path');

// The `tools:` value is YAML front matter and may be inline or spread over
// several lines. Take everything between `tools:` and the closing bracket,
// pull out the quoted entries, and join them.
//
// This is the awk/tr/sed/grep/paste pipeline the three bash callers shared,
// kept character-for-character equivalent — including that the line carrying
// the `]` is part of the captured block, and that an entry is whatever sits
// between the LAST pair of quotes on its comma-separated fragment.
function parseTools(text) {
  const lines = text.split('\n');
  let grabbing = false;
  let buf = '';
  for (const line of lines) {
    if (/^tools:/.test(line)) grabbing = true;
    if (grabbing) buf += ' ' + line;
    if (grabbing && line.includes(']')) break;
  }
  if (!grabbing) return '';

  const entries = [];
  for (const fragment of buf.split(',')) {
    // Greedy prefix, exactly like sed's `.*['"]\([^'"]*\)['"].*` — it anchors
    // on the last quote pair in the fragment, so `tools: ['read'` yields
    // `read` rather than the whole prefix.
    const m = /^.*['"]([^'"]*)['"]/.exec(fragment);
    if (!m) continue;                 // a fragment with no quotes prints nothing
    if (m[1] === 'tools') continue;   // grep -v '^tools$'
    entries.push(m[1]);
  }
  return entries.join(',');
}

// Returns the comma-joined grant, or null when there is no profile to read.
// Null rather than a fallback string on purpose: the caller decides what a
// missing profile means, and every caller says so out loud when it happens.
function toolsFrom(profilePath) {
  if (!fs.existsSync(profilePath)) return null;
  return parseTools(fs.readFileSync(profilePath, 'utf8'));
}

// Child repositories keep their agents in `.github/agents/`. bin/dispatch.js
// reads the profile from the worktree, which is the repository that owns the
// agent and maintains its tool list.
function childProfileTools(worktree, agent) {
  return toolsFrom(path.join(worktree, '.github', 'agents', `${agent}.agent.md`));
}

// Control-plane agents live in BOTH locations. This repository has carried them
// in `.github/agents/` since the desktop-app days; `agents/` is where the newer
// profiles sit. Checking one and warning about the other produced a silent
// fallback to `shell,write,edit`, which denied the Sonarqube tools
// lookout-design declares — so the design review ran without the analyser and
// said nothing about it.
function controlPlaneTools(root, agent) {
  for (const candidate of [
    path.join(root, 'agents', `${agent}.agent.md`),
    path.join(root, '.github', 'agents', `${agent}.agent.md`),
  ]) {
    const tools = toolsFrom(candidate);
    if (tools !== null) return tools;
  }
  return null;
}

// The agent must be able to commit whatever else its profile says. A profile
// listing only MCP tools would otherwise lose the ability to touch .git, which
// is the failure that produced a four-minute run with +2 -2 and no commits.
function ensure(grant, ...required) {
  let out = grant;
  for (const tool of required) {
    if (!`,${out},`.includes(`,${tool},`)) out = `${out},${tool}`;
  }
  return out;
}

module.exports = { parseTools, toolsFrom, childProfileTools, controlPlaneTools, ensure };
