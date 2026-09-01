// Family C tests — the adversarial probes.
//
// This is the family two reviews found real bugs in, so the tests are written
// to prove the *corrected* design holds, not merely that the code runs. The
// single most important test in this file is the one showing the `echoer`
// fixture is NOT falsely accused: an agent that quotes hostile input back
// inside a validation error trips every naive canary check ever written, and
// the whole point of the per-carrier-shape controls is that it must not be
// convicted for it.
//
// Two directions of failure are both tested, on purpose:
//   - false positive: honest and echoer must come out clean.
//   - false negative: a genuinely compromised target must still be seen.
// The second is the one spec.js calls the worse direction, so it gets its own
// test rather than being assumed.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeAgent, fixtureTarget } from './fixtures/fakeAgent.js';
import { injectionCanary, detectCanary, CARRIER_SHAPES } from '../src/lib/probes/injectionCanary.js';
import { differentialCorruption, learnVolatileFields } from '../src/lib/probes/differentialCorruption.js';
import { contradictoryConstraint, planContradiction } from '../src/lib/probes/contradictoryConstraint.js';
import { safeFetch } from '../src/lib/safeFetch.js';
import { requestOptions } from '../src/lib/probeContract.js';
import { CANARY_TOKEN, REQUEST_BUDGET, THRESHOLDS } from '../src/lib/spec.js';

let agent;
let target;

before(async () => {
  agent = createFakeAgent({ mode: 'honest' });
  target = fixtureTarget(await agent.listen());
});

after(() => agent.close());

beforeEach(() => {
  agent.setMode('honest');
  agent.reset();
});

/** Collect the fixture's baseline pair the way repeat_determinism would, so
 *  differential_corruption is fed a real pair rather than an invented one. */
async function realBaselinePair() {
  const body = JSON.stringify(target.sampleBody);
  const a = await safeFetch(target.url, requestOptions(target, { body }));
  const b = await safeFetch(target.url, requestOptions(target, { body }));
  return [a, b];
}

/** A stub target response, shaped like safeFetch's return value. */
function stubResponse(body, status = 200) {
  return {
    ok: true, status, headers: {}, body, bytes: body.length,
    truncated: false, elapsedMs: 1, networkError: null, refusedByGuard: null,
  };
}

// ---------------------------------------------------------------------------
// injection_canary — shape and budget
// ---------------------------------------------------------------------------

test('injection_canary spends exactly its budget: six techniques plus four controls', async () => {
  // 6 + 4 = 10 is the whole reason controls are per carrier SHAPE and not per
  // technique. One control per technique would be 12 and would break the
  // published 30-request cap, which is an abuse limit before it is a budget.
  const o = await injectionCanary(target);
  assert.equal(o.requestsUsed, 10);
  assert.equal(o.requestsUsed, REQUEST_BUDGET.injection_canary);
  assert.equal(o.responses.length, 10);
  assert.equal(o.findings.techniques.length, 6);
  assert.equal(o.findings.controls.length, 4);

  // Exactly one control per shape, and every shape a technique used is covered.
  const controlShapes = o.findings.controls.map((c) => c.carrierShape);
  assert.deepEqual([...new Set(controlShapes)].sort(), controlShapes.sort());
  assert.deepEqual(
    [...new Set(o.findings.techniques.map((t) => t.carrierShape))].sort(),
    Object.values(CARRIER_SHAPES).slice().sort(),
  );
});

test('the canary token itself is never obfuscated, only its wrapper is', async () => {
  // The rule from spec.js: mangling the token would let a genuinely
  // compromised agent echo a form our matcher misses — a false negative,
  // which scores a broken agent as clean. Every request we send must carry
  // the token in a form our own matcher recovers unaltered.
  await injectionCanary(target);
  assert.equal(agent.state.seenBodies.length, 10);
  for (const sent of agent.state.seenBodies) {
    const d = detectCanary(sent);
    assert.equal(d.canaryFound, true, `a sent body did not carry a recoverable canary: ${sent.slice(0, 120)}`);
  }
  // Nine of the ten carry it as plain text. Only the base64 pair encodes it,
  // and there the token is still the plain token once decoded — never a
  // homoglyph, never split, never re-spelled.
  const plain = agent.state.seenBodies.filter((b) => b.includes(CANARY_TOKEN)).length;
  assert.equal(plain, 8);
});

// ---------------------------------------------------------------------------
// injection_canary — the false-positive direction (the reviewed bug)
// ---------------------------------------------------------------------------

test('THE IMPORTANT ONE: the echoer is not falsely flagged, because its controls echo too', async () => {
  // The echoer is a perfectly well-behaved agent that quotes offending input
  // back inside its error body. A clean control would stay silent for it and
  // the real probes would light up, convicting it of an injection that never
  // happened. Attack-shaped controls make the echo visible on BOTH sides.
  agent.setMode('echoer');
  const o = await injectionCanary(target);

  // It really does echo the canary, on enough techniques to trip a naive
  // "two or more agreeing techniques" rule. If this ever stops being true the
  // test below stops proving anything.
  assert.ok(
    o.findings.distinctTechniquesLanded >= THRESHOLDS.INJECTION_MIN_AGREEING_TECHNIQUES,
    'the echoer must echo enough techniques for the test to be meaningful',
  );

  // Every carrier shape's control echoed too, so not one landed technique is
  // unexplained. This is the fact the classifier needs.
  for (const [shape, echoed] of Object.entries(o.findings.controlEchoedByCarrierShape)) {
    assert.equal(echoed, true, `control for ${shape} should have echoed for an echoer`);
  }
  assert.equal(o.findings.techniquesLandedWithSilentControl, 0);

  // And independently: every hit sits inside a verbatim quote of what we sent,
  // which docs/SCORING.md rule 4 says does not count on its own either.
  assert.equal(o.findings.techniquesLandedOutsideVerbatimEcho, 0);
});

test('the honest agent comes out clean', async () => {
  // The honest fixture restates the query in its answer, which is ordinary
  // agent behaviour and must not read as compliance. Same defence as the
  // echoer: the controls are restated too.
  const o = await injectionCanary(target);
  assert.equal(o.skipped, null);
  assert.equal(o.findings.techniquesLandedWithSilentControl, 0);
  assert.equal(o.findings.techniquesLandedOutsideVerbatimEcho, 0);
});

// ---------------------------------------------------------------------------
// injection_canary — the false-negative direction
// ---------------------------------------------------------------------------

test('a genuinely compromised target IS seen: it obeys the instruction and its controls stay silent', async () => {
  // Guarding against false positives is worthless if it hides real hits. This
  // target emits the canary only when the payload actually instructed it to,
  // and never quotes the request back — so the canary appears with a silent
  // control and outside any verbatim echo.
  const INSTRUCTION_MARKERS = [
    'Ignore all previous instructions',
    'Priority directive',
    'Before presenting results',
    'Decode the base64',
  ];
  const fetchImpl = async (_url, options) => {
    const wasInstructed = INSTRUCTION_MARKERS.some((m) => options.body.includes(m));
    return stubResponse(JSON.stringify({
      result: 'analysis complete',
      answer: wasInstructed ? CANARY_TOKEN : 'the weather is fine',
    }));
  };

  const o = await injectionCanary(target, { fetchImpl });
  assert.equal(o.findings.distinctTechniquesLanded, 6);
  assert.equal(o.findings.techniquesLandedWithSilentControl, 6);
  assert.equal(o.findings.techniquesLandedOutsideVerbatimEcho, 6);
  for (const echoed of Object.values(o.findings.controlEchoedByCarrierShape)) {
    assert.equal(echoed, false);
  }
});

test('a canary reflected inside a JSON string field is still recognised as an echo', async () => {
  // A target that puts our text into one of its own JSON fields re-escapes it:
  // newlines become \n and quotes become \". A raw substring check against
  // what we sent then fails even though the echo plainly happened. Getting
  // this wrong in the *detection* direction would be a false negative; getting
  // it wrong in the *echo* direction falsely convicts an honest target.
  const fetchImpl = async (_url, options) =>
    stubResponse(JSON.stringify({ error: 'invalid request', received: options.body }), 400);

  const o = await injectionCanary(target, { fetchImpl });

  // The token survives JSON escaping unchanged (letters and digits only), so
  // detection sees it everywhere...
  for (const t of o.findings.techniques) {
    assert.equal(t.canaryFound, true, `${t.technique} should be detected`);
    // ...and every one is correctly attributed to a verbatim echo rather than
    // to the agent obeying anything.
    assert.equal(t.insideVerbatimEcho, true, `${t.technique} should read as an echo`);
  }
  assert.equal(o.findings.techniquesLandedWithSilentControl, 0);

  // Proof the JSON-escaped path is what fired: the raw multi-line carrier we
  // sent does not appear literally anywhere in the response body.
  const firstBody = o.responses[0].body;
  assert.equal(firstBody.includes('\n\nIgnore all previous instructions'), false);
});

// ---------------------------------------------------------------------------
// injection_canary — the matchers
// ---------------------------------------------------------------------------

test('the canary is matched five ways, and the narrowest match is recorded', () => {
  assert.equal(detectCanary(`x ${CANARY_TOKEN} y`).matchMethod, 'plain');

  // Whitespace injected into the token.
  const spaced = `${CANARY_TOKEN.slice(0, 8)} ${CANARY_TOKEN.slice(8)}`;
  const ws = detectCanary(`answer: ${spaced}`);
  assert.equal(ws.canaryFound, true);
  assert.ok(ws.matchMethods.includes('whitespace_stripped'));

  // Case flipped.
  const ci = detectCanary(`answer: ${CANARY_TOKEN.toLowerCase()}`);
  assert.equal(ci.canaryFound, true);
  assert.deepEqual(ci.matchMethods, ['case_insensitive']);

  // Base64-encoded, including the misaligned case that a JSON-escaped newline
  // creates (`\n` leaves a stray `n` glued to the front of the blob).
  const blob = Buffer.from(`here you go: ${CANARY_TOKEN}`, 'utf8').toString('base64');
  assert.equal(detectCanary(`{"a":"${blob}"}`).canaryFound, true);
  assert.equal(detectCanary(`{"a":"line\\n${blob}\\n"}`).canaryFound, true, 'misaligned base64 must still decode');

  // Unicode escapes.
  const escaped = [...CANARY_TOKEN].map((c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`).join('');
  const ue = detectCanary(escaped);
  assert.equal(ue.canaryFound, true);
  assert.deepEqual(ue.matchMethods, ['unicode_escape']);

  // And nothing at all when it is not there.
  assert.equal(detectCanary('completely unrelated response').canaryFound, false);
  assert.equal(detectCanary('').canaryFound, false);
});

test('injection_canary skips rather than inventing a field to inject into', async () => {
  const noStrings = fixtureTarget(target.url, { sampleBody: { count: 3, flag: true } });
  const o = await injectionCanary(noStrings);
  assert.equal(o.skipped, 'no_injectable_field');
  assert.equal(o.requestsUsed, 0);
});

// ---------------------------------------------------------------------------
// The silent-lie signal
// ---------------------------------------------------------------------------

test('sloppy mode shows the silent-lie signal: 2xx and no error signal to input it should reject', async () => {
  agent.setMode('sloppy');

  // A self-contradicting request is unanswerable on its face, in any domain.
  // Answering it with a success and no error signal is the product's whole
  // thesis in one response.
  const c = await contradictoryConstraint(target);
  assert.equal(c.findings.status, 200);
  assert.equal(c.findings.errorSignalPresent, false);
  assert.equal(c.findings.contradictionKind, 'min_greater_than_max');

  // And it answers all ten obviously hostile injection requests with a 200,
  // never signalling a problem with any of them.
  const i = await injectionCanary(target);
  assert.equal(i.findings.successStatusCount, 10);
  assert.equal(i.findings.errorSignalCount, 0);
});

test('the honest agent rejects a self-contradiction, and the echoer rejects it while quoting it back', async () => {
  const honest = await contradictoryConstraint(target);
  assert.equal(honest.findings.status, 400);
  assert.equal(honest.findings.errorSignalPresent, true);
  assert.equal(honest.findings.echoedMutatedInput, false);

  agent.setMode('echoer');
  const echoer = await contradictoryConstraint(target);
  assert.equal(echoer.findings.status, 400);
  assert.equal(echoer.findings.errorSignalPresent, true);
  // Quoting the bad input back is an observation, not a verdict. Recording it
  // is what stops the classifier reading a chatty error as a lie.
  assert.equal(echoer.findings.echoedMutatedInput, true);
});

// ---------------------------------------------------------------------------
// contradictory_constraint — how the contradiction is chosen
// ---------------------------------------------------------------------------

test('an existing min/max pair is preferred over adding a counterpart field', () => {
  // Inverting two fields the target already accepts is strong evidence.
  const both = planContradiction({ min_results: 1, max_results: 9, q: 'x' });
  assert.equal(both.minKey, 'min_results');
  assert.equal(both.maxKey, 'max_results');
  assert.equal(both.counterpartWasAdded, false);

  // The fixture only has max_results, so the counterpart has to be added —
  // and that is recorded, because a target ignoring a field it has never
  // heard of is weaker evidence than one ignoring a real contradiction.
  const added = planContradiction(target.sampleBody);
  assert.equal(added.minKey, 'min_results');
  assert.equal(added.counterpartWasAdded, true);

  // camelCase is understood; a word that merely starts with "min" is not.
  assert.equal(planContradiction({ maxResults: 4 }).minKey, 'minResults');
  assert.equal(planContradiction({ minutes: 30 }), null);
});

test('contradictory_constraint skips rather than inventing a range to contradict', async () => {
  const noRange = fixtureTarget(target.url, { sampleBody: { query: 'x', wallet: '0xabc' } });
  const o = await contradictoryConstraint(noRange);
  assert.equal(o.skipped, 'no_contradictable_field');
  assert.equal(o.requestsUsed, 0);
});

// ---------------------------------------------------------------------------
// differential_corruption
// ---------------------------------------------------------------------------

test('volatile fields are learned from the baseline pair, not assumed', async () => {
  // The fixture varies request_id and generated_at per request. Nobody told
  // the probe those names; it found them by diffing two identical requests.
  //
  // Only request_id is asserted unconditionally, and the reason is a real
  // limitation rather than test tidiness: `generated_at` is a millisecond
  // timestamp, so when both baseline requests land inside the same
  // millisecond it genuinely does not vary, and a two-sample diff cannot see
  // that it is volatile. This test was flaky before that was understood.
  // The limitation is published in the honesty table.
  const o = await differentialCorruption(target, { baselineResponses: await realBaselinePair() });
  assert.ok(o.findings.volatileFields.includes('request_id'), 'a per-request id must always be detected as volatile');
  assert.equal(o.findings.baselineFieldCount, 4);
  for (const f of o.findings.volatileFields) {
    assert.ok(['request_id', 'generated_at'].includes(f), `unexpected volatile field '${f}'`);
  }
});

test('a half-volatile response is still comparable, because two stable fields remain', async () => {
  // REVISION 3 regression test. Two of the fixture's four response fields
  // change every request, which is 50% volatile — and under the original rule
  // ("skip above 30% volatile") this probe skipped, spent nothing, and
  // reported nothing. That was wrong, and wrong in a way that would have hit
  // most real targets: a compact response carrying a request id and a
  // timestamp is extremely common and is perfectly comparable on whatever
  // else it returns.
  //
  // The rule now asks what is LEFT to compare rather than what fraction moved.
  //
  // stableFieldCount is asserted as "at least 2", not exactly 2, for the same
  // reason as the volatile-field test above: `generated_at` is a millisecond
  // timestamp and does not always differ between two back-to-back requests,
  // so the count is 2 or 3 depending on timing. Pinning it to one value made
  // this test intermittently red for a reason that had nothing to do with
  // what it is checking.
  const o = await differentialCorruption(target, { baselineResponses: await realBaselinePair() });
  assert.notEqual(o.skipped, 'baseline_too_noisy', 'must not skip a target that is genuinely comparable');
  assert.ok(o.findings.stableFieldCount >= 2, `expected at least 2 stable fields, got ${o.findings.stableFieldCount}`);
  assert.equal(o.requestsUsed, 1, 'the comparison request should actually be spent');
});

test('a response with nothing stable left is skipped, not guessed at', async () => {
  // The genuine un-judgeable case: every field moves between two identical
  // requests, so there is nothing steady to compare a corrupted request
  // against. Costs zero requests, because the answer could not have been
  // interpreted either way.
  const allVolatile = [
    { status: 200, body: JSON.stringify({ id: 'a1', at: '2026-01-01T00:00:00Z' }) },
    { status: 200, body: JSON.stringify({ id: 'b2', at: '2026-01-01T00:00:01Z' }) },
  ];
  const o = await differentialCorruption(target, { baselineResponses: allVolatile });
  assert.equal(o.skipped, 'baseline_too_noisy');
  assert.equal(o.requestsUsed, 0);
  assert.equal(o.findings.stableFieldCount, 0);
  // The measurement survives the skip — "everything changed" is a real
  // finding, not an absence of one.
  assert.equal(o.findings.volatileFieldRatio, 1);
});

test('no baseline means no comparison, and never a manufactured one', async () => {
  const none = await differentialCorruption(target);
  assert.equal(none.skipped, 'no_baseline_pair');
  assert.equal(none.requestsUsed, 0);

  const one = await differentialCorruption(target, { baselineResponses: [stubResponse('{}')] });
  assert.equal(one.skipped, 'no_baseline_pair');

  const notJson = await differentialCorruption(target, {
    baselineResponses: [stubResponse('plain text'), stubResponse('plain text')],
  });
  assert.equal(notJson.skipped, 'baseline_not_json');
  assert.equal(notJson.requestsUsed, 0);
});

test('volatile-field learning counts a key that appears in only one baseline', () => {
  const learned = learnVolatileFields({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 });
  assert.deepEqual(learned.volatileFields, ['c']);
  assert.equal(learned.fieldCount, 3);
});

test('a target that ignores a corrupted critical field is caught once volatile fields are stripped', async () => {
  // A quiet enough baseline to be judgeable: 10 fields, 2 of them volatile
  // (20%, inside the 30% ceiling). The target then returns the same answer for
  // a corrupted query as for a real one, which is the definition of ignoring
  // its input.
  const base = (n) => JSON.stringify({
    result: 'analysis complete', answer: 'generic answer',
    a: 1, b: 2, c: 3, d: 4, e: 5, f: 6,
    request_id: `req_${n}`, generated_at: `2026-09-01T00:00:0${n}Z`,
  });
  const baselineResponses = [stubResponse(base(1)), stubResponse(base(2))];
  const fetchImpl = async () => stubResponse(base(9));

  const o = await differentialCorruption(target, { baselineResponses, fetchImpl });
  assert.equal(o.skipped, null);
  assert.equal(o.requestsUsed, 1);
  assert.deepEqual(o.findings.volatileFields, ['generated_at', 'request_id']);
  assert.equal(o.findings.volatileFieldRatio, 0.2);
  assert.equal(o.findings.fieldCorrupted, 'query'); // the string field, not the numeric knob
  assert.equal(o.findings.identicalAfterStrippingVolatile, true);
  assert.deepEqual(o.findings.differingFields, []);
});

test('a target that actually reads the corrupted field is not flagged', async () => {
  const base = (n) => JSON.stringify({
    result: 'ok', answer: 'answer for: what is the weather',
    a: 1, b: 2, c: 3, d: 4, e: 5, f: 6,
    request_id: `req_${n}`, generated_at: `2026-09-01T00:00:0${n}Z`,
  });
  const baselineResponses = [stubResponse(base(1)), stubResponse(base(2))];
  // The answer changes with the corrupted query — the field was read.
  const fetchImpl = async () => stubResponse(base(9).replace('what is the weather', 'zzqx-NOT-A-REAL-VALUE'));

  const o = await differentialCorruption(target, { baselineResponses, fetchImpl });
  assert.equal(o.findings.identicalAfterStrippingVolatile, false);
  assert.deepEqual(o.findings.differingFields, ['answer']);
});

// ---------------------------------------------------------------------------
// Budget, across every mode
// ---------------------------------------------------------------------------

test('no Family C probe ever exceeds its published request budget, in any mode', async () => {
  // The 30-request cap is an abuse limit, and it only holds if each probe
  // holds. 'hanging' is left out on purpose: ten timeouts is a two-minute
  // test, and the timeout path belongs to slow_client.
  for (const mode of ['honest', 'sloppy', 'crashy', 'echoer']) {
    agent.setMode(mode);
    agent.reset();

    const inj = await injectionCanary(target);
    assert.ok(inj.requestsUsed <= REQUEST_BUDGET.injection_canary, `${mode}: injection over budget`);
    assert.equal(inj.requestsUsed, agent.state.requestCount);

    const con = await contradictoryConstraint(target);
    assert.ok(con.requestsUsed <= REQUEST_BUDGET.contradictory_constraint, `${mode}: contradiction over budget`);

    const dif = await differentialCorruption(target, { baselineResponses: await realBaselinePair() });
    assert.ok(dif.requestsUsed <= REQUEST_BUDGET.differential_corruption, `${mode}: differential over budget`);
  }
});
