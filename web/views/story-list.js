/**
 * The story list. Everything under specs/, with the stories awaiting a human
 * decision grouped at the top - those are the only ones that need anything
 * from you, and the rest are the router's problem.
 *
 * Holds state, so it is a factory rather than a plain view: selecting a story
 * must NOT rebuild the list. Rebuilding would destroy the button the user just
 * clicked and take keyboard focus with it, which is why select() only toggles
 * a class on rows it already has.
 */
import { el, render } from '../core/dom.js';
import { badge } from '../core/ui.js';
import { phases } from '../core/phases.service.js';
import { words, count } from '../core/format.js';

export function createStoryList({ onSelect }) {
  const host = el('div', { class: 'card' });
  const rowsById = new Map();
  let selected = null;

  function setData({ stories = [], unreadable = [] }) {
    rowsById.clear();
    const waiting = stories.filter((story) => story.awaiting);
    const running = stories.filter((story) => !story.awaiting);

    render(host,
      el('div', { class: 'list-head' },
        el('span', { text: `specs/ · ${count(stories.length, 'story', 'stories')}` }),
        waiting.length && el('span', { text: `${waiting.length} waiting` })),

      group('awaiting you', waiting),
      group(waiting.length ? 'running' : null, running),

      !stories.length && el('div', { class: 'row empty', text: 'No stories under specs/.' }),
      unreadable.map(brokenRow),
    );

    applySelection();
  }

  function group(heading, stories) {
    if (!stories.length) return null;
    return [
      heading && el('div', { class: 'list-group', text: heading }),
      stories.map(row),
    ];
  }

  function row(story) {
    const node = el('button', {
      class: 'row',
      type: 'button',
      onClick: () => onSelect(story.dir),
    },
      el('div', { class: 'key', text: story.story_id }),
      el('div', { class: 'sub', text: story.title || 'Untitled' }),
      badge(phases.badgeClass(story.phase), words(story.phase)),
    );

    rowsById.set(story.dir, node);
    return node;
  }

  /** A directory whose state.json would not parse. Shown, not skipped. */
  function brokenRow(entry) {
    return el('div', { class: 'row' },
      el('div', { class: 'key', text: entry.dir }),
      el('div', { class: 'sub', text: 'state.json could not be read' }),
      badge('b-bad', 'unreadable'));
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
