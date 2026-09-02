// Standing consent tests.
//
// Standing consent is the mode that makes unattended re-certification
// possible, and it is the mode that could most easily become a way to keep
// firing traffic at a target long after its owner stopped meaning to allow it.
// Every test here is a way somebody could try to turn a permission an owner
// meant narrowly into one they did not mean at all.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueChallenge,
  issueStandingRun,
  verifyChallenge,
  verifyStandingConsent,
  verifyConsent,
  _resetConsentState,
  _peekRun,
} from '../src/lib/consent.js';
import { CONSENT_POLICY, THRESHOLDS } from '../src/lib/spec.js';

const TARGET = 'https://example.com/v1/agent';
const PAYER = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

function fakeFetcher(body) {
  return async () => ({
    ok: true, status: 200, headers: {}, body, bytes: 0,
    truncated: false, elapsedMs: 1, networkError: null, refusedByGuard: null,
  });
}

function standingFile({
  target = TARGET,
  payer = PAYER,
  expiresInMs = 7 * 86_400_000,
  minHours = 24,
  marker = 'yes',
  now = Date.now(),
} = {}) {
  const lines = [];
  if (marker !== null) lines.push(`standing=${marker}`);
  lines.push(`payer=${payer.toLowerCase()}`);
  lines.push(`target=${target}`);
  if (expiresInMs !== null) lines.push(`expires=${new Date(now + expiresInMs).toISOString()}`);
  if (minHours !== null) lines.push(`min-hours-between-runs=${minHours}`);
  return lines.join('\n') + '\n';
}

function oneTimeFile(run) {
  return `challenge=${run.challengeCode}\npayer=${PAYER.toLowerCase()}\ntarget=${TARGET}\n`;
}

beforeEach(() => _resetConsentState());

test('a standing run is issued with no code and plain instructions', async () => {
  const r = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.consentMode, 'standing');
  assert.equal(r.challengeCode, undefined);
  assert.match(r.instructions, /standing=yes/);
  assert.match(r.instructions, /expires=/);
  assert.match(r.instructions, /min-hours-between-runs=/);
  assert.equal(r.maxPermissionDays, 30);
});

test('a complete standing file authorises the run', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(standingFile()) });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.consentMode, 'standing');
  assert.equal(v.targetUrl, TARGET);
  assert.equal(v.payerAddress, PAYER.toLowerCase());
  assert.equal(v.ownerMinHoursBetweenRuns, 24);
});

test('the standing file is re-fetched every run, so deleting it stops the next one', async () => {
  // This is the whole safety argument for dropping the per-run code. A file
  // that passed last time must not carry a run this time.
  let served = standingFile();
  const fetcher = async () => ({
    ok: true, status: 200, headers: {}, body: served, bytes: 0,
    truncated: false, elapsedMs: 1, networkError: null, refusedByGuard: null,
  });

  const first = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  assert.equal((await verifyStandingConsent({ runId: first.runId, fetchImpl: fetcher })).ok, true);

  served = '';
  const later = Date.now() + 25 * 3_600_000;
  const second = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER, now: later });
  const v = await verifyStandingConsent({ runId: second.runId, now: later, fetchImpl: fetcher });
  assert.equal(v.ok, false);
  assert.match(v.reason, /standing=yes/);
});

test('a one-time consent file is never read as a standing permission', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const file = `challenge=sp-whatever\npayer=${PAYER.toLowerCase()}\ntarget=${TARGET}\n`;
  const v = await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(file) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a standing permission/);
});

test('a standing run cannot be started through the one-time code path', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyChallenge({ runId: issued.runId, fetchImpl: fakeFetcher(standingFile()) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /one-time code/);
});

test('a one-time run cannot be started through the standing path', async () => {
  const issued = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(standingFile()) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /one-time code/);
});

test('verifyConsent picks the mode the run was issued under', async () => {
  const standing = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyConsent({ runId: standing.runId, fetchImpl: fakeFetcher(standingFile()) });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.consentMode, 'standing');

  const later = Date.now() + 25 * 3_600_000;
  const challenge = await issueChallenge({ targetUrl: TARGET, payerAddress: PAYER, now: later });
  const run = _peekRun(challenge.runId);
  const w = await verifyConsent({ runId: challenge.runId, now: later, fetchImpl: fakeFetcher(oneTimeFile(run)) });
  assert.equal(w.ok, true, w.reason);
  assert.equal(w.consentMode, 'challenge');
});

test('a standing file naming a different wallet is refused', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(standingFile({ payer: '0x3333333333333333333333333333333333333333' })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different paying wallet/);
});

test('a standing file naming a different target is refused', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(standingFile({ target: 'https://example.com/v1/other' })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /different target URL/);
});

test('an expired standing permission is refused and says how to renew it', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(standingFile({ expiresInMs: -1000 })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /expired/);
  assert.match(v.reason, /Renew/);
});

test('a permission with no expiry date at all is refused', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(standingFile({ expiresInMs: null })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /never end on its own/);
});

test('an unreadable expiry date is refused rather than guessed at', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const file = `standing=yes\npayer=${PAYER.toLowerCase()}\ntarget=${TARGET}\nexpires=soon\nmin-hours-between-runs=24\n`;
  const v = await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(file) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a date/);
});

test('the maximum lifetime is a ceiling regardless of what the file claims', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(
      standingFile({ expiresInMs: CONSENT_POLICY.STANDING_CONSENT_MAX_LIFETIME_MS + 86_400_000 }),
    ),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /further out than we accept/);
});

test('a file with no frequency limit is refused', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const v = await verifyStandingConsent({
    runId: issued.runId,
    fetchImpl: fakeFetcher(standingFile({ minHours: null })),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /min-hours-between-runs/);
});

test("the owner's frequency limit wins when it is the stricter of the two", async () => {
  const first = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const ok = await verifyStandingConsent({
    runId: first.runId,
    fetchImpl: fakeFetcher(standingFile({ minHours: 168 })),
  });
  assert.equal(ok.ok, true, ok.reason);

  // An hour later, StressProof's own 15-minute cooldown would allow this. The
  // owner said weekly, so it does not happen.
  const later = Date.now() + 3_600_000;
  const second = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER, now: later });
  const v = await verifyStandingConsent({
    runId: second.runId,
    now: later,
    fetchImpl: fakeFetcher(standingFile({ minHours: 168, now: later })),
  });
  assert.equal(v.ok, false);
  assert.equal(v.limitHit, 'owner');
  assert.match(v.reason, /your own consent file/);
  assert.ok(v.retryAfterMs > 0);
});

test('our own cooldown still applies when the owner writes something absurdly permissive', async () => {
  // Two run ids taken out before either has run, so the second one gets past
  // the cooldown check at issue time and has to be stopped at start time.
  // That is also the real race: a scheduler holding a run id it asked for
  // earlier must not be able to spend it inside the cooldown.
  const first = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  const second = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });

  const ok = await verifyStandingConsent({
    runId: first.runId,
    fetchImpl: fakeFetcher(standingFile({ minHours: 0 })),
  });
  assert.equal(ok.ok, true, ok.reason);

  const later = Date.now() + 60_000;
  const v = await verifyStandingConsent({
    runId: second.runId,
    now: later,
    fetchImpl: fakeFetcher(standingFile({ minHours: 0, now: later })),
  });
  assert.equal(v.ok, false);
  assert.equal(v.limitHit, 'stressproof');
  assert.match(v.reason, /own limit/);
});

test('the cooldown also refuses at issue time, and says which limit stopped it', async () => {
  const first = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  await verifyStandingConsent({ runId: first.runId, fetchImpl: fakeFetcher(standingFile()) });

  const again = await issueStandingRun({
    targetUrl: TARGET,
    payerAddress: PAYER,
    now: Date.now() + 60_000,
  });
  assert.equal(again.ok, false);
  assert.equal(again.limitHit, 'stressproof');
  assert.ok(again.retryAfterMs > 0);
});

test('a daily re-check is blocked by neither limit', async () => {
  // The reason standing consent exists at all. 24 hours clears StressProof's
  // 15-minute cooldown many times over and matches a 24-hour owner limit.
  assert.ok(THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET < 24 * 3_600_000);

  const first = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  assert.equal(
    (await verifyStandingConsent({ runId: first.runId, fetchImpl: fakeFetcher(standingFile()) })).ok,
    true,
  );

  const tomorrow = Date.now() + 24 * 3_600_000 + 1000;
  const second = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER, now: tomorrow });
  assert.equal(second.ok, true, second.reason);
  const v = await verifyStandingConsent({
    runId: second.runId,
    now: tomorrow,
    fetchImpl: fakeFetcher(standingFile({ now: tomorrow })),
  });
  assert.equal(v.ok, true, v.reason);
});

test('a standing run id cannot be replayed', async () => {
  const issued = await issueStandingRun({ targetUrl: TARGET, payerAddress: PAYER });
  assert.equal(
    (await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(standingFile()) })).ok,
    true,
  );
  const again = await verifyStandingConsent({ runId: issued.runId, fetchImpl: fakeFetcher(standingFile()) });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already been started/);
});

test('a standing run against a private address is refused before anything is issued', async () => {
  const r = await issueStandingRun({ targetUrl: 'https://localhost:3000/agent', payerAddress: PAYER });
  assert.equal(r.ok, false);
});

test('a standing run without a valid paying wallet is refused', async () => {
  const r = await issueStandingRun({ targetUrl: TARGET, payerAddress: 'not-a-wallet' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /paying wallet/);
});
