'use strict';
// consensus.sh — the gate whose branch and halt routes were unreachable.
//
// This gate called a function (`info`) that lib.sh never defined. It fell
// through to the shell, returned 127, and the ERR trap converted every branch
// and halt path into exit 2. Both were unreachable in practice, and nothing
// noticed while an agent was the thing reporting on the gates.

const test = require('node:test');
const assert = require('node:assert');
const { newWorkspace, STORY } = require('../lib/harness');

// consensusState(verdictR1, diminishing, verdictR2, statusR1)
//
// verdictR2 defaults to matching r1. The two reviewers AGREEING is the case
// where a verdict means something routable; where they differ the gate halts
// instead, so the default keeps each test about the thing it names.
function consensusState(ws, v1, dim, v2 = v1, st1 = 'CONSENSUS_READY') {
  ws.writeState({
    story_id: STORY,
    phase: 'pr_review',
    acceptance_criteria: [
      { id: 'AC1', text: 't', repo: 'svc', source_quote: 'q', test_ids: ['renders the due date'] },
    ],
    child_repos: [{
      repo: 'svc', slug: 'h/o/svc', branch: `feature/${STORY}-x`, status: 'ready',
      pr_url: 'https://gh/x/y/pull/42', pr_number: 42, head_sha: 'aaa111', retry_count: 0,
    }],
    lookout_reviews: [
      {
        model: 'm1', lens: 'design-fit', consensus_status: st1,
        unresolved_high_or_blocking_count: 0, diminishing_returns_agreed: dim,
        reviewed_shas: { svc: 'aaa111' }, criteria_verdicts: { AC1: v1 },
      },
      {
        model: 'm2', lens: 'defect-failure', consensus_status: 'CONSENSUS_READY',
        unresolved_high_or_blocking_count: 0, diminishing_returns_agreed: true,
        reviewed_shas: { svc: 'aaa111' }, criteria_verdicts: { AC1: v2 },
      },
    ],
  });
}

function withWorkspace(fn) {
  const ws = newWorkspace();
  try { return fn(ws); } finally { ws.destroy(); }
}

test('both reviewers agree a criterion is unmet -> rework', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'not_met', true);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 3);
  });
});

// The disagreement route. One reviewer says the criterion is covered; sending
// that to rework tells a fixer to fix something a competent reviewer says is
// already correct, which is a loop with no exit condition.
test('reviewers disagree about a criterion -> human, not rework', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'not_met', true, 'met');
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

test('disagreement holds even between two non-identical met-ish verdicts', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', true, 'partially_met');
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

// BLOCKED is what a Lookout reports when it cannot resolve something. There is
// no Captain to mediate a reconciliation round, so it goes straight to a human.
test('a reviewer reporting BLOCKED halts for a human', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', true, 'met', 'BLOCKED');
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

// --------------------------------------------------------------------------
// major findings — agreed is work, split is a judgement call
// --------------------------------------------------------------------------
// A `major` finding used to pass straight through to the delivery gate: the gate
// read only unresolved_high_or_blocking_count. A review saying the structure
// will cost the team later, on code that satisfies every criterion, arrived as a
// line in a file nobody had to open.

function consensusFindings(ws, f1, f2) {
  ws.writeState({
    story_id: STORY,
    phase: 'pr_review',
    acceptance_criteria: [
      { id: 'AC1', text: 't', repo: 'svc', source_quote: 'q', test_ids: ['renders the due date'] },
    ],
    child_repos: [{
      repo: 'svc', slug: 'h/o/svc', branch: `feature/${STORY}-x`, status: 'ready',
      pr_url: 'https://gh/x/y/pull/42', pr_number: 42, head_sha: 'aaa111', retry_count: 0,
    }],
    lookout_reviews: [
      {
        model: 'm1', lens: 'design-fit', consensus_status: 'CONSENSUS_READY',
        unresolved_high_or_blocking_count: 0, diminishing_returns_agreed: true,
        reviewed_shas: { svc: 'aaa111' }, criteria_verdicts: { AC1: 'met' }, findings: f1,
      },
      {
        model: 'm2', lens: 'defect-failure', consensus_status: 'CONSENSUS_READY',
        unresolved_high_or_blocking_count: 0, diminishing_returns_agreed: true,
        reviewed_shas: { svc: 'aaa111' }, criteria_verdicts: { AC1: 'met' }, findings: f2,
      },
    ],
  });
}

const MAJ = [{ severity: 'major', evidence: 'state handled in three places', files: ['a.ts'], repo: 'svc' }];
const NIT = [{ severity: 'nit', evidence: 'naming', files: ['a.ts'], repo: 'svc' }];

test('both reviewers raising major routes to rework', () => {
  withWorkspace((ws) => {
    consensusFindings(ws, MAJ, MAJ);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 3);
  });
});

// One lens raising it and the other not is a disagreement. Sending that to
// rework tells a fixer to change something a competent reviewer says is fine.
test('a major from only one reviewer halts for a human', () => {
  withWorkspace((ws) => {
    consensusFindings(ws, MAJ, NIT);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

test('and the same the other way round', () => {
  withWorkspace((ws) => {
    consensusFindings(ws, NIT, MAJ);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

// The fixer has a ceiling, and a round spent on taste is one unavailable for a
// defect.
test('nits from both do not route anywhere', () => {
  withWorkspace((ws) => {
    consensusFindings(ws, NIT, NIT);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 0);
  });
});

test('no findings at all still passes', () => {
  withWorkspace((ws) => {
    consensusFindings(ws, [], []);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 0);
  });
});

test('clean review, reviewer wants another pass -> halt', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', false);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 4);
  });
});

test('two independent fresh reviews, all criteria met', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', true);
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 0);
  });
});

// The distinction 3 and 4 exist for: a caller reading only the exit code must
// be able to tell a broken environment from a routable verdict. This gate used
// to return 2 for "route to rework", which is the code a missing jq produces.
test('unauthenticated gh is an environment error, not rework', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'not_met', true);
    const r = ws.run(ws.path('gates', 'consensus.sh'), [STORY], { env: { STUB_GH_AUTH: '1' } });
    assert.strictEqual(r.code, 2);
  });
});

test('same model twice is not two reviews', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', true);
    ws.patchState((s) => { s.lookout_reviews[1].model = 'm1'; });
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 1);
  });
});

test('review of a stale commit is rejected', () => {
  withWorkspace((ws) => {
    consensusState(ws, 'met', true);
    ws.patchState((s) => { s.lookout_reviews[0].reviewed_shas.svc = 'old999'; });
    assert.strictEqual(ws.gate('consensus.sh', STORY).code, 1);
  });
});
