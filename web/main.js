/**
 * Bootstrap and routing.
 *
 * The whole app is one page with a hash route (#/DEMO-101) so a reload, a
 * bookmark or a back button all land on the story you were looking at.
 */
import { render } from './core/dom.js';
import { api } from './core/api.service.js';
import { phases } from './core/phases.service.js';
import { createStoryList } from './views/story-list.js';
import { createNewStoryPanel } from './views/new-story-panel.js';
import { createDecisionPanel } from './views/decision-panel.js';
import { createReworkPanel } from './views/rework-panel.js';
import { createResumePanel } from './views/resume-panel.js';
import { createChatPanel } from './views/chat-panel.js';
import { storyDetail, detailPlaceholder, unreadableDetail } from './views/story-detail.js';
import { documentState, applyDocumentState } from './views/document-panel.js';

const refs = {
  list: document.querySelector('[data-ref="list"]'),
  detail: document.querySelector('[data-ref="detail"]'),
  status: document.querySelector('[data-ref="status"]'),
};

const storyList = createStoryList({ onSelect: (id) => { location.hash = `#/${id}`; } });
const newStoryPanel = createNewStoryPanel({ onStart: startStory });
const decisionPanel = createDecisionPanel({ onDecide: decide });
// Reopening a finished story is the same verb as sending one back from its
// gate, so it goes through the same call: revise.sh, then continue the router.
const reworkPanel = createReworkPanel({
  onRework: (reason, gate) => decide('revise', reason, gate),
});
// Resuming a stalled story is the same call as starting one: run.sh, then the
// router. The panel decides when that is the only thing left that can help.
const resumePanel = createResumePanel({ onResume: startStory });
// When the router finishes, the plan and the phase have both changed on disk.
const chatPanel = createChatPanel({ onFinished: () => reload(routedId()) });

// A sibling of the list, not a child of it: story-list.js rebuilds its whole
// host on every poll, which would take the half-typed key with it.
render(refs.list, newStoryPanel.host, storyList.host);

/** The story id in the address bar, if there is one. */
function routedId() {
  const match = /^#\/([^/]+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

async function loadStories() {
  const payload = await api.stories();
  storyList.setData(payload);

  // The two aggregates that change what you would do next, and no others. A
  // story that has stopped moving asks for a click; one at a gate asks for a
  // judgement. Everything else on this page is the router's problem.
  const counts = { waiting: 0, stopped: 0 };
  for (const story of payload.stories) {
    const group = phases.groupOf(story);
    if (group === 'waiting' || group === 'stopped') counts[group] += 1;
  }

  const said = [];
  if (counts.waiting) {
    said.push(`${counts.waiting} ${counts.waiting === 1 ? 'story is' : 'stories are'} `
      + 'waiting on a decision');
  }
  if (counts.stopped) {
    said.push(`${counts.stopped} ${counts.stopped === 1 ? 'has' : 'have'} stopped moving`);
  }
  refs.status.textContent = said.length ? said.join(' · ') : 'nothing is waiting on you';

  return payload;
}

async function showStory(id) {
  storyList.select(id);

  if (!id) {
    watching = null;
    render(refs.detail, detailPlaceholder('Pick a story on the left.'));
    return;
  }

  try {
    paintStory(await api.story(id));
  } catch (error) {
    // Not null: null means "nothing to watch". An empty string keeps the poll
    // alive so a server that comes back brings the page back with it.
    watching = '';
    // Status 0 is the transport failing — the story is probably fine and the
    // server is not. Anything else came back FROM the server about this story,
    // which is the case where the page must show the error and nothing else.
    render(refs.detail, error.status === 0
      ? detailPlaceholder(`Could not load ${id}: ${error.message}`)
      : unreadableDetail(id, error.message));
  }
}

/**
 * Draw a story that has already been fetched.
 *
 * Split out from showStory because the watcher below has the payload in hand
 * and must not go and ask for it a second time.
 */
function paintStory(story) {
  watching = JSON.stringify(story);

  const docs = documentState(refs.detail);
  const focus = captureFocus();

  decisionPanel.setStory(story);
  reworkPanel.setStory(story);
  resumePanel.setStory(story);
  render(refs.detail, storyDetail(story, {
    chatHost: chatPanel.host,
    decisionHost: decisionPanel.host,
    reworkHost: reworkPanel.host,
    resumeHost: resumePanel.host,
  }));
  applyDocumentState(refs.detail, docs);
  restoreFocus(focus);

  // After the view is mounted: this one asks the server whether a session is
  // live and may attach to it, which must not hold up the rest of the page.
  chatPanel.setStory(story);
}

/**
 * Where the cursor was, so a redraw can put it back.
 *
 * The three panel hosts survive a rebuild - they are moved, not recreated - but
 * re-parenting a node blurs whatever inside it had focus. Without this, a
 * redraw that lands while you are mid-sentence in the chat box or typing a
 * reason for sending a plan back takes the keyboard away from you, and the poll
 * below makes that a thing that can happen at any moment rather than only when
 * you pressed something.
 */
function captureFocus() {
  const node = document.activeElement;
  if (!node || !refs.detail.contains(node)) return null;
  const text = typeof node.selectionStart === 'number';
  return { node, start: text ? node.selectionStart : null, end: text ? node.selectionEnd : null };
}

function restoreFocus(saved) {
  if (!saved || !saved.node.isConnected) return;
  saved.node.focus();
  if (saved.start !== null) saved.node.setSelectionRange(saved.start, saved.end);
}

/** Re-read a story and the list together, after something changed on disk. */
function reload(id) {
  return Promise.all([loadStories(), showStory(id)]);
}

/**
 * Run a decision, then re-read from disk.
 *
 * The reload is not optional. The scripts are the only writer of state.json,
 * so after one runs, what this page holds is stale by definition - and on a
 * rejection the phase has moved to `blocked`, which is exactly the change you
 * need to see reflected.
 */
async function decide(action, reason, gate) {
  const id = routedId();
  const result = await api.decide(action, { story: id, gate, reason });

  // Both scripts end by exec'ing the router; the UI passes --no-continue so a
  // refusal stays legible, and then runs it here instead. That is not optional
  // bookkeeping - approve.sh only RECORDS the decision, and it is the router
  // that reads phases.tsv and writes the next phase. Skip this and an approved
  // story sits at plan_review forever, approved and going nowhere.
  //
  // A rejection is the exception: approve.sh has already sent it to `blocked`,
  // which is terminal, so there is no loop left to continue.
  if (result.ok && action !== 'reject') {
    try {
      await chatPanel.begin(id);
    } catch (error) {
      result.stderr += `\n\nThe decision was recorded, but the router did not start: ${error.message}`;
    }
  }

  await reload(id);
  return result;
}

/**
 * Create a story, or pick a stalled one back up, then go and watch it.
 *
 * The same two-step shape as decide(), and for the same reason: run.sh is
 * called with --no-continue so that a refusal comes back as a refusal instead
 * of as a timeout, which leaves the story sitting at `intake` with nothing
 * driving it. The router is started here, on the terminal the chat panel is
 * already able to stream.
 *
 * The two endings are not interchangeable. Setting the hash to the route you
 * are already on fires no hashchange, so resuming the open story would appear
 * to do nothing at all; that case has to re-read explicitly.
 */
async function startStory(id) {
  const result = await api.run(id);
  if (!result.ok) return result;

  try {
    await chatPanel.begin(id);
  } catch (error) {
    result.stderr += `\n\nThe story is ready, but the router did not start: ${error.message}`;
  }

  if (routedId() === id) {
    await reload(id);
  } else {
    // The list has to know about the story before the route selects it.
    await loadStories();
    location.hash = `#/${id}`;
  }

  return result;
}

window.addEventListener('hashchange', () => showStory(routedId()));

/**
 * Notice what the agents write, without being told.
 *
 * The router used to be the only thing that triggered a re-read, and only when
 * it exited. But the interesting write happens in the middle of a run: the
 * cartographer finishes the plan long before the router is done, and until it
 * did, the page you were sitting in front of showed no plan at all. Reloading
 * by hand to find out whether the thing you are waiting for has arrived is not
 * a workflow.
 *
 * This polls rather than listening because state.json is written by shell
 * scripts, which have no way to notify a browser, and because a story can be
 * moved by a router the user started in their own terminal - a signal wired
 * through the chat session would miss exactly that case.
 *
 * The redraw is guarded on the payload actually differing, so an idle story
 * costs one request and no DOM churn at all.
 */
const WATCH_MS = 3000;
let watching = null;   // the last payload drawn, as JSON
let polling = false;   // a slow request must not stack another on top of itself

async function watch() {
  const id = routedId();
  if (!id || polling || document.hidden || watching === null) return;

  let story;
  polling = true;
  try {
    story = await api.story(id);
  } catch {
    return;   // a blip; the next tick tries again rather than blanking the page
  } finally {
    polling = false;
  }

  // The route may have moved while that request was in flight.
  if (routedId() !== id || JSON.stringify(story) === watching) return;

  paintStory(story);
  await loadStories();   // the phase badge and "waiting on you" moved too
}

setInterval(watch, WATCH_MS);
// Coming back to the tab should not cost you a wait.
document.addEventListener('visibilitychange', () => { if (!document.hidden) watch(); });

(async function start() {
  try {
    phases.load(await api.phases());
  } catch (error) {
    render(refs.detail, detailPlaceholder(`Could not read the phase table: ${error.message}`));
    return;
  }

  try {
    const payload = await loadStories();
    // With no route, open whatever is waiting on a human - that is the reason
    // this page exists. Failing that, the first story.
    const first = payload.stories.find((story) => story.awaiting) || payload.stories[0];
    if (!routedId() && first) {
      location.hash = `#/${first.dir}`;
      return;  // hashchange takes it from here
    }
    await showStory(routedId());
  } catch (error) {
    render(refs.detail, detailPlaceholder(`Could not reach the server: ${error.message}`));
  }
})();
