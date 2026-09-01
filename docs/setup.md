# Setting up Ahoy

Everything a new machine needs, in order. Roughly twenty minutes, most of it
waiting for installs.

Read the first section before you start — a couple of the requirements are hard
constraints rather than preferences, and finding that out at step 8 is annoying.

---

## What this repository is

Ahoy is the control plane for our agentic deliveries. It contains agents,
process definitions, **gate scripts** — small shell scripts that turn "the agent
said it was done" into "a script checked and returned an exit code" — and a
**harness** under `bin/` that runs those gates and routes on their exit codes.

The short version of why: agents follow prose instructions most of the time, and
report success either way. The gates are the parts that don't take their word for
it. `child_ready.sh` doesn't ask whether tests were written — it greps the pull
request diff for the exact test names the plan promised, and asks GitHub whether
CI is green.

**The harness is what makes that stick.** Gates used to be run by an agent, which
then reported whether they passed. Now `bin/tick.js` runs them and routes on the
exit code. No agent decides whether its own work passed, and no agent writes
`phase`.

**Two languages, on purpose.** `gates/` is bash: each gate is `gh` and `jq` with
an exit code on the end, which is what shell is good at. `bin/` is Node: the
router is a state machine over a JSON file, which is not. The gates are invoked
with the same argv and environment either way, and the exit-code contract does
not care what calls it. Each `bin/x.sh` is a two-line shim that execs `x.js`, so
every runbook, cron entry and habit that names the `.sh` still works. See
[decisions.md](decisions.md).

It contains no application code. That lives in the child repositories.

---

## Hard requirements

**A POSIX shell.** The gates are bash, and the harness runs them. On Windows
this means running everything **from inside WSL**, not from Windows — including
`node`, which must be the WSL one rather than a Windows install. If commands run
in PowerShell against a `\\wsl.localhost\...` path, nothing works and the error
is misleading ("not inside a git repository"). Check with:

```bash
uname -s              # must print Linux or Darwin
command -v node bash  # both must resolve inside WSL
```

**Node 22.5 or newer**, for the harness under `bin/` and the web UI. Standard
library only — no dependencies, no build step, no `package.json`, nothing to
`npm install`. You already have it if you installed the Copilot CLI, which is an
npm package.

```bash
node --version    # v22.5.0 or newer
```

Everything except credits works on Node 18. The floor is 22.5 because
`bin/credits.js` reads the Copilot usage ledger with `node:sqlite`. On an older
Node it says so and records nothing, rather than failing a delivery over
bookkeeping — so an out-of-date Node costs you the credits panel, not the story.

**`jq`, `git`, `gh`.** All three, with `gh` authenticated to our Enterprise host.
`jq` is still required: every gate under `gates/` uses it, so a machine without
it cannot enforce the gates whatever the router is written in.

**`script(1)`**, for the web UI's interactive panel. Node's standard library has
no pty, and `planning` hands cartographer a real terminal so it can ask you
questions — so the server runs the router under `script`, which allocates one.
It ships with macOS and with every Linux (util-linux); nothing to install. The
terminal path does not need it. Without it the server starts and says so, and
only the browser's planning sessions are affected.

**No Python.** It used to be needed for the UI server and the usage ledger;
both are Node now.

**SSH access to the Enterprise host.** The harness clones over SSH by default.
HTTPS goes through whatever credential helper answers first — on macOS usually a
keychain entry holding a stale read-only token, which reports "Write access to
repository not granted" even when `gh` is authenticated correctly.

**LF line endings.** Handled by `.gitattributes`, but if your checkout predates
that, see Troubleshooting.

---

## 1. Tooling

**macOS**

```bash
brew install jq gh
```

**Linux / WSL**

```bash
sudo apt update && sudo apt install -y jq
# gh: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
```

Then authenticate against the host that holds our repositories:

```bash
gh auth login --hostname zxc-github.azure.cloud.asd
gh auth status
```

`gh auth status` reports across every host you have configured and returns
non-zero if **any** of them fails. A stale `github.com` credential you never use
will make it look broken. The gates check one host specifically, so this only
matters when you are debugging by hand.

---

## 2. Copilot CLI

```bash
npm install -g @github/copilot
copilot --version
copilot            # log in interactively against our Enterprise host
```

**Version matters.** 1.0.82 shipped a regression that breaks non-interactive
authentication entirely — interactive sessions work, `copilot --prompt` does not.
If you hit auth errors that make no sense, check the version first and pin
1.0.80:

```bash
npm install -g @github/copilot@1.0.80
```

Copilot self-updates, so this can come back.

**We use the CLI, not the desktop app.** The app has its own orchestration, and
two orchestrators fighting over one story is one too many. The app's
`create_session` tool does not exist here; `bin/dispatch.sh` replaces it with git
worktrees.

---

## 3. Clone

```bash
git clone <ahoy-repo-url> ~/r3da_niooo_ahoy_workspace
cd ~/r3da_niooo_ahoy_workspace
```

**On WSL, clone into the Linux filesystem** (`~/`), not `/mnt/c/`. Working across
the Windows/WSL boundary is slow and produces permission oddities.

---

## 4. Environment (optional)

Everything has a working default. Skip this section unless something below
applies to you.

```bash
cat >> ~/.zshenv << 'EOF'
export HARNESS_GH_HOST=zxc-github.azure.cloud.asd
export HARNESS_GH_BIN=/opt/homebrew/bin/gh    # macOS path; adjust or omit
EOF
```

`.zshenv` rather than `.zshrc` because it is read by non-interactive shells too,
which is how an agent runs commands.

| variable | default | set it when |
|---|---|---|
| `HARNESS_GH_HOST` | our Enterprise host | that changes |
| `HARNESS_GH_BIN` | `gh` on `PATH` | you have RTK installed (section 8) |
| `HARNESS_CLONE_SCHEME` | `ssh` | you must use HTTPS |
| `HARNESS_WORKTREE_ROOT` | `work/` | you want worktrees elsewhere |
| `HARNESS_WAIT_INTERVAL` | `30` (seconds) | CI is much slower or faster |

**Do not set `HARNESS_ALLOW_TOOLS`.** The harness reads each agent's tool grant
from its own profile — `tools:` in `.github/agents/<agent>.agent.md` for child
repositories, `agents/` here for control-plane agents. That variable overrides
the profile for every agent at once, which is a debugging tool and not a setting.

`GH_HOST`, if you have it set, is **passed through** to Copilot rather than
stripped. Our Copilot login is against the Enterprise host.

---

## 5. Check it works

```bash
bash gates/preflight.sh
```

This is the single most important command in this document. It verifies you have
a shell at all, that `jq`/`git`/`gh` resolve, that `gh` is authenticated for our
host, and that every gate script parses. It prints a run id.

Then the test suite:

```bash
tests/run.sh
tests/check-phase-table.sh
```

Offline — no network, no credentials, no model, `gh` stubbed. Around 170
assertions covering every gate's exit-code contract and every harness script.
If these fail, stop and fix that before running a story.

The cases live in `tests/cases/*.test.js` and run under `node:test`. While
iterating on one script, run just its file:

```bash
node --test tests/cases/tick.test.js
```

The gate cases run the real `gates/*.sh` against the stub `gh` — a test that ran
an imitation of a gate would be testing the imitation.

Then confirm SSH reaches the Enterprise host, which nothing above covers:

```bash
bin/repo.sh --list          # the plan aliases you can ask for
bin/repo.sh frontend        # prints a path; clones on first use
```

Better to find a broken key here than three minutes into a planning session.

---

## 6. Agents and MCP

Agents live in `agents/`. Open a session in this repository and confirm:

```
/agent          # cartographer, navigator, lookout-design, lookout-defect
/mcp            # jira, confluence, angular, sonarqube all connected?
```

| Server | Used by | For |
| --- | --- | --- |
| `jira` | navigator, cartographer | Jira story/bugfix intake and status |
| `confluence` | navigator, cartographer | Confluence product/process context |
| `angular` | cartographer | Angular workspace structure for frontend stories |
| `sonarqube` | lookout-design | Quality gate status and reported issues |

`jira` and `confluence` used to be a single `atlassian` server; if `/mcp` still
shows `atlassian`, reconfigure it as two separate servers before running a
delivery.

Child repositories declare their own MCP servers in their own agent profiles —
`density-mcp` in the frontend repo, for instance. You do not configure those
here; the harness reads the profile and grants what it asks for.

---

## 7. Running a story

One command.

```bash
bin/serve.sh
```

Open <http://127.0.0.1:8765>, press **+ New story**, and type the Jira key. The
UI is the primary way in — it starts the story, streams the agent into a
terminal panel in the page, and presents each decision when the story reaches
it. The README's "Running a delivery" walks through it.

Or the same delivery from the terminal:

```bash
bin/run.sh R3DA-14022
```

It fetches the ticket, hands Cartographer your terminal to plan it with you, and
stops at a menu:

```
  1) approve  — record the decision and carry on
  2) revise   — say what to change; back to the agent that made it
  3) chat     — open a session to talk it through, change nothing
  4) quit     — decide later; nothing is recorded
```

Press `1` and it implements, waits for CI, opens the pull request, runs both
reviewers, and stops at the delivery gate with the same menu. Press `1` again and
the story is done.

**Read the plan properly at the first stop.** That is the checkpoint that
matters. `gates/plan.sh` proves every acceptance criterion traces back to the
ticket; nothing can prove the criteria *cover* it. A wrong plan implemented
flawlessly is the most expensive thing this loop can produce.

Either interface continues from wherever the story actually is — re-run
`bin/run.sh`, or press **Continue** in the UI. Nothing is held in memory between
runs, so a closed laptop costs one command, not the story.

### Checking what actually happened

```bash
jq '{phase, gates: (.gate_results | map(.gate))}' specs/<JIRA-KEY>/state.json
jq '.decision_log' specs/<JIRA-KEY>/state.json
```

`gate_results` entries are written by the gates themselves and carry
`recorded_by: "gate"`. A missing entry means the script did not run — you do not
have to ask an agent and hope for an honest answer.

---

## 8. RTK (optional)

RTK compresses command output before agents read it. Roughly 65% off bash output
in our measurements, which is a smaller share of the actual bill — bash output is
one contributor to input tokens among several.

```bash
brew install rtk        # or the install script from the RTK repository
rtk init -g --copilot
```

**One thing to know.** RTK reformats `gh pr diff` output by indenting it. The
diff content survives, but the `+` markers move off column zero — which broke a
gate that searched for added lines. The gates now tolerate leading whitespace and
can be pinned to a specific binary (`HARNESS_GH_BIN`), so this is handled. It is
worth knowing as an example of the general hazard: a tool that makes output
nicer for humans can silently break a check meant for a machine.

---

## Troubleshooting

**`preflight.sh` says "not inside a git repository" but git works fine.**
Commands are running in PowerShell against a WSL path. Confirm with
`$PSVersionTable.PSVersion` — if that returns a version, work from inside WSL.

**`$'\r': command not found`, or syntax errors near `do`.**
CRLF line endings from a Windows checkout:

```bash
git config core.autocrlf false
rm -rf gates bin && git checkout gates bin
```

**A gate exits 2.**
The gate could not run — missing tool, unreachable state file, `gh` not
authenticated. An environment problem, never a failed delivery condition. Exit 1
is a real validation failure; exit 2 is "fix your setup".

**`node: command not found` from a `bin/*.sh` command.**
Each `bin/x.sh` is a shim that execs `bin/x.js`, so the harness needs `node` on
`PATH`. On Windows this usually means you have Node installed on the Windows
side but not inside WSL, where everything here must run. Install it in WSL and
check `command -v node` resolves to a Linux path.

**Clone fails with 403 or "write access not granted".**
Your git HTTPS credentials, not `gh`. The harness clones over SSH by default;
confirm your key reaches the host with `bin/repo.sh <alias>`.

**An agent exits cleanly having changed nothing.**
Almost always a denied tool. Under `--no-ask-user`, a permission request becomes
a silent denial rather than a prompt — no error, no indication anyone was going
to be asked. Check the agent output for "could not request permission from user",
then check the tool is in that agent's profile.

**"Permission denied" writing a file, or "path does not exist" reading one.**
An agent running in a child repository worktree cannot reach the control plane in
either direction. The harness stages the plan in and carries the report out; if
you are adding a new prompt, keep every path inside the agent's own directory.

**A gate says a criterion is unmet but a reviewer disagrees.**
That is exit 4, not rework, and it is deliberate. Read both reports in
`specs/<STORY-ID>/reviews/` and decide. There is no reconciliation round.

**Something else.**
Write it down and tell the team rather than fixing it mid-story. Debugging a
config change and a delivery simultaneously is how a day disappears.

---

## What to expect

This is new and it is not finished. Known rough edges:

- The Lookouts are the least-exercised part of the loop. Expect prompt
  adjustment.
- `dispatch.sh` does not open the pull request itself; it asks the last work
  package to. An agent has ignored that flag before.
- Nothing verifies that acceptance criteria *cover* the ticket. That check is
  the human at `plan_review`, and it is why that stop exists.
- `state.json` is a file with no locking. Concurrent runs on one story will
  race. Do not schedule this yet.
- Sessions resume across revision rounds, but session ids live in `~/.copilot`,
  outside the repo. They can be pruned and do not follow you to another machine.
  A failed resume falls back to a cold prompt.

If it breaks in a new way, that is useful information. Note what happened and
what the state file said, and bring both.