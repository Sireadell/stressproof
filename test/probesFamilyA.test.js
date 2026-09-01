// Family A probe tests: malformed_json, missing_required_field, wrong_type,
// oversize_payload.
//
// These four are the "does the target even validate its input" probes — the
// cheapest, most basic honesty check StressProof runs. Every test here is
// really testing one thing: does the probe hand back facts the classifier
// can trust, without ever deciding a verdict itself (see probeContract.js).
//
// 'hanging' mode is deliberately not exercised here — it is a 120s timer by
// design (see fakeAgent.js) and belongs in a probe that specifically tests
// timeout handling, not in every probe's test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeAgent, fixtureTarget } from './fixtures/fakeAgent.js';
import { malformedJson } from '../src/lib/probes/malformedJson.js';
import { missingRequiredField } from '../src/lib/probes/missingRequiredField.js';
import { wrongType } from '../src/lib/probes/wrongType.js';
import { oversizePayload } from '../src/lib/probes/oversizePayload.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../src/lib/spec.js';

/** Spin up a fake agent in the given mode, run the callback against it, and
 * always tear the server down — even if the callback throws — so a failing
 * assertion cannot leak a listening socket into the next test. */
async function withAgent(opts, run) {
  const agent = createFakeAgent(opts);
  const url = await agent.listen();
  try {
    await run(url, agent);
  } finally {
    agent.close();
  }
}

// ---------------------------------------------------------------------------
// malformed_json
// ---------------------------------------------------------------------------

test('malformed_json: honest mode cleanly rejects the truncated body', async () => {
  // The baseline every probe is judged against: an honest agent notices the
  // body is broken and says so with a 400 and a real JSON error shape.
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url);
    const obs = await malformedJson(target);
    assert.equal(obs.probe, 'malformed_json');
    assert.equal(obs.skipped, null);
    assert.equal(obs.requestsUsed, 1);
    assert.equal(obs.findings.status, 400);
    assert.equal(obs.findings.bodyParsedAsJson, true);
    assert.equal(obs.findings.errorSignalPresent, true);
  });
});

test('malformed_json: sloppy mode returns 200 with no error signal — the silent lie', async () => {
  // This is the exact case StressProof exists to catch: the target did not
  // even try to parse the body, yet answered as if everything were fine. The
  // probe's job is only to record that fact, not to say it is bad.
  await withAgent({ mode: 'sloppy' }, async (url) => {
    const target = fixtureTarget(url);
    const obs = await malformedJson(target);
    assert.equal(obs.findings.status, 200);
    assert.equal(obs.findings.bodyParsedAsJson, true); // the RESPONSE body is valid JSON
    assert.equal(obs.findings.errorSignalPresent, false); // but it carries no error signal
  });
});

test('malformed_json: crashy mode fails loudly with a non-JSON 500', async () => {
  // Bad, but honestly bad — a 500 is not the silent failure this product is
  // built to detect, and the probe should record that distinction as facts
  // (non-JSON body) rather than collapsing it into the same shape as sloppy.
  await withAgent({ mode: 'crashy' }, async (url) => {
    const target = fixtureTarget(url);
    const obs = await malformedJson(target);
    assert.equal(obs.findings.status, 500);
    assert.equal(obs.findings.bodyParsedAsJson, false);
  });
});

test('malformed_json: echoer mode is caught as echoing the input, without being misread as sloppy', async () => {
  // The whole reason the fixture has an 'echoer' mode (see fakeAgent.js): a
  // well-behaved agent that quotes bad input back in its error must not be
  // scored the same as one that ignored the input. The probe's only job here
  // is to notice the echo as a fact.
  await withAgent({ mode: 'echoer' }, async (url) => {
    const target = fixtureTarget(url);
    const obs = await malformedJson(target);
    assert.equal(obs.findings.status, 400);
    assert.equal(obs.findings.errorSignalPresent, true);
    assert.equal(obs.findings.echoedMutatedInput, true);
  });
});

test('malformed_json: never exceeds its 1-request budget', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const obs = await malformedJson(fixtureTarget(url));
    assert.ok(obs.requestsUsed <= REQUEST_BUDGET.malformed_json);
  });
});

// ---------------------------------------------------------------------------
// missing_required_field
// ---------------------------------------------------------------------------

// A sample body with only the two fields fakeAgent actually requires, sorted
// so 'query' — a required field — is the deterministic first pick from
// editableKeys(). This is what lets the test show a genuine rejection rather
// than an accidental no-op from removing an optional field.
const REQUIRED_ONLY_BODY = { query: 'what is the weather', wallet: '0xabc' };

test('missing_required_field: honest mode rejects the request once a required key is gone', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: REQUIRED_ONLY_BODY });
    const obs = await missingRequiredField(target);
    assert.equal(obs.skipped, null);
    assert.equal(obs.requestsUsed, 1);
    // 'query' sorts before 'wallet', so it is the deterministic first pick.
    assert.equal(obs.findings.fieldRemoved, 'query');
    assert.equal(obs.findings.status, 400);
    assert.equal(obs.findings.errorSignalPresent, true);
  });
});

test('missing_required_field: sloppy mode answers anyway with no error signal', async () => {
  // Silent-lie case again: the required field is gone and the agent still
  // hands back a confident-looking 200.
  await withAgent({ mode: 'sloppy' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: REQUIRED_ONLY_BODY });
    const obs = await missingRequiredField(target);
    assert.equal(obs.findings.status, 200);
    assert.equal(obs.findings.errorSignalPresent, false);
  });
});

test('missing_required_field: field selection is deterministic across runs', async () => {
  // Reproducibility matters: two runs against the same target must mutate
  // the same field, or the run is not reproducible.
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: REQUIRED_ONLY_BODY });
    const first = await missingRequiredField(target);
    const second = await missingRequiredField(target);
    assert.equal(first.findings.fieldRemoved, second.findings.fieldRemoved);
  });
});

test('missing_required_field: skips rather than inventing a result when the sample body has no keys', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: {} });
    const obs = await missingRequiredField(target);
    assert.equal(obs.requestsUsed, 0);
    assert.equal(obs.responses.length, 0);
    assert.ok(obs.skipped, 'must record a reason rather than a fake finding');
  });
});

test('missing_required_field: never exceeds its 1-request budget', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const obs = await missingRequiredField(fixtureTarget(url));
    assert.ok(obs.requestsUsed <= REQUEST_BUDGET.missing_required_field);
  });
});

// ---------------------------------------------------------------------------
// wrong_type
// ---------------------------------------------------------------------------

// Same reasoning as REQUIRED_ONLY_BODY above: fakeAgent only type-checks
// 'query', so a body where 'query' is the first editable key demonstrates an
// actual rejection rather than a silently-ignored mutation of an untyped
// field like max_results.
const QUERY_FIRST_BODY = { query: 'what is the weather', wallet: '0xabc' };

test('wrong_type: honest mode rejects the request once query is no longer a string', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: QUERY_FIRST_BODY });
    const obs = await wrongType(target);
    assert.equal(obs.skipped, null);
    assert.equal(obs.requestsUsed, 1);
    assert.equal(obs.findings.fieldFlipped, 'query');
    assert.equal(obs.findings.originalType, 'string');
    assert.equal(obs.findings.newType, 'number');
    assert.equal(obs.findings.status, 400);
    assert.equal(obs.findings.errorSignalPresent, true);
  });
});

test('wrong_type: sloppy mode answers anyway with no error signal', async () => {
  await withAgent({ mode: 'sloppy' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: QUERY_FIRST_BODY });
    const obs = await wrongType(target);
    assert.equal(obs.findings.status, 200);
    assert.equal(obs.findings.errorSignalPresent, false);
  });
});

test('wrong_type: field selection is deterministic across runs', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: QUERY_FIRST_BODY });
    const first = await wrongType(target);
    const second = await wrongType(target);
    assert.equal(first.findings.fieldFlipped, second.findings.fieldFlipped);
    assert.equal(first.findings.newType, second.findings.newType);
  });
});

test('wrong_type: skips rather than inventing a result when nothing in the body is flippable', async () => {
  // booleans and nested objects fall outside the string/number/array cycle
  // this probe is scoped to.
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url, { sampleBody: { active: true, meta: { a: 1 } } });
    const obs = await wrongType(target);
    assert.equal(obs.requestsUsed, 0);
    assert.equal(obs.responses.length, 0);
    assert.ok(obs.skipped, 'must record a reason rather than a fake finding');
  });
});

test('wrong_type: never exceeds its 1-request budget', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const obs = await wrongType(fixtureTarget(url));
    assert.ok(obs.requestsUsed <= REQUEST_BUDGET.wrong_type);
  });
});

// ---------------------------------------------------------------------------
// oversize_payload
// ---------------------------------------------------------------------------

test('oversize_payload: sends exactly THRESHOLDS.OVERSIZE_PAYLOAD_BYTES, not merely "a lot"', async () => {
  // 1 MB is a deliberate, published ceiling (see spec.js) — a metered target
  // pays for whatever we send it, so "exactly the threshold" matters, not
  // "roughly the threshold".
  await withAgent({ mode: 'honest' }, async (url) => {
    const target = fixtureTarget(url);
    const obs = await oversizePayload(target);
    assert.equal(obs.skipped, null);
    assert.equal(obs.requestsUsed, 1);
    assert.equal(obs.findings.sentBytes, THRESHOLDS.OVERSIZE_PAYLOAD_BYTES);
    assert.equal(obs.findings.targetBytes, THRESHOLDS.OVERSIZE_PAYLOAD_BYTES);
  });
});

test('oversize_payload: the sample body still round-trips through cloneBody unmutated', async () => {
  // A regression this specifically guards against: padding the clone must
  // never touch the caller's original sampleBody object.
  await withAgent({ mode: 'honest' }, async (url) => {
    const sampleBody = { query: 'what is the weather', wallet: '0xabc' };
    const target = fixtureTarget(url, { sampleBody });
    await oversizePayload(target);
    assert.deepEqual(sampleBody, { query: 'what is the weather', wallet: '0xabc' });
  });
});

test('oversize_payload: never exceeds its 1-request budget', async () => {
  await withAgent({ mode: 'honest' }, async (url) => {
    const obs = await oversizePayload(fixtureTarget(url));
    assert.ok(obs.requestsUsed <= REQUEST_BUDGET.oversize_payload);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: cloneBody discipline
// ---------------------------------------------------------------------------

test('missing_required_field and wrong_type never mutate the shared sample body', async () => {
  // Every probe clones before mutating (cloneBody, probeContract.js). If one
  // probe corrupted the shared sample, every probe that runs after it in
  // PROBE_ORDER would be working from a poisoned body.
  await withAgent({ mode: 'honest' }, async (url) => {
    const sampleBody = { query: 'what is the weather', wallet: '0xabc' };
    const target = fixtureTarget(url, { sampleBody });
    await missingRequiredField(target);
    await wrongType(target);
    assert.deepEqual(sampleBody, { query: 'what is the weather', wallet: '0xabc' });
  });
});
