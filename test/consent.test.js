// Consent tests.
//
// These decide whether StressProof is a testing tool or a way to throw traffic
// at strangers. Each test is a way somebody could try to get a run started
// against a target they do not control.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueChallenge,
  verifyChallenge,
  parseConsentFile,
  authoritativeOrigin,
  _resetConsentState,
  _peekRun,
  WELL_KNOWN_PATH,
} from '../src/lib/consent.js';
import { THRESHOLDS } from '../src/lib/spec.js';

const TARGET = 'https://example.com/v1/agent';
const PAYER = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

/** A stand-in for the network: serves whatever consent file a test wants. */
function fakeFetcher(bodyOrOpts) {
  const o = typeof bodyOrOpts === 'string' ? { body: bodyOrOpts } : bodyOrOpts;
  return async () => ({
    ok: true, status: 200, headers: {}, body: '', bytes: 0,
    truncated: false, elapsedMs: 1, networkError: null, refusedByGuard: null,
    ...o,
  });
}

function goodFile(run, { target = TARGET, payer = PAYER } = {}) {
  return `challenge=${run.challengeCode}\npayer=${payer.toLowerCase()}\ntarget=${target}\n`;
}

beforeEach(() => _resetConsentState());

test('consent is required at the target\'s own origin', () => {
  assert.equal(authoritativeOrigin('https://example.com/v1/agent?x=1'), 'https://example.com');
  // A different port is a different origin — one tenant must not consent for another.
  assert.equal(authoritativeOrigin('https://example.com:8443/agent'), 'https://example.com:8443');
});

test('issuing a challenge returns a code, a deadline and plain instructions', async () => {
  const r = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.challengeCode, /^sp-[0-9a-f]{32}$/);
  assert.equal(r.consentUrl, `https://example.com${WELL_KNOWN_PATH}`);
  assert.equal(r.willSendAtMost, 30);
  assert.match(r.instructions, /challenge=/);
  assert.match(r.instructions, /payer=/);
  assert.match(r.instructions, /target=/);
});

test('a private target is refused before any code is issued', async () => {
  const r = await issueChallenge({ targetUrl: 'https://localhost:3000/agent', payerAddress: PAYER });
  assert.equal(r.ok, false);
});

test('a plain-http target is refused', async () => {
  const r = await issueChallenge({ targetUrl: 'http://example.com/agent', payerAddress: PAYER });
  assert.equal(r.ok, false);
});

test('a run cannot start without a paying wallet', async () => {
  const r = await issueChallenge({ targetUrl: TARGET, payerAddress: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /wallet/);
});

test('a correct consent file starts the run', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  const v = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(goodFile(run)) });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.maxRequests, 30);
});

test('a file with no challenge line is refused', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyChallenge({
    runId: issued.runId,
    fetchImpl: fakeFetcher(`payer=${PAYER.toLowerCase()}\ntarget=${TARGET}\n`),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no challenge/);
});

test('a stale code from an earlier run is refused', async () => {
  // The whole reason this is a one-time code: a permission file left up from
  // last time must not authorise a new run.
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyChallenge({
    runId: issued.runId,
    fetchImpl: fakeFetcher(`challenge=sp-${'0'.repeat(32)}\npayer=${PAYER.toLowerCase()}\ntarget=${TARGET}\n`),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different code|earlier run/);
});

test('an expired code is refused even if the file is perfect', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  const file = goodFile(run);
  const later = Date.now() + THRESHOLDS.CONSENT_CHALLENGE_TTL_MS + 1000;
  const v = await verifyChallenge({ runId: issued.runId, now: later, fetchImpl: fakeFetcher(file) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /expired/);
});

test('consent for one wallet cannot be used by another', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  const v = await verifyChallenge({
    runId: issued.runId,
    fetchImpl: fakeFetcher(goodFile(run, { payer: '0x2222222222222222222222222222222222222222' })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different paying wallet/);
});

test('consent for one endpoint cannot authorise another', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  const v = await verifyChallenge({
    runId: issued.runId,
    fetchImpl: fakeFetcher(goodFile(run, { target: 'https://example.com/v1/other-agent' })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different target/);
});

test('a missing consent file is refused with a clear reason', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher({ status: 404, body: 'Not Found' }) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /404/);
});

test('an oversized consent file is refused', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher({ truncated: true, body: 'x' }) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /4KB/);
});

test('a verified run cannot be started twice', async () => {
  // Otherwise one consent buys unlimited runs.
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  const first = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(goodFile(run)) });
  assert.equal(first.ok, true);
  const second = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(goodFile(run)) });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already been started/);
});

test('an unknown run id is refused', async () => {
  const v = await verifyChallenge({ runId: 'made-up', fetchImpl: fakeFetcher('') });
  assert.equal(v.ok, false);
});

test('the same target cannot be run again immediately, even by a different payer', async () => {
  // Paying repeatedly must not amount to unlimited flooding.
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(goodFile(run)) });

  const again = await issueChallenge({
    targetUrl: TARGET,
    payerAddress: '0x3333333333333333333333333333333333333333',
  });
  assert.equal(again.ok, false);
  assert.match(again.reason, /recently/);
  assert.ok(again.retryAfterMs > 0);
});

test('the cooldown lifts once enough time has passed', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const run = _peekRun(issued.runId);
  await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(goodFile(run)) });

  const later = Date.now() + THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET + 1000;
  const again = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER, now: later });
  assert.equal(again.ok, true, again.reason);
});

test('consent file parsing tolerates comments, blank lines and stray whitespace', () => {
  const parsed = parseConsentFile(
    '# StressProof consent\n\n  challenge = sp-abc \n\npayer=0xAAA\n\n  target=https://x.example/a\n',
  );
  assert.equal(parsed.challenge, 'sp-abc');
  assert.equal(parsed.payer, '0xAAA');
  assert.equal(parsed.target, 'https://x.example/a');
});

test('the first value wins if a key appears twice', () => {
  // A file that says two different things must not be resolvable by picking
  // whichever line is convenient.
  const parsed = parseConsentFile('challenge=first\nchallenge=second\n');
  assert.equal(parsed.challenge, 'first');
});
