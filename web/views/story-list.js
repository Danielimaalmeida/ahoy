/**
 * The story list. Everything under specs/, in four groups.
 *
 * THREE SIGNALS PER ROW, and they are redundant on purpose. Which group it is
 * in answers "does this want me". The third line answers "is it moving", in
 * words rather than a badge. The left edge repeats both in colour, so losing
 * any one of them still leaves the row readable.
 *
 * WHY `stopped moving` IS ITS OWN GROUP. A phase badge cannot tell you whether
 * a process is alive. `implementation` looks identical whether a fixer is
 * working or a laptop was shut three hours ago, and those are the two states a
 * person most needs to tell apart — one wants patience, the other wants a
 * click. The server now reports `running` per story, so the list can say it.
 *
 * Holds state, so it is a factory rather than a plain view: selecting a story
 * must NOT rebuild the list. Rebuilding would destroy the button the user just
 * clicked and take keyboard focus with it, which is why select() only toggles
 * a class on rows it already has.
 */
import { el, render } from '../core/dom.js';
import { phases } from '../core/phases.service.js';
import { words, count, clock, since, duration, ageMs } from '../core/format.js';

const HEADINGS = {
  waiting: 'waiting on you',
  running: 'running',
  stopped: 'stopped moving',
  done: 'finished',
};

export function createStoryList({ onSelect }) {
  const host = el('div', { class: 'card' });
  const rowsById = new Map();
  let selected = null;

  function setData({ stories = [], unreadable = [] }) {
    rowsById.clear();

    const grouped = { waiting: [], running: [], stopped: [], done: [] };
    for (const story of stories) grouped[phases.groupOf(story)].push(story);

    render(host,
      el('div', { class: 'list-head' },
        el('span', { text: `specs/ · ${count(stories.length, 'story', 'stories')}` }),
        grouped.waiting.length && el('span', { text: `${grouped.waiting.length} waiting` })),

      Object.keys(HEADINGS).map((kind) => group(kind, grouped[kind])),

      !stories.length && el('div', { class: 'row empty', text: 'No stories under specs/.' }),
      unreadable.map(brokenRow),
    );

    applySelection();
  }

  function group(kind, stories) {
    if (!stories.length) return null;
    return [
      el('div', { class: ['list-group', kind === 'stopped' && 'g-stopped'] },
        el('span', { text: HEADINGS[kind] }),
        el('span', { text: String(stories.length) })),
      stories.map((story) => row(story, kind)),
    ];
  }

  function row(story, kind) {
    const node = el('button', {
      class: `row r-${kind}`,
      type: 'button',
      onClick: () => onSelect(story.dir),
    },
      el('div', { class: 'key', text: story.story_id }),
      el('div', { class: 'sub', text: story.title || 'Untitled' }),
      el('div', { class: `row-meta m-${metaClass(story, kind)}`, text: meta(story, kind) }),
    );

    rowsById.set(story.dir, node);
    return node;
  }

  function metaClass(story, kind) {
    if (kind === 'waiting') return phases.isHalt(story.phase) ? 'bad' : 'waiting';
    return kind;
  }

  /**
   * The third line, in words.
   *
   * Absolute time plus elapsed, never elapsed alone: a figure that changes
   * every second re-renders on every poll and reads as motion where there is
   * none. `duration` is coarse for the same reason.
   */
  function meta(story, kind) {
    const phase = words(story.phase);
    const age = ageMs(story.updated);

    if (kind === 'waiting') {
      if (phases.isHalt(story.phase)) {
        return age === null ? phase : `${phase} · ${since(story.updated)}`;
      }
      return age === null ? `${phase} · waiting on you`
                          : `${phase} · since ${clock(story.updated)} (${duration(age)})`;
    }
    if (kind === 'running') return `${phase} · running`;
    if (kind === 'stopped') {
      return story.updated ? `${phase} · nothing running since ${clock(story.updated)}`
                           : `${phase} · nothing running`;
    }
    return story.updated ? `delivered ${since(story.updated)}` : 'delivered';
  }

  /**
   * A directory whose state.json would not parse. Shown, in the story-shaped
   * place a story would be — a directory that cannot be read is a story you
   * are not seeing, and hiding it in a toast would be a lie of omission.
   */
  function brokenRow(entry) {
    return el('div', { class: 'row-broken' },
      el('div', { class: 'key', text: '1 directory could not be read' }),
      el('div', { class: 'mono muted', text: `specs/${entry.dir}/` }),
      el('div', { class: 'row-meta m-bad', text: entry.error || 'unreadable' }));
  }

  function applySelection() {
    for (const [id, node] of rowsById) {
      const on = id === selected;
      node.classList.toggle('on', on);
      if (on) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
  }

  return {
    host,
    setData,
    select(id) {
      selected = id;
      applySelection();
    },
  };
}
