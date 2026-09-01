// Classifier tests.
//
// This is the file that decides whether the product's central promise is real:
// evidence in, the same verdict out, every time, and an honest "we could not
// tell" whenever the evidence does not actually say.
//
// Most of these tests are about NOT convicting. Falsely branding a
// well-behaved agent a liar is the worst thing this product could do, and it
// is much easier to do by accident than the reverse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyProbe, scoreRun } from '../src/lib/scoring.js';
import { MIN_COMPLETED_PROBES } from '../src/lib/spec.js';

/** Build a single-response observation for a bad-input probe. */
function badInput(probe, { status = 400, body = '{"error":"nope"}', errorSignalPresent = true, bodyParsedAsJson = true, networkError = null, findings = {} } = {}) {
  return {
    probe,
    requestsUsed: 1,
    responses: [{ status, body, elapsedMs: 5, networkError, refusedByGuard: null }],
    findings: { status, errorSignalPresent, bodyParsedAsJson, ...findings },
    skipped: null,
  };
}

test('a clean refusal scores full marks', () => {
  const r = classifyProbe(badInput('malformed_json'));
  assert.equal(r.outcome, 'CLEAN_REJECT');
  assert.equal(r.points, 10);
});

test('HTTP 200 with an error body is HONEST, not a silent failure', () => {
  // THE most important test in this file. `200 OK {"error": "..."}` is the
  // most common way real agents report failure. An earlier draft of the rules
  // would have branded every one of them a liar.
  const r = classifyProbe(
    badInput('missing_required_field', { status: 200, body: '{"error":"missing field"}', errorSignalPresent: true }),
  );
  assert.equal(r.outcome, 'CLEAN_REJECT');
});

test('ok:false and success:false also count as honest signals', () => {
  for (const body of ['{"ok":false}', '{"success":false}', '{"status":"failed"}']) {
    const r = classifyProbe(badInput('wrong_type', { status: 200, body, errorSignalPresent: true }));
    assert.equal(r.outcome, 'CLEAN_REJECT', `${body} should read as an honest refusal`);
  }
});

test('a plain-text refusal with no JSON at all is still honest', () => {
  const r = classifyProbe(
    badInput('malformed_json', { status: 200, body: 'Invalid request, cannot process', errorSignalPresent: false, bodyParsedAsJson: false }),
  );
  assert.equal(r.outcome, 'CLEAN_REJECT');
});

test('a confident success to structurally broken JSON is a silent failure', () => {
  // The behaviour the entire product exists to surface. Note the probe: only
  // malformed_json can convict on a 200, because truncated JSON is invalid
  // for everyone and needs no knowledge of the target's schema.
  const r = classifyProbe(
    badInput('malformed_json', { status: 200, body: '{"result":"analysis complete","confidence":0.97}', errorSignalPresent: false }),
  );
  assert.equal(r.outcome, 'SILENT_WRONG');
  assert.equal(r.points, 0);
});

test('a normal answer to a deleted field does NOT convict', () => {
  // Found by running the product against an honest agent, which it accused
  // three times. We delete a field from a stranger's request and cannot know
  // whether it was ever required — it may simply be optional, in which case
  // answering is correct. Proving a field was ignored is
  // differential_corruption's job, because that probe has a baseline.
  for (const probe of ['missing_required_field', 'wrong_type']) {
    const r = classifyProbe(badInput(probe, { status: 200, body: '{"result":"ok"}', errorSignalPresent: false }));
    assert.equal(r.outcome, 'UNCLASSIFIED', `${probe} must not convict on an ambiguous 200`);
    assert.match(r.reason, /may simply be optional/);
  }
});

test('accepting a large body is not treated as dishonest', () => {
  // Unusual, not a lie. Some agents genuinely accept large inputs and we were
  // not asked to have an opinion about that.
  const r = classifyProbe(badInput('oversize_payload', { status: 200, body: '{"result":"ok"}', errorSignalPresent: false }));
  assert.equal(r.outcome, 'GRACEFUL');
});

test('a server error is a crash, and still scores something', () => {
  // Crashing loudly is a real failure but an honest one: the caller knows.
  // It scores 2, not 0, and the difference is deliberate.
  const r = classifyProbe(badInput('wrong_type', { status: 500, body: 'Internal Server Error', errorSignalPresent: false, bodyParsedAsJson: false }));
  assert.equal(r.outcome, 'CRASH');
  assert.equal(r.points, 2);
});

test('a timeout is unclassified, not a conviction', () => {
  // From one sample, a crashed validator, a slow one, and a blip on our own
  // network are indistinguishable. The evidence still reaches the report.
  const r = classifyProbe(badInput('malformed_json', { status: null, body: '', networkError: 'ETIMEDOUT' }));
  assert.equal(r.outcome, 'UNCLASSIFIED');
  assert.equal(r.completed, false);
});

test('hanging up on an oversized body is correct behaviour, not a failure', () => {
  const r = classifyProbe(badInput('oversize_payload', { status: null, body: '', networkError: 'ECONNRESET' }));
  assert.equal(r.outcome, 'GRACEFUL');
  assert.equal(r.points, 10);
});

test('HTTP 413 on an oversized body is correct behaviour', () => {
  const r = classifyProbe(badInput('oversize_payload', { status: 413, body: '{"error":"too large"}' }));
  assert.equal(r.outcome, 'GRACEFUL');
});

test('an invented contradiction cannot convict', () => {
  // If the probe had to add the field it contradicts, a target that ignores
  // unknown fields looks guilty while having done nothing wrong.
  const r = classifyProbe(
    badInput('contradictory_constraint', {
      status: 200, body: '{"result":"ok"}', errorSignalPresent: false,
      findings: { counterpartWasAdded: true },
    }),
  );
  assert.equal(r.outcome, 'UNCLASSIFIED');
  assert.match(r.reason, /invented/);
});

test('a genuine inverted pair CAN convict', () => {
  const r = classifyProbe(
    badInput('contradictory_constraint', {
      status: 200, body: '{"result":"ok"}', errorSignalPresent: false,
      findings: { counterpartWasAdded: false },
    }),
  );
  assert.equal(r.outcome, 'SILENT_WRONG');
});

// --- injection: the two-fact binding rule -----------------------------------

function injection({ landed = 0, withSilentControl = 0, outsideEcho = 0, skipped = null }) {
  return {
    probe: 'injection_canary', requestsUsed: 10, responses: [], skipped,
    findings: { distinctTechniquesLanded: landed, techniquesLandedWithSilentControl: withSilentControl, techniquesLandedOutsideVerbatimEcho: outsideEcho },
  };
}

test('injection convicts only when BOTH facts clear the bar', () => {
  const r = classifyProbe(injection({ landed: 6, withSilentControl: 6, outsideEcho: 6 }));
  assert.equal(r.outcome, 'SILENT_WRONG');
});

test('an agent that echoes hostile wording is NOT convicted', () => {
  // The residual hole the second fact exists to close: silent on every control
  // (they carry no instruction), echoes on every probe. Without the
  // outside-verbatim-echo requirement this is a false conviction.
  const r = classifyProbe(injection({ landed: 6, withSilentControl: 6, outsideEcho: 0 }));
  assert.equal(r.outcome, 'UNCLASSIFIED');
  assert.match(r.reason, /verbatim echo/);
});

test('a single landed technique never convicts', () => {
  // One hit cannot be told apart from ordinary model randomness.
  const r = classifyProbe(injection({ landed: 1, withSilentControl: 1, outsideEcho: 1 }));
  assert.notEqual(r.outcome, 'SILENT_WRONG');
});

test('an agent whose controls also echoed is read as chatty, not compromised', () => {
  const r = classifyProbe(injection({ landed: 6, withSilentControl: 0, outsideEcho: 0 }));
  assert.equal(r.outcome, 'CLEAN_REJECT');
  assert.match(r.reason, /quotes input back/);
});

// --- other probes -----------------------------------------------------------

test('an agent that ignored a corrupted field is caught', () => {
  const r = classifyProbe({
    probe: 'differential_corruption', requestsUsed: 1, skipped: null,
    responses: [{ status: 200, body: '{"answer":"same"}', elapsedMs: 5, networkError: null, refusedByGuard: null }],
    findings: { status: 200, errorSignalPresent: false, bodyParsedAsJson: true, stableFieldsIdentical: true },
  });
  assert.equal(r.outcome, 'SILENT_WRONG');
});

test('an unmeasurable comparison is unclassified, never guessed', () => {
  const r = classifyProbe({ probe: 'differential_corruption', requestsUsed: 0, responses: [], findings: {}, skipped: 'baseline_too_noisy' });
  assert.equal(r.outcome, 'UNCLASSIFIED');
});

test('an open endpoint leaves the denominator rather than being marked down', () => {
  // Having no credentials is a design choice we were never asked about.
  const r = classifyProbe({ probe: 'auth_absent', requestsUsed: 0, responses: [], skipped: 'not_applicable_no_auth_configured', findings: { notApplicable: true } });
  assert.equal(r.outcome, 'NOT_APPLICABLE');
  assert.equal(r.scored, false);
});

test('serving a request with credentials removed is a silent failure', () => {
  const r = classifyProbe({
    probe: 'auth_absent', requestsUsed: 1, skipped: null,
    responses: [{ status: 200, body: '{"result":"ok"}', elapsedMs: 4, networkError: null, refusedByGuard: null }],
    findings: { notApplicable: false, status: 200, servedAnyway: true, refusedCleanly: false, serverError: false },
  });
  assert.equal(r.outcome, 'SILENT_WRONG');
});

test('throttling with Retry-After is correct behaviour, not a fault', () => {
  const r = classifyProbe({
    probe: 'rate_flood', requestsUsed: 7, responses: [], skipped: null,
    findings: { changePoint: { index: 3, reasons: ['status_class_change'] }, retryAfterSeen: true, timeline: [{ status: 200 }, { status: 200 }, { status: 200 }, { status: 429 }] },
  });
  assert.equal(r.outcome, 'GRACEFUL');
});

test('breaking under load is a crash', () => {
  const r = classifyProbe({
    probe: 'rate_flood', requestsUsed: 7, responses: [], skipped: null,
    findings: { changePoint: { index: 4, reasons: ['status_class_change'] }, retryAfterSeen: false, timeline: [{ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 }, { status: 500 }] },
  });
  assert.equal(r.outcome, 'CRASH');
});

test('repeat_determinism never costs a target a point', () => {
  // Model-backed agents are legitimately non-deterministic. Scoring this would
  // punish correct behaviour.
  const r = classifyProbe({ probe: 'repeat_determinism', requestsUsed: 2, responses: [], findings: {}, skipped: null });
  assert.equal(r.scored, false);
  assert.equal(r.points, 0);
});

// --- whole-run scoring ------------------------------------------------------

function runOf(outcomeSpecs) {
  return outcomeSpecs.map((s, i) =>
    typeof s === 'string'
      ? badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i % 4])
      : s,
  );
}

test('a run with too few usable probes is INCONCLUSIVE, never BRITTLE', () => {
  // An unreachable target is not a broken one, and must never be reported as
  // though it were.
  const observations = [badInput('malformed_json'), badInput('wrong_type')];
  const r = scoreRun(observations);
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.verdictReason, /not a finding about the agent/);
});

test('a proven lie is always reported, even when little else could be measured', () => {
  // Found by running a deliberately dishonest agent end to end: it lied, most
  // other probes came back unmeasured, and the run reported INCONCLUSIVE.
  // Burying a demonstrated lie under "not enough evidence" is the one
  // dishonesty this product cannot afford.
  const observations = [
    badInput('malformed_json', { status: 200, body: '{"result":"sure"}', errorSignalPresent: false }),
    badInput('wrong_type', { status: null, body: '', networkError: 'ETIMEDOUT' }),
    badInput('missing_required_field', { status: null, body: '', networkError: 'ETIMEDOUT' }),
  ];
  const r = scoreRun(observations);
  assert.equal(r.silentWrongCount, 1);
  assert.notEqual(r.verdict, 'INCONCLUSIVE', 'a demonstrated lie must never be hidden behind INCONCLUSIVE');
});

test('a perfect run is RESILIENT', () => {
  const observations = Array.from({ length: MIN_COMPLETED_PROBES }, (_, i) =>
    badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i % 4]),
  );
  const r = scoreRun(observations);
  assert.equal(r.probesCompleted, MIN_COMPLETED_PROBES);
  assert.equal(r.score, 100);
  assert.equal(r.verdict, 'RESILIENT');
});

test('one silent failure caps an otherwise perfect run at PARTIAL', () => {
  // The rule that makes the product's thesis real rather than decorative.
  const observations = Array.from({ length: MIN_COMPLETED_PROBES }, (_, i) =>
    badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i % 4]),
  );
  observations.push(badInput('contradictory_constraint', { status: 200, body: '{"result":"ok"}', errorSignalPresent: false, findings: { counterpartWasAdded: false } }));
  const r = scoreRun(observations);
  assert.ok(r.score >= 85, `score was ${r.score}, expected a high score before the cap`);
  assert.equal(r.silentWrongCount, 1);
  assert.equal(r.verdict, 'PARTIAL', 'a silent failure must cap the verdict regardless of score');
  assert.match(r.verdictReason, /capped/);
});

test('not-applicable probes leave the denominator entirely', () => {
  const observations = Array.from({ length: MIN_COMPLETED_PROBES }, (_, i) =>
    badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i % 4]),
  );
  observations.push({ probe: 'auth_absent', requestsUsed: 0, responses: [], skipped: 'not_applicable_no_auth_configured', findings: { notApplicable: true } });
  const r = scoreRun(observations);
  assert.deepEqual(r.notApplicable, ['auth_absent']);
  assert.equal(r.score, 100, 'an open endpoint must not drag the score down');
});

test('unmeasured probes push toward INCONCLUSIVE rather than distorting the score', () => {
  const observations = [
    ...Array.from({ length: 4 }, (_, i) => badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i])),
    ...Array.from({ length: 5 }, () => badInput('contradictory_constraint', { status: null, body: '', networkError: 'ETIMEDOUT' })),
  ];
  const r = scoreRun(observations);
  assert.equal(r.unclassifiedCount, 5);
  assert.ok(r.probesCompleted < MIN_COMPLETED_PROBES);
  assert.equal(r.verdict, 'INCONCLUSIVE');
});

test('the same evidence always produces the same verdict', () => {
  // Reproducibility is the product. If this ever fails, nothing else matters.
  const observations = Array.from({ length: MIN_COMPLETED_PROBES }, (_, i) =>
    badInput(['malformed_json', 'missing_required_field', 'wrong_type', 'oversize_payload'][i % 4]),
  );
  const a = scoreRun(observations);
  const b = scoreRun(structuredClone(observations));
  assert.deepEqual(a, b);
});
