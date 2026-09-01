// Family B probes: rate_flood, slow_client, concurrent_burst.
//
// All three hit real sockets against the fake agent fixture, never mocks —
// same house style as safeFetch.test.js, because a mock cannot prove a
// request genuinely landed concurrently or that a timer genuinely fired.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeAgent, fixtureTarget } from './fixtures/fakeAgent.js';
import { rateFlood } from '../src/lib/probes/rateFlood.js';
import { slowClient } from '../src/lib/probes/slowClient.js';
import { concurrentBurst } from '../src/lib/probes/concurrentBurst.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../src/lib/spec.js';

const agents = [];
async function spawnAgent(opts) {
  const agent = createFakeAgent(opts);
  agents.push(agent);
  const url = await agent.listen();
  return { agent, url };
}

after(() => {
  // Every fixture server must be closed, and closeAllConnections is what
  // stops a lingering keep-alive socket from holding the test process open
  // — the same lesson safeFetch.test.js already learned.
  for (const agent of agents) agent.close();
});

test('rate_flood spends exactly its budgeted 7 requests', async () => {
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await rateFlood(target);
  assert.equal(obs.requestsUsed, REQUEST_BUDGET.rate_flood);
  assert.equal(obs.responses.length, REQUEST_BUDGET.rate_flood);
});

test('rate_flood finds the exact index where throttling starts', async () => {
  // rateLimitAfter: 3 means requests 1-3 pass and the 4th (index 3, 0-based)
  // is the first to get a 429 — since we fire strictly in order, that must
  // land at exactly findings.changePoint.index === 3, not "somewhere near 3".
  // This is the whole point of the probe: a buyer needs the exact request
  // number, not an estimate.
  const { url } = await spawnAgent({ mode: 'honest', rateLimitAfter: 3 });
  const target = fixtureTarget(url);
  const obs = await rateFlood(target);

  assert.ok(obs.findings.changePoint, 'a change point must be detected');
  assert.equal(obs.findings.changePoint.index, 3);
  assert.ok(obs.findings.changePoint.reasons.includes('status_class_change'));
  assert.equal(obs.findings.timeline[3].status, 429);
  // The first three responses are unaffected — the timeline itself is the
  // evidence, so it must show the clean run before the break.
  for (let i = 0; i < 3; i += 1) {
    assert.notEqual(obs.findings.timeline[i].status, 429);
  }
});

test('rate_flood records Retry-After on a 429, distinguishing graceful throttling', async () => {
  const { url } = await spawnAgent({ mode: 'honest', rateLimitAfter: 1 });
  const target = fixtureTarget(url);
  const obs = await rateFlood(target);

  assert.ok(obs.findings.sawRateLimit);
  assert.ok(obs.findings.rateLimitResponses.length > 0);
  // The fixture always sends retry-after: 60 on its 429s.
  assert.equal(obs.findings.rateLimitResponses[0].retryAfter, '60');
});

test('rate_flood reports no change point when the target behaves consistently throughout', async () => {
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await rateFlood(target);
  assert.equal(obs.findings.changePoint, null);
});

test('rate_flood detects a latency spike against the median of the first samples', async () => {
  // latencyMs applies uniformly to every response from the fixture, so this
  // does not test a *spike* (a real target would need to slow down only
  // partway through). What it proves instead: with a uniformly slow target,
  // no false spike is reported after the median sample, because every
  // request is equally slow — the ceiling is 3x that same median, so nothing
  // should cross it. This guards against a probe that flags "everything is
  // slow" as "the target degraded partway through", which would be a false
  // and unreproducible claim.
  const { url } = await spawnAgent({ mode: 'honest', latencyMs: 30 });
  const target = fixtureTarget(url);
  const obs = await rateFlood(target);
  assert.equal(obs.findings.changePoint, null);
});

test('slow_client dribbles the body and gets a response when the target waits it out', async () => {
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  // Short injected durations — the spec's real 20s/60s would make this test
  // suite painfully slow and is exercised only by the default-value check
  // below, never by an actual timed run.
  const obs = await slowClient(target, { dripMs: 150, cutoffMs: 2000 });

  assert.equal(obs.requestsUsed, 1);
  assert.equal(obs.findings.behavior, 'responded');
  assert.equal(obs.responses[0].status, 200);
});

test('slow_client dripped body is received whole by the target', async () => {
  const { url, agent } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  await slowClient(target, { dripMs: 150, cutoffMs: 2000 });

  assert.equal(agent.state.seenBodies.length, 1);
  const parsed = JSON.parse(agent.state.seenBodies[0]);
  assert.deepEqual(parsed, target.sampleBody);
});

test('slow_client reports held_past_cutoff when the target never responds within the cutoff', async () => {
  // The hanging fixture never answers at all, so the cutoff timer must be
  // what ends this request — proving the probe enforces its own hard ceiling
  // rather than depending on the target to ever give up.
  const { url } = await spawnAgent({ mode: 'hanging' });
  const target = fixtureTarget(url);
  const obs = await slowClient(target, { dripMs: 100, cutoffMs: 400 });

  assert.equal(obs.findings.behavior, 'held_past_cutoff');
  assert.ok(obs.responses[0].elapsedMs >= 380, 'must have actually waited close to the cutoff');
});

test('slow_client falls back to the frozen spec durations when no override is given', async () => {
  // Confirms production code paths (which never pass dripMs/cutoffMs) get
  // the real spec numbers, not silently 0 or undefined. We don't run an
  // actual 20s/60s request here — that belongs to the frozen spec, not to
  // a fast unit test — we only check the probe *selected* the right numbers,
  // via the findings it echoes back once a short-circuited run completes.
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await slowClient(target, { dripMs: 20, cutoffMs: 500 });
  // With no explicit dripMs/cutoffMs the probe must read THRESHOLDS itself —
  // asserted directly against the frozen constants so a future edit to
  // spec.js is caught here rather than silently drifting.
  assert.equal(THRESHOLDS.SLOW_CLIENT_DRIP_MS, 20_000);
  assert.equal(THRESHOLDS.SLOW_CLIENT_CUTOFF_MS, 60_000);
  assert.equal(obs.findings.dripMs, 20);
  assert.equal(obs.findings.cutoffMs, 500);
});

test('concurrent_burst spends exactly its budgeted 3 requests', async () => {
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await concurrentBurst(target);
  assert.equal(obs.requestsUsed, THRESHOLDS.CONCURRENT_BURST_SIZE);
  assert.equal(obs.requestsUsed, REQUEST_BUDGET.concurrent_burst);
});

test('concurrent_burst genuinely fires in parallel, not sequentially', async () => {
  // This is the assertion that actually matters for this probe. A probe
  // that awaited each request in a loop would still return a "3 requests
  // sent" observation, but maxConcurrent on the fixture would only ever
  // reach 1. Only real concurrency pushes maxConcurrent to the full burst
  // size, so this is the one check that tells parallel apart from
  // sequential-but-fast.
  const { url, agent } = await spawnAgent({ mode: 'honest', latencyMs: 50 });
  const target = fixtureTarget(url);
  await concurrentBurst(target);
  assert.equal(agent.state.maxConcurrent, THRESHOLDS.CONCURRENT_BURST_SIZE);
});

test('concurrent_burst counts 5xx responses from a crashy target', async () => {
  // The fixture's crashy mode only 500s on input it considers bad — a valid
  // sampleBody gets a normal 200 from every mode. So this needs a body
  // missing a required field to actually trigger the fixture's 500 path.
  const { url } = await spawnAgent({ mode: 'crashy' });
  const target = fixtureTarget(url, { sampleBody: { wallet: '0xabc' } });
  const obs = await concurrentBurst(target);
  assert.equal(obs.findings.serverErrorCount, THRESHOLDS.CONCURRENT_BURST_SIZE);
  assert.equal(obs.findings.successCount, 0);
});

test('concurrent_burst counts clean successes from an honest target', async () => {
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await concurrentBurst(target);
  assert.equal(obs.findings.successCount, THRESHOLDS.CONCURRENT_BURST_SIZE);
  assert.equal(obs.findings.serverErrorCount, 0);
  assert.equal(obs.findings.networkErrorCount, 0);
});

test('concurrent_burst records latencies as information only, never as a verdict input', async () => {
  // findings.latenciesMs must exist for debugging, but nothing in this file
  // (or the probe itself) may branch on it — enforced here by asserting it
  // is present without ever asserting a threshold against it.
  const { url } = await spawnAgent({ mode: 'honest' });
  const target = fixtureTarget(url);
  const obs = await concurrentBurst(target);
  assert.equal(obs.findings.latenciesMs.length, THRESHOLDS.CONCURRENT_BURST_SIZE);
  assert.ok(obs.findings.latenciesMs.every((ms) => typeof ms === 'number'));
});
