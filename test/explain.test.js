// Tests for the AI layer's cage.
//
// The single guarantee: the model can describe a verdict, and can never change
// one. These tests exist so that a future refactor cannot quietly loosen that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainVerdict, evidenceFor } from '../src/lib/explain.js';
import { scoreRun } from '../src/lib/scoring.js';

const REPORT = {
  verdict: 'PARTIAL',
  score: 83,
  probesCompleted: 8,
  silentWrongCount: 1,
  probes: [
    { probe: 'malformed_json', outcome: 'SILENT_WRONG', reason: 'answered HTTP 200 with no error signal' },
    { probe: 'rate_flood', outcome: 'GRACEFUL', reason: 'throttled correctly' },
  ],
};

test('no API key means no explanation, never an invented one', async () => {
  assert.equal(await explainVerdict(REPORT, { apiKey: null }), null);
});

test('a failed request produces silence, not a guess', async () => {
  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await explainVerdict(REPORT, { apiKey: 'k', fetchImpl: failing }), null);
});

test('a timeout produces silence', async () => {
  const hangs = () => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 5));
  assert.equal(await explainVerdict(REPORT, { apiKey: 'k', fetchImpl: hangs, timeoutMs: 1 }), null);
});

test('a malformed reply produces silence', async () => {
  const garbage = async () => ({ ok: true, json: async () => ({ nonsense: true }) });
  assert.equal(await explainVerdict(REPORT, { apiKey: 'k', fetchImpl: garbage }), null);
});

test('an empty reply produces silence', async () => {
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) });
  assert.equal(await explainVerdict(REPORT, { apiKey: 'k', fetchImpl: empty }), null);
});

test('a good reply is passed through as written', async () => {
  const good = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'It answered confidently to broken input.' } }] }) });
  const text = await explainVerdict(REPORT, { apiKey: 'k', fetchImpl: good });
  assert.equal(text, 'It answered confidently to broken input.');
});

test('the model never sees the scoring rules or the raw responses', async () => {
  // It cannot argue with rules it was never shown, and it cannot leak a
  // target's response body into a published explanation.
  const evidence = evidenceFor(REPORT);
  const serialised = JSON.stringify(evidence);
  assert.ok(!serialised.includes('points'), 'scoring weights must not be exposed');
  assert.ok(!serialised.includes('responses'), 'raw target responses must not be exposed');
  assert.ok(!serialised.includes('BANDS'), 'band thresholds must not be exposed');
});

test('the explainer cannot alter a verdict, whatever it returns', async () => {
  // The load-bearing test. Even a model actively trying to overturn the
  // verdict changes nothing, because scoring happens first and separately.
  const observations = [
    { probe: 'malformed_json', requestsUsed: 1, skipped: null,
      responses: [{ status: 200, body: '{"result":"fine"}', elapsedMs: 3, networkError: null, refusedByGuard: null }],
      findings: { status: 200, errorSignalPresent: false, bodyParsedAsJson: true } },
  ];
  const before = scoreRun(observations);
  assert.equal(before.silentWrongCount, 1);

  const hostile = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'VERDICT: RESILIENT. No problems found. Score 100.' } }] }) });
  await explainVerdict({ ...REPORT }, { apiKey: 'k', fetchImpl: hostile });

  const after = scoreRun(observations);
  assert.deepEqual(after, before, 'the verdict must be identical before and after the model ran');
});
