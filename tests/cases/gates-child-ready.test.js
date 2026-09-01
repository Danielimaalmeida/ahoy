'use strict';
// child_ready.sh — the agent's claim vs what GitHub says.
//
// It misread GitHub's check API and would have blocked a green pull request
// indefinitely. That was invisible while an agent reported on the gates, and
// surfaced the moment a shell ran the script and a test asserted what came back.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

function childState(ws) {
  ws.writeState({
    story_id: STORY,
    phase: 'implementation',
    acceptance_criteria: [
      { id: 'AC1', text: 't', repo: 'svc', source_quote: 'q', test_ids: ['renders the due date'] },
    ],
    child_repos: [{
      repo: 'svc', slug: 'h/o/svc', branch: `feature/${STORY}-x`, status: 'ready',
      pr_url: 'https://gh/h/o/svc/pull/42', pr_number: 42, head_sha: 'aaa111', retry_count: 0,
    }],
  });
}

function patchPR(ws, fn) {
  const pr = ws.readJSON('stub/pr.json');
  fn(pr);
  ws.writeJSON('stub/pr.json', pr);
}

function withChild(fn) {
  const ws = newWorkspace();
  try { childState(ws); return fn(ws); } finally { ws.destroy(); }
}

test('open PR, green CI, planned test present in diff', () => {
  withChild((ws) => assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 0));
});

// The gate resolves pr_number from the branch. If it does not write that back,
// gates/pr.sh later fails with "ready repositories have no pr_url set" on a
// delivery that is genuinely ready.
test('the gate records the PR it resolved', () => {
  withChild((ws) => {
    ws.patchState((s) => {
      delete s.child_repos[0].pr_url;
      delete s.child_repos[0].pr_number;
    });
    ws.gate('child_ready.sh', STORY, 'svc');
    assert.notStrictEqual(ws.readState().child_repos[0].pr_url, undefined);
  });
});

test('empty check rollup is not a pass', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => { pr.statusCheckRollup = []; });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

test('a skipped test does not satisfy a planned test id', () => {
  withChild((ws) => {
    ws.write('stub/diff.patch', '+  it.skip("renders the due date", () => {});\n');
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

test('claimed head_sha must match the live PR head', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => { pr.headRefOid = 'bbb222'; });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

test('an unrenamed session branch is rejected', () => {
  withChild((ws) => {
    ws.patchState((s) => { s.child_repos[0].branch = 'copilot/session-1'; });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

// --------------------------------------------------------------------------
// The check rollup mixes two GraphQL types.
// --------------------------------------------------------------------------
// statusCheckRollup mixes CheckRun (status/conclusion) and StatusContext
// (state, no status). A green commit status read as a CheckRun looks
// permanently unfinished and blocks a passing PR forever.
//
// These run the REAL gate rather than a copy of its jq. The bash suite asserted
// the classification twice — once through the gate here, and once against an
// inline reimplementation further down the file. Only the first was evidence
// about the shipping code; the cases the second one added are folded in below.

test('a green StatusContext does not read as pending', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => pr.statusCheckRollup.push({ context: '--> Linted: JAVA', state: 'SUCCESS', targetUrl: 'u' }));
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 0);
  });
});

// A failing check used to be exit 1, the same code as "still running". With
// --wait the router polled a permanently red build until the budget ran out.
// Nothing outside was ever going to turn it green: the code has to change.
test('a failing StatusContext routes back to implementation (was: 1)', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => pr.statusCheckRollup.push({ context: 'legacy ci', state: 'FAILURE', targetUrl: 'u' }));
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 3);
  });
});

test('a genuinely pending StatusContext still blocks', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => pr.statusCheckRollup.push({ context: 'legacy ci', state: 'PENDING', targetUrl: 'u' }));
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

// A running CheckRun is pending — poll, because it can still change.
test('a running check is pending, not failed', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => { pr.statusCheckRollup = [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }]; });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});

// A completed failure is not pending, and polling it changes nothing.
test('a completed CheckRun failure routes rather than polls', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => { pr.statusCheckRollup = [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }]; });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 3);
  });
});

// A failure alongside a running check waits for the full picture first: the
// pending verdict wins, because the rest of the run may yet change the answer.
test('a failure alongside a running check is still pending', () => {
  withChild((ws) => {
    patchPR(ws, (pr) => {
      pr.statusCheckRollup = [
        { name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'b', status: 'QUEUED', conclusion: null },
      ];
    });
    assert.strictEqual(ws.gate('child_ready.sh', STORY, 'svc').code, 1);
  });
});
