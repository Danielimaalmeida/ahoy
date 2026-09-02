/**
 * The conversation with the agent, while a session is in flight.
 *
 * This is a window onto bin/tick.sh, not a second way to run an agent. The
 * router already knows how to run cartographer interactively - phases.tsv marks
 * `planning` interactive so it can ask questions - and the server bridges that
 * terminal here. Sending a story back is still revise.sh's job: it clears the
 * gate decision, counts the round against the ceiling and moves the phase. Chat
 * that went around it would bypass both, the way hand-editing state.json once
 * bypassed the delivery gate.
 *
 * HOW THIS PANEL IS UNCERTAIN OUT LOUD. Ahoy cannot see whether the agent is
 * reading stdin; the pty never says so. All we have is silence, which is
 * evidence and not proof. So there are two registers and no third:
 *
 *   green   it printed something N seconds ago          - a fact
 *   amber   it has been quiet for N seconds             - a guess, with its
 *                                                         evidence attached
 *
 * There is deliberately no "the agent IS waiting" state, because that would
 * assert something we cannot know.
 *
 * WHAT THE GUESS IS ALLOWED TO CHANGE. The wording, and nothing else. The reply
 * box stays enabled for as long as the process is alive. Previously the idle
 * inference armed the box, which meant a wrong inference took the keyboard away
 * from a terminal that really was waiting - and typing into a pty that is not
 * reading costs nothing, while being unable to type costs the story. Only the
 * session actually ending disables the box, and that is a fact, not a guess.
 *
 * Holds a live connection and a transcript, so it is a factory.
 */
import { el, render } from '../core/dom.js';
import { api } from '../core/api.service.js';
import { phases } from '../core/phases.service.js';
import { words, terminalText, duration, clock } from '../core/format.js';

/**
 * How long the terminal must be quiet before we say so.
 *
 * Ten seconds, not three. Three fires constantly during ordinary work, and a
 * signal that cries wolf every few seconds is one people learn to ignore -
 * which is worse than not having it. Paired with a visible counter this
 * degrades gracefully: at fourteen seconds it is a mild note, at four minutes
 * it reads as concerning, and the UI never had to decide which.
 */
const QUIET_AFTER_MS = 10000;

/** How often the counter re-reads the clock while the terminal is quiet. */
const TICK_MS = 1000;

export function createChatPanel({ onFinished }) {
  const host = el('div');

  let storyId = null;
  let story = null;
  let source = null;
  let attachedStart = null;   // the session.started we are showing
  let session = null;         // the last status we were handed
  let transcript = '';
  let painted = null;         // the transcript the log node currently shows
  let running = false;
  let failed = null;
  let lastOutputAt = 0;        // Date.now() of the last chunk we painted
  let ticker = null;           // repaints the counter while the terminal is quiet

  // Live nodes.
  let card = null;
  let mark = null;
  let claim = null;
  let claimWhy = null;
  let proc = null;
  let lastBlock = null;
  let log = null;
  let input = null;
  let sendButton = null;
  let stopButton = null;
  let status = null;

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
    const { session: started } = await api.startSession(id);
    connect(started);
  }

  async function refresh() {
    let current = null;
    try {
      ({ session: current } = await api.session(storyId));
    } catch {
      render(host);   // the server is unreachable; the detail view says so
      return;
    }

    if (!current) {
      render(host);
      return;
    }
    session = current;
    if (source) return;                          // already streaming this one
    if (current.started === attachedStart) {     // finished, and already shown
      running = current.running;
      build();
      return;
    }
    connect(current);
  }

  function connect(next) {
    session = next;
    attachedStart = next.started;
    transcript = '';
    running = next.running;
    failed = null;
    lastOutputAt = Date.now();
    build();

    source = api.streamSession(storyId, {
      onOutput(chunk) {
        transcript += chunk;
        lastOutputAt = Date.now();
        paint();
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
    stopTicker();
    if (source) {
      source.close();
      source = null;
    }
  }

  /**
   * Repaint once a second while a session is live.
   *
   * The counter has to keep counting during silence, which is exactly when no
   * output arrives to trigger a repaint. One timer is cheaper than re-arming a
   * timeout on every chunk, and it stops the moment the process does.
   */
  function startTicker() {
    stopTicker();
    if (running) ticker = setInterval(paint, TICK_MS);
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /** How long the terminal has been silent, in milliseconds. */
  function quietFor() {
    return Date.now() - lastOutputAt;
  }

  /** Quiet long enough that it is worth saying so. Never gates the input. */
  function isQuiet() {
    return running && quietFor() >= QUIET_AFTER_MS;
  }

  /**
   * The last non-empty line the agent printed.
   *
   * A question is almost always the final line, and at the bottom of a
   * scrolling transcript it may as well not be there. This is pure
   * presentation - the tail of the stream, unwrapped and unedited. Nothing is
   * parsed and nothing is interpreted: turning `[order/drop]` into two buttons
   * would be the browser deciding what the agent accepts.
   */
  function lastLine() {
    const lines = terminalText(transcript).split('\n').map((l) => l.trimEnd());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim()) return lines[i];
    }
    return '';
  }

  function build() {
    mark = el('span', { class: 'chat-mark' });
    claim = el('h2');
    claimWhy = el('p');
    proc = el('div', { class: 'chat-proc' });

    stopButton = el('button', { class: 'small', type: 'button', text: 'Stop the run', onClick: stop });

    lastBlock = el('div');
    log = el('pre', { class: 'term chat-log' });

    input = el('textarea', {
      rows: '2', class: 'chat-input',
      'aria-label': 'reply to the agent',
      onKeyDown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        send();
      },
    });

    sendButton = el('button', { class: 'primary', type: 'button', text: 'Send', onClick: send });
    status = el('div', { class: 'fine chat-status' });

    card = el('div', { class: 'chat' },
      el('div', { class: 'chat-strip' },
        mark,
        el('div', { class: 'chat-claim' }, claim, claimWhy),
        proc,
        stopButton),
      lastBlock,
      log,
      el('div', { class: 'chat-form-wrap' },
        el('div', { class: 'chat-form' }, input, sendButton),
        status));

    // `log` is a fresh node, so whatever it showed before does not count.
    painted = null;
    render(host, card);
    paint();
    // Here rather than in connect(): refresh() can rebuild an already-attached
    // session without going through connect, and a counter that stopped
    // counting would quietly freeze at whatever it last said.
    startTicker();
  }

  /** The actor comes from the phase table, like everything else about a phase. */
  function actor() {
    const phase = (story && story.state && story.state.phase) || '';
    const row = phases.row(phase);
    return row && row.actor && row.actor !== '-' ? row.actor : 'The router';
  }

  function paint() {
    const quiet = isQuiet();
    const over = !running;

    card.classList.toggle('is-quiet', quiet);
    card.classList.toggle('is-over', over);

    // Only rewrite the transcript when it actually changed. The counter above
    // repaints every second, and re-setting this text would yank the view back
    // to the bottom each time — which makes scrolling back through a long run
    // impossible while the agent is still alive.
    if (transcript !== painted) {
      painted = transcript;
      log.textContent = terminalText(transcript) || 'Waiting for the agent…';
      log.scrollTop = log.scrollHeight;
    }

    // The promoted tail only appears while we are making the quiet claim. At
    // any other time the transcript is the right place for the transcript.
    render(lastBlock, quiet && lastLine() && el('div', { class: 'chat-last' },
      el('div', { class: 'label' }, el('span', { text: 'The last thing it printed' })),
      el('pre', { text: lastLine() })));

    if (over) {
      claim.textContent = failed ? 'The connection dropped' : 'The session has ended';
      claimWhy.textContent = failed
        || 'The router re-gated the story. Whatever it decided is below.';
    } else if (quiet) {
      claim.textContent = `Quiet for ${duration(quietFor())} — it may be waiting for you`;
      claimWhy.textContent = 'Ahoy cannot see whether the agent is reading input. It has '
        + `printed nothing since ${clock(new Date(lastOutputAt).toISOString())}, so this is a `
        + 'guess — a good one, but a guess.';
    } else {
      claim.textContent = `${actor()} is working`;
      claimWhy.textContent = `It printed something ${duration(quietFor())} ago. Nothing is being `
        + 'asked of you — you can close this tab.';
    }

    render(proc, running
      ? [
        el('div', { text: session && session.pid ? `pid ${session.pid} · alive` : 'alive' }),
        el('span', { text: words((story && story.state && story.state.phase) || '') }),
      ]
      : el('span', { text: words((story && story.state && story.state.phase) || '') }));

    // Only a dead process disables the box. The guess above never does.
    input.disabled = over;
    sendButton.disabled = over;
    stopButton.disabled = over;
    input.placeholder = quiet
      ? 'Answer the agent, then press Enter. Shift+Enter for a new line.'
      : 'Type here if you want to interrupt — nothing is sent until you press Send.';

    render(status,
      el('span', {
        text: over
          ? 'Nothing is listening now. The record above is what happened.'
          : quiet
            ? 'Sent to the terminal as typed, with a newline. Nothing is interpreted on the way.'
            : 'The agent has not paused. Anything you send is read whenever it next reads input.',
      }),
      el('span', { class: 'mono muted', text: 'draft kept through refresh' }));
  }

  async function send() {
    const text = input.value;
    if (!running) return;
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
