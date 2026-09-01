'use strict';
// human gates — the shape that let R3DA-13709 walk around its delivery gate.
//
// The router reads .human_gates[key].status. A bare boolean has no .status, so
// the gate could not open — and the phase was then set by hand instead, which
// is how a story reached `done` with its delivery gate never exercised.
//
// The bash suite tested this by pasting tick.sh's jq filter into the test file.
// Here it imports the router's own function, so the assertion is about the
// shipping code rather than about a copy of it that could drift from it.
//
// The filter must not ERROR on a non-object: jq's `//` catches null and false,
// not "cannot index boolean", which is why the type is tested before indexing.
// The JavaScript has the same hazard in a different costume — `g.status` on a
// boolean is silently `undefined` rather than an error, and reading that as
// "unset" would be exactly the quiet acceptance the loud rejection replaced.

const test = require('node:test');
const assert = require('node:assert');
const { humanGateStatus } = require('../../bin/lib/derive');

test('a bare boolean is MALFORMED, not approval', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: true } }, 'delivery_accepted'),
    'MALFORMED:boolean');
});

test('the contract shape reads as approved', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: { status: 'approved', timestamp: 't' } } }, 'delivery_accepted'),
    'approved');
});

test('a missing gate is unset, and unset is not approval', () => {
  assert.strictEqual(humanGateStatus({ human_gates: {} }, 'delivery_accepted'), 'unset');
});

test('an object with no status is unset', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: { timestamp: 't' } } }, 'delivery_accepted'),
    'unset');
});

// Two shapes the jq could not produce but JSON can, and which a naive
// `typeof g === 'object'` would wave through: null indexes as nothing in jq and
// is genuinely unset, while an array is a malformed hand edit like any other.
test('null is unset rather than an error', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: null } }, 'delivery_accepted'), 'unset');
});

test('an array is MALFORMED too', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: ['approved'] } }, 'delivery_accepted'),
    'MALFORMED:array');
});

test('a string is MALFORMED, not read as its own status', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { delivery_accepted: 'approved' } }, 'delivery_accepted'),
    'MALFORMED:string');
});

// `pending` is a placeholder an agent wrote, not a decision. It reads back as
// itself here; refusing to treat it as a recorded decision is bin/approve.js's
// job, and approve.test.js asserts that half.
test('pending reads as pending, and pending is not approved', () => {
  assert.strictEqual(
    humanGateStatus({ human_gates: { plan_accepted: { status: 'pending' } } }, 'plan_accepted'),
    'pending');
});
