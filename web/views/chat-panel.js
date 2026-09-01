/**
 * The conversation with the agent, while a revision round is in flight.
 *
 * This is a window onto bin/tick.sh, not a second way to run an agent. The
 * router already knows how to run cartographer interactively - phases.tsv marks
 * `planning` interactive so it can ask questions - and the server bridges that
 * terminal here. Sending a story back is still revise.sh's job: it clears the
 * gate decision, counts the round against the ceiling and moves the phase. Chat
 * that went around it would bypass both, the way hand-editing state.json once
 * bypassed the delivery gate.
 *
 * Holds a live connection and a transcript, so it is a factory.
 */
import { el, render } from '../core/dom.js';
import { panel, badge, muted } from '../core/ui.js';
import { api } from '../core/api.service.js';
import { phases } from '../core/phases.service.js';
import { words, terminalText } from '../core/format.js';

/**
 * How long the terminal has to sit silent before we believe the agent is
 * actually waiting on the user, rather than mid-thought. `running` only
 * tells us the router process is alive - during planning it stays alive for
 * minutes while cartographer works, so it cannot gate the input box. This is
 * a guess, not a signal from the process: the agent never tells us it is
 * about to read stdin, so we infer it from a quiet terminal instead.
 */
const IDLE_AFTER_MS = 3000;

export function createChatPanel({ onFinished }) {
  const host = el('div');

  let storyId = null;
  let story = null;
  let source = null;
  let attachedStart = null;   // the session.started we are showing
  let transcript = '';
  let running = false;
  let failed = null;
  let lastOutputAt = 0;        // Date.now() of the last chunk we painted
  let idleTimer = null;        // fires paint() once the silence crosses IDLE_AFTER_MS

  // Live nodes.
  let card = null;
  let log = null;
  let input = null;
  let sendButton = null;
  let stopButton = null;
  let status = null;
  let asideSlot = null;

  /** Called on every story load. Attaches to a session if there is one. */
  async function setStory(next) {
    if (next.dir !== storyId) {
      close();
      storyId = next.dir;
      attachedStart = null;
      transcript = '';
      running = false;
      failed = null;
    }
    story = next;
    await refresh();
  }

  /** Start a router run and attach to it. Called after a successful revise. */
  async function begin(id) {
    storyId = id;
    close();
    const { session } = await api.startSession(id);
    connect(session);
  }

  async function refresh() {
    let session = null;
    try {
      ({ session } = await api.session(storyId));
    } catch {
      render(host);   // the server is unreachable; the detail view says so
      return;
    }

    if (!session) {
      render(host);
      return;
    }
    if (source) return;                          // already streaming this one
    if (session.started === attachedStart) {     // finished, and already shown
      build();
      return;
    }
    connect(session);
  }

  function connect(session) {
    attachedStart = session.started;
    transcript = '';
    running = session.running;
    failed = null;
    lastOutputAt = Date.now();
    build();
    scheduleIdleCheck();

    source = api.streamSession(storyId, {
      onOutput(chunk) {
        transcript += chunk;
        lastOutputAt = Date.now();
        paint();
        scheduleIdleCheck();
      },
      onDone({ exit_code: code }) {
        running = false;
        close();
        paint();
        // The router has moved the phase and rewritten the plan; what this page
        // holds is stale by definition.
        onFinished(code);
      },
      onError() {
        if (!running) return close();   // the stream ended normally
        failed = 'The connection to the session dropped. The agent is still running — reload to rejoin.';
        close();
        paint();
      },
    });
  }

  function close() {
    clearIdleCheck();
    if (source) {
      source.close();
      source = null;
    }
  }

  /** Re-arms the timer that flips the input from "working" to "waiting". */
  function scheduleIdleCheck() {
    clearIdleCheck();
    if (!running) return;
    const remaining = IDLE_AFTER_MS - (Date.now() - lastOutputAt);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      paint();
    }, Math.max(remaining, 0));
  }

  function clearIdleCheck() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** True once the terminal has been quiet long enough to trust it is idle. */
  function isWaiting() {
    return running && (Date.now() - lastOutputAt >= IDLE_AFTER_MS);
  }

  function build() {
    log = el('pre', { class: 'doc chat-log' });

    input = el('textarea', {
      rows: '2', class: 'chat-input',
      placeholder: 'Answer the agent, then press Enter. Shift+Enter for a new line.',
      'aria-label': 'reply to the agent',
      onKeyDown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        send();
      },
    });

    sendButton = el('button', { class: 'primary', type: 'button', text: 'Send', onClick: send });
    stopButton = el('button', { class: 'danger', type: 'button', text: 'Stop', onClick: stop });
    status = el('div', { class: 'fine chat-status' });
    asideSlot = el('span');

    card = panel({ title: title(), aside: asideSlot },
      log,
      el('div', { class: 'chat-form' }, input, sendButton, stopButton),
      status);

    render(host, card);

    paint();
  }

  /** The actor comes from the phase table, like everything else about a phase. */
  function title() {
    const phase = (story && story.state && story.state.phase) || '';
    const row = phases.row(phase);
    const actor = row && row.actor && row.actor !== '-' ? row.actor : 'the router';
    return `${actor} · ${words(phase || 'session')}`;
  }

  function stateBadge() {
    if (running) return badge('b-warn', 'running');
    if (failed) return badge('b-bad', 'disconnected');
    return badge('b-ok', 'finished');
  }

  function paint() {
    log.textContent = terminalText(transcript) || 'Waiting for the agent…';
    log.scrollTop = log.scrollHeight;

    const waiting = isWaiting();
    input.disabled = !waiting;
    sendButton.disabled = !waiting;
    stopButton.disabled = !running;   // killing a busy agent is always legitimate

    // `live` lifts the panel out of the page while something is actually
    // happening; `waiting` is the state that asks something of you, so it is
    // the louder of the two. Both come off when the session ends and the panel
    // becomes a transcript like any other record on the page.
    card.classList.toggle('live', running);
    card.classList.toggle('waiting', waiting);
    status.classList.toggle('waiting', waiting);

    render(asideSlot, stateBadge());

    status.textContent = failed
      ? failed
      : running
        ? waiting
          ? 'The agent is waiting for you. Send a reply and it will read it.'
          : "Working — the agent isn't reading input yet."
        : 'The session has ended. The router re-gated the plan; the decision is below.';
  }

  async function send() {
    const text = input.value;
    if (!isWaiting()) return;
    input.value = '';
    try {
      await api.sendInput(storyId, text);
    } catch (error) {
      failed = `Could not reach the session: ${error.message}`;
      paint();
    }
  }

  async function stop() {
    try {
      await api.stopSession(storyId);
    } catch {
      // The stream's done event reports the outcome either way.
    }
  }

  return { host, setStory, begin };
}
