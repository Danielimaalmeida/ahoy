'use strict';
// plan.sh / intake.sh — traceability to the ticket, and a dispatchable plan.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

const SNAPSHOT = `# PROJ-1

## Description
The billing response must expose the invoice due date so the admin portal can
display it alongside the invoice total, for finance users reconciling invoices.

## Acceptance criteria
- The billing response includes the invoice due date in UTC.
- The admin portal displays the due date on the invoice row.

## Out of scope
Timezone localisation of the displayed date.
`;

function snapshot(ws, text = SNAPSHOT) {
  ws.write(`specs/${STORY}/jira-source.md`, text);
}

function planState(ws, sourceQuote) {
  ws.write(`specs/${STORY}/implementation-plan.md`, '# plan\n');
  ws.writeState({
    story_id: STORY,
    phase: 'planning',
    plan_path: `specs/${STORY}/implementation-plan.md`,
    acceptance_criteria: [
      { id: 'AC1', text: 't', repo: 'svc', source_quote: sourceQuote, test_ids: ['renders the due date'] },
    ],
    work_packages: [
      { id: 'WP1', repo: 'svc', agent: 'svc-implementer', depends_on: [], open_pr: true },
    ],
  });
}

function withWS(fn) {
  const ws = newWorkspace();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('criterion quoted verbatim from the snapshot', () => {
  withWS((ws) => {
    snapshot(ws);
    planState(ws, 'The billing response includes the invoice due date in UTC.');
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 0);
  });
});

test('a plausible criterion nobody asked for is rejected', () => {
  withWS((ws) => {
    snapshot(ws);
    planState(ws, 'The response should also include the payment status.');
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('prose is not a test id', () => {
  withWS((ws) => {
    snapshot(ws);
    planState(ws, 'The billing response includes the invoice due date in UTC.');
    ws.patchState((s) => { s.acceptance_criteria[0].test_ids = ['unit tests']; });
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('snapshot has description, criteria and boundaries', () => {
  withWS((ws) => {
    snapshot(ws);
    ws.writeState({ story_id: STORY, phase: 'intake', navigator: { completeness: 'FULL', open_questions: [] } });
    assert.strictEqual(ws.gate('intake.sh', STORY).code, 0);
  });
});

// Navigator's own `completeness` is an input, not the check. The gate inspects
// the persisted snapshot independently, which is the whole point: a gate whose
// only input is a field the agent wrote is a schema validator wearing a gate's
// name.
test('missing boundaries section is caught despite FULL', () => {
  withWS((ws) => {
    snapshot(ws, SNAPSHOT.replace(/## Out of scope[\s\S]*$/, ''));
    ws.writeState({ story_id: STORY, phase: 'intake', navigator: { completeness: 'FULL', open_questions: [] } });
    assert.strictEqual(ws.gate('intake.sh', STORY).code, 1);
  });
});

// --------------------------------------------------------------------------
// plan.sh — work_packages must be dispatchable, not prose
// --------------------------------------------------------------------------

function wpState(ws, workPackages) {
  ws.write(`specs/${STORY}/implementation-plan.md`, '# plan\n');
  ws.writeState({
    story_id: STORY,
    phase: 'planning',
    plan_path: `specs/${STORY}/implementation-plan.md`,
    acceptance_criteria: [{
      id: 'AC1', text: 't', repo: 'backend',
      source_quote: 'The billing response includes the invoice due date in UTC.',
      test_ids: ['renders the due date'],
    }],
    work_packages: workPackages,
  });
}

test('one package, one open_pr, real agent', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, [{ id: 'WP1', repo: 'backend', agent: 'backend-implementer', depends_on: [], open_pr: true }]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 0);
  });
});

test('prose-only plan with no work_packages is rejected', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, []);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('two open_pr in one repo opens a PR on incomplete work', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, [
      { id: 'WP1', repo: 'backend', agent: 'a', depends_on: [], open_pr: true },
      { id: 'WP2', repo: 'backend', agent: 'b', depends_on: [], open_pr: true },
    ]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('no open_pr leaves pr.sh waiting forever', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, [{ id: 'WP1', repo: 'backend', agent: 'a', depends_on: [], open_pr: false }]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('depends_on a package that does not exist', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, [{ id: 'WP1', repo: 'backend', agent: 'a', depends_on: ['WP9'], open_pr: true }]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('criterion for a repo with no work package', () => {
  withWS((ws) => {
    snapshot(ws);
    wpState(ws, [{ id: 'WP1', repo: 'frontend', agent: 'a', depends_on: [], open_pr: true }]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

// --------------------------------------------------------------------------
// one branch per repository — the rule the contract stated and nothing checked
// --------------------------------------------------------------------------
// A plan named two branches for one repository. Both packages ran in the same
// worktree, so the commits and the pull request went to the first; the state
// recorded the second. Everything was done and child_ready.sh correctly
// reported no pull request on a branch that never existed.
//
// The bash suite asserted this against an inline copy of the jq, and the copy
// passed while gates/plan.sh — the gate that actually runs — carried no such
// check at all. The check now lives in the gate, and these run it.

function branchWS(ws, workPackages) {
  snapshot(ws);
  ws.write(`specs/${STORY}/implementation-plan.md`, '# plan\n');
  ws.writeState({
    story_id: STORY,
    phase: 'planning',
    plan_path: `specs/${STORY}/implementation-plan.md`,
    acceptance_criteria: [{
      id: 'AC1', text: 't', repo: 'svc',
      source_quote: 'The billing response includes the invoice due date in UTC.',
      test_ids: ['renders the due date'],
    }],
    work_packages: workPackages,
  });
}

test('two branches in one repository is caught', () => {
  withWS((ws) => {
    branchWS(ws, [
      { id: 'WP1', repo: 'svc', agent: 'impl', depends_on: [], open_pr: true, branch: 'feature/X' },
      { id: 'WP2', repo: 'svc', agent: 'rev', depends_on: [], open_pr: false, branch: 'feature/X-a11y' },
    ]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 1);
  });
});

test('the same branch twice is fine', () => {
  withWS((ws) => {
    branchWS(ws, [
      { id: 'WP1', repo: 'svc', agent: 'impl', depends_on: [], open_pr: true, branch: 'feature/X' },
      { id: 'WP2', repo: 'svc', agent: 'rev', depends_on: [], open_pr: false, branch: 'feature/X' },
    ]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 0);
  });
});

test('different repositories may of course differ', () => {
  withWS((ws) => {
    branchWS(ws, [
      { id: 'WP1', repo: 'svc', agent: 'impl', depends_on: [], open_pr: true, branch: 'feature/X' },
      { id: 'WP2', repo: 'web', agent: 'impl', depends_on: [], open_pr: true, branch: 'feature/Y' },
    ]);
    // The criterion names only `svc`, so `web` having a package is fine; what
    // is asserted here is that two repositories naming different branches is
    // not the split-branch failure.
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 0);
  });
});

test('a package naming no branch inherits the repository\'s', () => {
  withWS((ws) => {
    branchWS(ws, [
      { id: 'WP1', repo: 'svc', agent: 'impl', depends_on: [], open_pr: true, branch: 'feature/X' },
      { id: 'WP2', repo: 'svc', agent: 'rev', depends_on: [], open_pr: false },
    ]);
    assert.strictEqual(ws.gate('plan.sh', STORY).code, 0);
  });
});

// The branch prefix comes from the Jira issue type, and gates/child_ready.sh
// rejects anything outside that set. Catching it at planning costs a re-plan;
// catching it there costs a full implementation run first.
test('a prefix outside the issue-type table is caught at planning', () => {
  withWS((ws) => {
    branchWS(ws, [{ id: 'WP1', repo: 'svc', agent: 'impl', depends_on: [], open_pr: true, branch: 'gitops/X' }]);
    const r = ws.gate('plan.sh', STORY);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /branch prefix must be one of/);
  });
});
