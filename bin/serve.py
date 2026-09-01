#!/usr/bin/env python3
"""bin/serve.py - the browser version of Ahoy's terminal menu.

Reads specs/*/state.json and knowledge/process/phases.tsv. It writes neither.
Every human decision goes through bin/approve.sh or bin/revise.sh, which are
the single writer of state.json - see README, "Delivery state".

Python 3 standard library only. Localhost only. Single user, no auth.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# The interactive session needs a real terminal, because that is the interface
# the agent already has: phases.tsv marks `planning` interactive precisely so
# cartographer can ask questions, and tick.sh runs it without capturing output.
# A pipe would make it look unattended, and an unanswerable question becomes a
# silent denial. `pty` is POSIX-only, which the bash scripts already require.
try:
    import pty
    import termios
except ImportError:  # pragma: no cover - Windows
    pty = None
    termios = None

ROOT = Path(__file__).resolve().parent.parent
SPECS = ROOT / "specs"
WEB = ROOT / "web"
TABLE = ROOT / "knowledge" / "process" / "phases.tsv"
APPROVE = ROOT / "bin" / "approve.sh"
REVISE = ROOT / "bin" / "revise.sh"
RUN = ROOT / "bin" / "run.sh"

# A story id becomes a path segment under specs/. Anything outside this set is
# refused before it reaches the filesystem or an argv.
STORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# The columns of phases.tsv, in order. The file's own header comment is the
# authority; this only names them.
COLUMNS = ("phase", "kind", "actor", "gate", "on_pass",
           "on_branch", "on_fail", "human_gate_key", "log", "interactive")

# The router. AHOY_TICK points the session at a stand-in instead - useful for
# trying the interactive panel before the real router is wired up, since the
# tick.sh in this sandbox is a stub that prints and exits.
TICK = Path(os.environ.get("AHOY_TICK") or (ROOT / "bin" / "tick.sh"))

SCRIPT_TIMEOUT = 60  # seconds; --no-continue means these return promptly
SESSION_IDLE_POLL = 20  # seconds between SSE heartbeats while the agent thinks

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


# --------------------------------------------------------------- phase table

def load_table():
    """Parse phases.tsv into row dicts, in file order.

    Read on every request rather than cached: the table is nine lines, and a
    UI that shows a stale pipeline after someone edits the table is worse than
    a UI that re-reads it.
    """
    rows = []
    if not TABLE.is_file():
        return rows
    for line in TABLE.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        parts += [""] * (len(COLUMNS) - len(parts))
        rows.append(dict(zip(COLUMNS, (p.strip() for p in parts))))
    return rows


def mainline(rows):
    """The phases a story passes through on the happy path, in order.

    Walked from the first row by following on_pass, so `rework` (reached only
    by a gate branching) and `blocked` (reached only by a failure) stay off the
    strip, and a reordered table reorders the UI without a code change.
    """
    if not rows:
        return []
    by_phase = {r["phase"]: r for r in rows}
    order, seen = [], set()
    cur = rows[0]["phase"]
    while cur and cur != "-" and cur in by_phase and cur not in seen:
        seen.add(cur)
        order.append(cur)
        cur = by_phase[cur].get("on_pass", "")
    return order


def human_gates(rows):
    """The phases only a human can move, keyed by phase."""
    gates = {}
    for r in rows:
        if r["kind"] == "human" and r["human_gate_key"]:
            key = r["human_gate_key"]
            gates[r["phase"]] = {
                "phase": r["phase"],
                "key": key,
                # `plan_accepted` -> `plan`, the short name the scripts document
                "short": key[:-len("_accepted")] if key.endswith("_accepted") else key,
            }
    return gates


def terminal_phases(rows):
    return [r["phase"] for r in rows if r["kind"] == "terminal"]


# -------------------------------------------------------------------- stories

def story_state_path(story_id):
    """Validated path to a story's state.json, or None."""
    if not STORY_RE.match(story_id or ""):
        return None
    path = (SPECS / story_id / "state.json").resolve()
    try:
        path.relative_to(SPECS.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def read_state(story_id):
    path = story_state_path(story_id)
    if path is None:
        return None, None
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except (OSError, ValueError) as exc:
        # A malformed state.json is worth showing, not hiding behind a 500.
        return None, str(exc)


def collect_timestamps(state):
    """Every timestamp a story carries, so the list can show a real `updated`."""
    stamps = []
    for entry in as_list(state.get("gate_results")) + as_list(state.get("decision_log")):
        if isinstance(entry, dict) and isinstance(entry.get("timestamp"), str):
            stamps.append(entry["timestamp"])
    gates = state.get("human_gates")
    if isinstance(gates, dict):
        for gate in gates.values():
            if isinstance(gate, dict) and isinstance(gate.get("timestamp"), str):
                stamps.append(gate["timestamp"])
    return stamps


def as_list(value):
    return value if isinstance(value, list) else []


def gate_decision(state, key):
    """The recorded decision at a gate, or None.

    approve.sh writes {status, timestamp}; anything else in that slot is the
    hand-edit the script exists to prevent, so it is reported as malformed
    rather than coerced into looking like a decision.
    """
    gates = state.get("human_gates")
    if not isinstance(gates, dict) or key not in gates:
        return None
    value = gates[key]
    if isinstance(value, dict):
        status = value.get("status")
        # `pending` is the template's placeholder for "nobody has decided yet",
        # which is the opposite of a recorded decision. bin/approve.sh draws
        # exactly this distinction - see the comment above its `existing` check,
        # written after the same confusion cost two hand-edits - and this has to
        # agree with it. Reporting it as a decision makes the panel say
        # "already recorded", then disable every button on a gate nobody has
        # touched, which locks the story out of the UI that exists to decide it.
        if status in (None, "", "pending"):
            return None
        return {"status": status,
                "timestamp": value.get("timestamp"),
                "reason": value.get("reason")}
    return {"status": "malformed", "timestamp": None, "reason": None}


def reopenable_gate(rows, gates_by_phase, phase):
    """The human gate a terminal `phase` was reached through, or None.

    revise.sh calls this reopening, and it is the ordinary case rather than an
    exotic one: `done` is terminal, but "I tested it and found a bug" is the
    most common thing that happens to a delivery. The gate that passed the
    story into `done` can therefore take it back.

    Derived from on_pass rather than named, exactly as the script derives it, so
    a reordered table cannot leave this offering rework on a phase revise.sh
    would refuse. Returns None at every non-terminal phase - a story still at a
    live gate is sent back through the decision panel, not reopened.
    """
    if phase not in terminal_phases(rows):
        return None
    for row in rows:
        if row["phase"] in gates_by_phase and row.get("on_pass") == phase:
            return gates_by_phase[row["phase"]]
    return None


def summarise(story_id, state, gates_by_phase, order):
    phase = state.get("phase") or "unknown"
    gate = gates_by_phase.get(phase)
    decided = gate_decision(state, gate["key"]) if gate else None
    stamps = collect_timestamps(state)
    return {
        "story_id": state.get("story_id") or story_id,
        "dir": story_id,
        "phase": phase,
        "title": state.get("title"),
        "criteria_count": len(as_list(state.get("acceptance_criteria"))),
        "updated": max(stamps) if stamps else None,
        # Awaiting a human means: at a human phase, with nothing recorded yet.
        "awaiting": bool(gate and decided is None),
        "gate": gate,
        "phase_index": order.index(phase) if phase in order else len(order),
    }


def list_stories():
    rows = load_table()
    order = mainline(rows)
    gates_by_phase = human_gates(rows)
    terminal = set(terminal_phases(rows))

    stories, broken = [], []
    if SPECS.is_dir():
        for entry in sorted(SPECS.iterdir()):
            if not entry.is_dir() or not (entry / "state.json").is_file():
                continue
            state, error = read_state(entry.name)
            if state is None:
                broken.append({"dir": entry.name, "error": error or "unreadable"})
                continue
            stories.append(summarise(entry.name, state, gates_by_phase, order))

    def sort_key(s):
        # Anything a human is holding up comes first - those are the only ones
        # that need something. Then live work in pipeline order, then finished.
        return (0 if s["awaiting"] else 1,
                1 if s["phase"] in terminal else 0,
                s["phase_index"],
                s["story_id"])

    stories.sort(key=sort_key)
    return {"stories": stories, "unreadable": broken}


def read_story(story_id):
    state, error = read_state(story_id)
    if state is None:
        return None, error

    rows = load_table()
    gates_by_phase = human_gates(rows)
    phase = state.get("phase") or "unknown"
    gate = gates_by_phase.get(phase)
    # Only one of the two is ever set: `gate` is a decision waiting to be made,
    # `reopen` is one already made that can be taken back.
    reopen = reopenable_gate(rows, gates_by_phase, phase) if gate is None else None
    counted = gate or reopen

    plan = {"path": state.get("plan_path"), "text": None, "error": None}
    if isinstance(plan["path"], str) and plan["path"]:
        plan.update(read_repo_text(plan["path"]))

    ticket = {"path": f"specs/{story_id}/jira-source.md", "text": None, "error": None}
    ticket.update(read_repo_text(ticket["path"]))

    # Whether a router is attached to this story right now. The page needs it to
    # decide whether to offer to continue a stalled story: offering that while
    # one is already running would start a second router over the same specs
    # directory, and the two would fight over state.json.
    live = session_for(story_id)

    return {
        "story_id": state.get("story_id") or story_id,
        "dir": story_id,
        "state": state,
        "plan": plan,
        "ticket": ticket,
        "gate": gate,
        "reopen": reopen,
        "running": bool(live and not live.closed),
        "decision": gate_decision(state, gate["key"]) if gate else None,
        # Counted against whichever gate is in play, so reopening a delivered
        # story is bounded by the same ceiling revise.sh enforces rather than
        # appearing to start from zero.
        "revisions_used": (state.get("revisions") or {}).get(counted["key"], 0) if counted else 0,
        "revision_ceiling": state.get("revision_ceiling", 4),
    }, None


def read_repo_text(rel_path):
    """Read a repo-relative text file. Never escapes the repository."""
    if os.path.isabs(rel_path) or ".." in Path(rel_path).parts:
        return {"error": "path outside the repository"}
    path = (ROOT / rel_path).resolve()
    try:
        path.relative_to(ROOT)
    except ValueError:
        return {"error": "path outside the repository"}
    if not path.is_file():
        return {"error": "not found"}
    try:
        return {"text": path.read_text(encoding="utf-8", errors="replace")}
    except OSError as exc:
        return {"error": str(exc)}


# -------------------------------------------------------------------- actions

def resolve_gate(gate_arg):
    """Map whatever the client sent to a human_gate_key from the table.

    The table decides what is real, exactly as the scripts do - the client
    cannot name a gate the process does not have.
    """
    rows = load_table()
    for r in rows:
        if r["kind"] != "human" or not r["human_gate_key"]:
            continue
        key = r["human_gate_key"]
        short = key[:-len("_accepted")] if key.endswith("_accepted") else key
        if gate_arg in (key, short, r["phase"]):
            return key
    return None


def run_script(script, args):
    """Run one of the decision scripts and report exactly what it said.

    Exit code and stderr are returned untouched. A refusal (1) is information:
    the script explains itself, and the explanation is the useful part.
    """
    if not script.is_file():
        return {"exit_code": 2, "stdout": "", "stderr": f"{script} not found",
                "command": f"{script.name} {' '.join(args)}"}

    argv = [str(script)] + args
    # A fresh clone may not carry the exec bit; bash runs it either way.
    if not os.access(str(script), os.X_OK):
        argv = ["bash"] + argv
    display = " ".join(["bin/" + script.name] + args)

    try:
        proc = subprocess.run(
            argv, cwd=str(ROOT), capture_output=True, text=True,
            timeout=SCRIPT_TIMEOUT, stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        # No bash, or no interpreter for the shebang.
        return {"exit_code": 2, "stdout": "", "stderr": f"cannot run {script.name}: {exc}",
                "command": display}
    except subprocess.TimeoutExpired:
        return {"exit_code": None, "stdout": "",
                "stderr": (f"{script.name} did not finish in {SCRIPT_TIMEOUT}s. "
                           "If it is waiting on the router, --no-continue was lost."),
                "command": display}

    return {"exit_code": proc.returncode, "stdout": proc.stdout,
            "stderr": proc.stderr, "command": display}


# ------------------------------------------------------------------- sessions

class Session:
    """One run of the router, attached to a pseudo-terminal.

    The UI does not run the agent. It runs bin/tick.sh, which already knows how
    to run cartographer interactively, and bridges that terminal to the browser.
    That keeps a single way of invoking an agent - a second one would drift from
    the router's, and the two would disagree about what an agent run means.

    Output is kept in full rather than streamed-and-forgotten, so a reconnecting
    browser (a reload, a closed laptop) can replay the conversation from the top
    instead of rejoining a transcript it has already lost the start of.
    """

    def __init__(self, story_id):
        if pty is None:
            raise RuntimeError("interactive sessions need a POSIX pty; run the server under WSL")

        self.story_id = story_id
        self.started = time.time()
        self.exit_code = None
        self.closed = False
        self.chunks = []

        self._cond = threading.Condition()
        self._master, slave = pty.openpty()

        # Turn off the terminal's own echo. A real terminal echoes what you type
        # because you are looking at it; here the browser is, and the transcript
        # marks your lines with "> " itself. Left on, every answer appears twice
        # and the second copy is indistinguishable from something the agent said.
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO  # lflag
        termios.tcsetattr(slave, termios.TCSANOW, attrs)

        # start_new_session gives the child its own process group, so stopping
        # the session kills the agent too rather than orphaning it.
        #
        # HARNESS_NO_MENU is what stops the browser having two of everything.
        # tick.sh offers its 1/2/3/4 gate menu whenever stdin is a tty, and this
        # is a pty, so without it the terminal panel prints a menu for the same
        # decision the page is already showing buttons for. Worse than the
        # duplication: that menu blocks on /dev/tty, which nothing here can ever
        # answer, so the session stays alive holding the story. The next router
        # start is then refused as "already running", and an approval that was
        # recorded correctly appears to do nothing. Suppressed, tick.sh prints
        # the decision it is waiting on and exits, which is what the page wants.
        self.proc = subprocess.Popen(
            [str(TICK), story_id, "--wait"],
            cwd=str(ROOT), stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True, close_fds=True,
            env={**os.environ, "TERM": "dumb", "NO_COLOR": "1",
                 "HARNESS_NO_MENU": "1"},
        )
        os.close(slave)

        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        """Drain the terminal until the child closes it, then reap the child."""
        while True:
            try:
                data = os.read(self._master, 4096)
            except OSError:
                break  # the child closed the pty
            if not data:
                break
            self._append(data.decode("utf-8", "replace"))

        self.proc.wait()
        with self._cond:
            self.exit_code = self.proc.returncode
            self.closed = True
            self._cond.notify_all()

    def _append(self, text):
        with self._cond:
            self.chunks.append(text)
            self._cond.notify_all()

    def send(self, text):
        """Answer the agent. A bare newline is a valid answer to a y/n prompt."""
        if self.closed:
            return False
        os.write(self._master, (text + "\n").encode("utf-8"))
        # Echo it into the transcript: the browser is not a terminal, so nothing
        # else puts what you typed in front of you.
        self._append(f"\n> {text}\n")
        return True

    def read_from(self, index, timeout):
        """Chunks after `index`, waiting up to `timeout` for the next one."""
        with self._cond:
            if index >= len(self.chunks) and not self.closed:
                self._cond.wait(timeout)
            return self.chunks[index:], len(self.chunks), self.closed, self.exit_code

    def stop(self):
        if self.closed:
            return
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def status(self):
        return {
            "story": self.story_id,
            "running": not self.closed,
            "exit_code": self.exit_code,
            "started": self.started,
            "chunks": len(self.chunks),
        }


SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


def session_for(story_id):
    with SESSIONS_LOCK:
        return SESSIONS.get(story_id)


def start_session(story_id):
    """Start a router run, unless one is already live for this story."""
    with SESSIONS_LOCK:
        existing = SESSIONS.get(story_id)
        if existing and not existing.closed:
            return 409, {"error": f"a session for {story_id} is already running",
                         "session": existing.status()}
        try:
            session = Session(story_id)
        except (RuntimeError, OSError) as exc:
            return 500, {"error": str(exc)}
        SESSIONS[story_id] = session
        return 200, {"session": session.status()}


def do_action(kind, payload):
    story_id = payload.get("story")
    if not STORY_RE.match(story_id or ""):
        return 400, {"error": "invalid story id"}

    state, error = read_state(story_id)
    if state is None:
        return 404, {"error": error or f"no story {story_id}"}

    gate_key = resolve_gate(payload.get("gate") or "")
    if gate_key is None:
        return 400, {"error": f"'{payload.get('gate')}' is not a human gate in phases.tsv"}

    reason = (payload.get("reason") or "").strip()

    if kind == "approve":
        # Approvals record no reason - approve.sh only attaches one to a
        # rejection - so a note typed here would be silently dropped.
        result = run_script(APPROVE, [story_id, gate_key, "--no-continue"])
    elif kind == "reject":
        args = [story_id, gate_key, "--reject"]
        if reason:
            args.append(reason)  # must follow --reject immediately
        args.append("--no-continue")
        result = run_script(APPROVE, args)
    elif kind == "revise":
        # `--` last: everything after it is the reason, so a reason that looks
        # like a flag is still a reason.
        result = run_script(REVISE, [story_id, gate_key, "--no-continue", "--", reason])
    else:
        return 404, {"error": "unknown action"}

    result["ok"] = result["exit_code"] == 0
    result["gate"] = gate_key
    result["story"] = story_id
    return 200, result


def do_run(payload):
    """Start a story, or pick a stalled one back up: bin/run.sh.

    Not part of do_action, and not because it would be inconvenient there: both
    of that function's opening guards would refuse this call. There is no gate
    to resolve, and the story named here usually does not exist yet - which is
    the entire point of the request.

    THE KEY IS NOT VALIDATED HERE beyond the path-safety check every story id
    gets. start.sh owns the rule that a story id must be a well-formed Jira key,
    and it refuses a bad one with an explanation written for a human. Repeating
    that rule here would give this app a second opinion about what a valid key
    is, and the two would eventually disagree.

    --no-continue for the same reason every other script gets it: run.sh ends by
    exec'ing the router, and an HTTP request that blocks for the length of an
    agent run is a request that times out. The browser starts the router itself,
    on a terminal it can stream.
    """
    story_id = (payload.get("story") or "").strip()
    if not STORY_RE.match(story_id):
        return 400, {"error": "invalid story id"}

    # Asked before the script runs, because afterwards it is always true. It is
    # the difference between "created" and "resumed", which is the one thing the
    # caller cannot work out from an exit code of 0.
    existed = story_state_path(story_id) is not None

    result = run_script(RUN, [story_id, "--no-continue"])
    result["ok"] = result["exit_code"] == 0
    result["story"] = story_id
    result["existed"] = existed
    return 200, result


# --------------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "ahoy-ui"
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = unquote(urlparse(self.path).path)

        if path == "/api/phases":
            rows = load_table()
            return self.send_json(200, {
                "rows": rows,
                "mainline": mainline(rows),
                "human_gates": human_gates(rows),
                "terminal": terminal_phases(rows),
            })

        if path == "/api/stories":
            return self.send_json(200, list_stories())

        if path.startswith("/api/story/"):
            story_id = path[len("/api/story/"):].strip("/")
            if not STORY_RE.match(story_id or ""):
                return self.send_json(400, {"error": "invalid story id"})
            story, error = read_story(story_id)
            if story is None:
                return self.send_json(404, {"error": error or f"no story {story_id}"})
            return self.send_json(200, story)

        if path.startswith("/api/session/"):
            story_id, _, tail = path[len("/api/session/"):].partition("/")
            if not STORY_RE.match(story_id or ""):
                return self.send_json(400, {"error": "invalid story id"})
            session = session_for(story_id)
            if tail == "stream":
                if session is None:
                    return self.send_json(404, {"error": "no session for this story"})
                return self.stream_session(session)
            if tail == "":
                return self.send_json(200, {"session": session.status() if session else None})
            return self.send_json(404, {"error": "no such endpoint"})

        if path.startswith("/api/"):
            return self.send_json(404, {"error": "no such endpoint"})

        return self.send_static(path)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        session_route = path.startswith("/api/session/")

        if not session_route and path not in ("/api/approve", "/api/reject", "/api/revise",
                                              "/api/run"):
            return self.send_json(404, {"error": "no such endpoint"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json(400, {"error": "bad Content-Length"})
        if length > 64 * 1024:
            return self.send_json(413, {"error": "body too large"})

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "body is not JSON"})
        if not isinstance(payload, dict):
            return self.send_json(400, {"error": "body is not an object"})

        if session_route:
            status, body = self.session_command(path, payload)
            return self.send_json(status, body)

        # Dispatched by name rather than falling through to do_action, which
        # reads the last path segment as a decision about an existing story.
        if path == "/api/run":
            status, body = do_run(payload)
            return self.send_json(status, body)

        status, body = do_action(path.rsplit("/", 1)[1], payload)
        return self.send_json(status, body)

    def session_command(self, path, payload):
        """POST /api/session/<story>/{start,input,stop}"""
        story_id, _, tail = path[len("/api/session/"):].partition("/")
        if not STORY_RE.match(story_id or ""):
            return 400, {"error": "invalid story id"}
        if story_state_path(story_id) is None:
            return 404, {"error": f"no story {story_id}"}

        if tail == "start":
            return start_session(story_id)

        session = session_for(story_id)
        if session is None:
            return 404, {"error": "no session for this story"}

        if tail == "input":
            text = payload.get("text")
            if not isinstance(text, str):
                return 400, {"error": "text must be a string"}
            if not session.send(text):
                return 409, {"error": "the session has ended", "session": session.status()}
            return 200, {"session": session.status()}

        if tail == "stop":
            session.stop()
            return 200, {"session": session.status()}

        return 404, {"error": "no such endpoint"}

    def stream_session(self, session):
        """The transcript as Server-Sent Events.

        SSE rather than a WebSocket: the output is one-way and the replies are
        ordinary POSTs, so this needs no handshake, no framing, and nothing
        outside the standard library. Replay starts at chunk 0, so a reload
        rejoins the whole conversation rather than the middle of it.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()

        index = 0
        try:
            while True:
                chunks, index, closed, exit_code = session.read_from(index, SESSION_IDLE_POLL)
                for chunk in chunks:
                    self.send_event("output", {"text": chunk})
                if closed:
                    self.send_event("done", {"exit_code": exit_code})
                    return
                if not chunks:
                    self.wfile.write(b": keep-alive\n\n")  # keeps proxies and browsers happy
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser navigated away; the agent keeps running

    def send_event(self, name, payload):
        body = json.dumps(payload)
        self.wfile.write(f"event: {name}\ndata: {body}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ------------------------------------------------------------- responses

    def send_json(self, status, payload):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        if ".." in Path(rel).parts:
            return self.send_plain(403, "forbidden")

        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self.send_plain(403, "forbidden")
        if not target.is_file():
            return self.send_plain(404, "not found")

        try:
            body = target.read_bytes()
        except OSError as exc:
            return self.send_plain(500, str(exc))

        self.send_response(200)
        self.send_header("Content-Type",
                         CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_plain(self, status, message):
        body = (message + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # One quiet line per request; static assets stay silent.
        if "/api/" in self.path or not self.path.startswith("/"):
            sys.stderr.write("[ahoy] %s\n" % (fmt % args))


def main():
    parser = argparse.ArgumentParser(description="Ahoy UI server (localhost only).")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1",
                        help="default 127.0.0.1; there is no auth, so do not widen it")
    args = parser.parse_args()

    for required in (SPECS, WEB, TABLE):
        if not required.exists():
            sys.exit(f"ahoy: missing {required.relative_to(ROOT)}")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"Ahoy UI on {url}", file=sys.stderr)
    print(f"  specs:  {SPECS}", file=sys.stderr)
    print(f"  phases: {TABLE.relative_to(ROOT)}", file=sys.stderr)
    if not any(os.access(os.path.join(p, "jq"), os.X_OK)
               for p in os.environ.get("PATH", "").split(os.pathsep) if p):
        print("  warning: jq is not on PATH - every action will exit 2.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", file=sys.stderr)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
