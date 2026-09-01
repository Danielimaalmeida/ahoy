/**
 * The only place this app talks to the server.
 *
 * Actions return the script's own exit code and stderr rather than throwing on
 * a non-zero status: a refusal from approve.sh is information the human needs
 * to read, not an error to swallow. Only transport failures reject.
 */

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function json(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    throw new HttpError(`cannot reach the server (${cause.message}). Is run.sh still running?`, 0);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError((body && body.error) || `${response.status} ${response.statusText}`,
                        response.status);
  }
  return body;
}

class ApiService {
  /** The phase table, plus the mainline and human gates derived from it. */
  phases() {
    return json('/api/phases');
  }

  /** Every directory under specs/, ordered with human-blocked stories first. */
  stories() {
    return json('/api/stories');
  }

  /** One story: its state.json, its plan and its ticket as text. */
  story(id) {
    return json(`/api/story/${encodeURIComponent(id)}`);
  }

  /**
   * Record a decision. `action` is approve | reject | revise.
   * Resolves with { ok, exit_code, stdout, stderr, command } - a refusal
   * (exit 1) resolves like any other outcome.
   */
  decide(action, { story, gate, reason }) {
    return post(`/api/${action}`, { story, gate, reason: reason || '' });
  }

  /**
   * Start a story, or pick a stalled one back up — bin/run.sh, the harness's
   * own entry point. Resolves with { ok, exit_code, stdout, stderr, command,
   * existed }; a refusal (a malformed key, a broken harness) resolves like any
   * other outcome, because the script's explanation is the useful part.
   */
  run(story) {
    return post('/api/run', { story });
  }

  // ------------------------------------------------------ router sessions

  /** The live or last router run for a story: { session: null | {...} }. */
  session(story) {
    return json(`/api/session/${encodeURIComponent(story)}`);
  }

  /** Run the router. It is the router, not this app, that runs the agent. */
  startSession(story) {
    return post(`/api/session/${encodeURIComponent(story)}/start`, {});
  }

  /** Answer the agent's question. */
  sendInput(story, text) {
    return post(`/api/session/${encodeURIComponent(story)}/input`, { text });
  }

  stopSession(story) {
    return post(`/api/session/${encodeURIComponent(story)}/stop`, {});
  }

  /**
   * Subscribe to a session's transcript. Replays from the beginning, so a
   * reload rejoins the whole conversation rather than the middle of it.
   * Returns the EventSource; the caller closes it.
   */
  streamSession(story, { onOutput, onDone, onError }) {
    const source = new EventSource(`/api/session/${encodeURIComponent(story)}/stream`);
    source.addEventListener('output', (event) => onOutput(JSON.parse(event.data).text));
    source.addEventListener('done', (event) => onDone(JSON.parse(event.data)));
    source.onerror = () => onError();
    return source;
  }
}

function post(path, body) {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = new ApiService();
