/** Small display helpers. No state, no DOM. */

/** `plan_review` -> `plan review`. Phase and status names are snake_case. */
export function words(value) {
  return String(value || '').replace(/_/g, ' ');
}

/** An ISO-8601 UTC stamp as something readable, or the raw string if it is not one. */
export function stamp(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Commit shas are shown short; the full value stays in the title attribute. */
export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : '';
}

/** `1 story` / `3 stories`, without the bare-number-plus-noun awkwardness. */
export function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Always an array, whatever the key held or did not hold. */
export function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Terminal output as readable text.
 *
 * The agent writes to a pty, so it may colour its output and it ends lines with
 * CRLF. Strip the escape sequences and normalise the line endings; a lone \r is
 * a progress redraw, which a transcript cannot honour, so the line it was
 * rewriting is dropped in favour of the last one it drew.
 */
export function terminalText(raw) {
  return String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')  // OSC (window titles)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[[\]()#;?]*[0-9;]*[A-Za-z]/g, '')     // CSI and friends
    .replace(/\r\n/g, '\n')
    .replace(/^.*\r(?!\n)/gm, '');
}

/** Colour class for a work package / repo / gate status. */
export function statusClass(status) {
  switch (status) {
    case 'done': case 'ready': case 'pass': case 'approved': case 'met':
      return 'b-ok';
    case 'failed': case 'fail': case 'blocked': case 'rejected': case 'not_met': case 'malformed':
      return 'b-bad';
    case 'in_progress': case 'pending':
      return 'b-acc';
    case 'unverified': case 'partially_met': case 'untestable':
      return 'b-warn';
    default:
      return 'b-mute';
  }
}

/** Colour class for a lookout finding's severity. */
export function severityClass(severity) {
  switch (severity) {
    case 'blocking': return 'b-bad';
    case 'major': return 'b-warn';
    case 'minor': return 'b-acc';
    default: return 'b-mute';
  }
}
