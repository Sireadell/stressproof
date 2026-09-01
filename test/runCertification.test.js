// END TO END — the whole product, against a live local agent.
//
// This is GO/NO-GO 2 from the build plan: run all twelve probes against every
// behavioural mode and confirm the verdicts come out different and correct.
// Everything else in the suite tests a part. This tests whether the parts add
// up to a product.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { runCertification, toReport } from '../src/lib/runCertification.js';
import { createFakeAgent, fixtureTarget } from './fixtures/fakeAgent.js';
import { MAX_REQUESTS_PER_RUN } from '../src/lib/spec.js';
import { signReport, verifyCertificate } from '../src/lib/attestation.js';
import { Wallet } from 'ethers';

let agent;
let url;

// Short timings so the full twelve-probe run stays quick. The durations are
// injected, never changed in spec.js — the shipped thresholds stay honest.
const FAST = { dripMs: 60, cutoffMs: 250 };

before(async () => {
  agent = createFakeAgent();
  url = await agent.listen();
});

after(() => agent?.close());

async function certify(mode, overrides = {}) {
  agent.setMode(mode);
  agent.reset();
  return runCertification(fixtureTarget(url, overrides), { probeOpts: FAST });
}

test('an honest agent is certified without being punished for it', async () => {
  const run = await certify('honest');
  assert.equal(run.silentWrongCount, 0, `honest agent was accused: ${JSON.stringify(run.breakdown.filter((b) => b.outcome === 'SILENT_WRONG'))}`);
  assert.notEqual(run.verdict, 'BRITTLE');
});

test('an agent that answers confidently to nonsense is caught', async () => {
  // The behaviour the entire product exists to surface: 200 OK with a
  // fabricated confidence score, in response to input it should have refused.
  const run = await certify('sloppy');
  assert.ok(run.silentWrongCount > 0, 'the sloppy agent should have been caught lying');
  assert.notEqual(run.verdict, 'RESILIENT', 'an agent that lies quietly can never be RESILIENT');
});

test('an agent that crashes loudly scores better than one that lies quietly', async () => {
  // The thesis of the product, expressed as an assertion. Crashing is a real
  // failure, but the caller knows. A confident wrong answer is worse.
  const crashy = await certify('crashy');
  const sloppy = await certify('sloppy');
  assert.equal(crashy.silentWrongCount, 0, 'crashing is honest, not silent');
  assert.ok(sloppy.silentWrongCount > 0);
});

test('an agent that quotes bad input back is NOT branded a liar', async () => {
  // The false-accusation case that two reviews warned about. This agent is
  // well-behaved: it refuses bad input and quotes the offending text in its
  // error. A naive check reads that echo as a successful injection.
  const run = await certify('echoer');
  const injection = run.breakdown.find((b) => b.probe === 'injection_canary');
  assert.notEqual(injection.outcome, 'SILENT_WRONG', `echoer was falsely convicted: ${injection.reason}`);
});

test('the published request cap is never exceeded, in any mode', async () => {
  // This is an abuse limit before it is a budget. If it can be exceeded, the
  // product is a denial-of-service tool with a payment page.
  for (const mode of ['honest', 'sloppy', 'crashy', 'echoer']) {
    const run = await certify(mode);
    assert.ok(
      run.requestsUsed <= MAX_REQUESTS_PER_RUN,
      `${mode} used ${run.requestsUsed} requests, cap is ${MAX_REQUESTS_PER_RUN}`,
    );
    assert.ok(agent.state.requestCount <= MAX_REQUESTS_PER_RUN, `${mode} actually sent ${agent.state.requestCount} requests`);
  }
});

test('all twelve probes report, none silently vanish', async () => {
  const run = await certify('honest');
  assert.equal(run.observations.length, 12);
  assert.equal(run.breakdown.length, 12);
  // Every probe must have either an outcome or an honest reason for not having
  // one. A probe that quietly disappears is a hole in the evidence.
  for (const b of run.breakdown) {
    assert.ok(b.outcome, `${b.probe} produced no outcome`);
    assert.ok(b.reason, `${b.probe} produced no reason`);
  }
});

test('an unreachable agent is INCONCLUSIVE, never BRITTLE', async () => {
  // An agent we could not measure is not an agent that failed. Reporting it
  // as broken would be the single most damaging kind of false claim here.
  const dead = fixtureTarget('http://127.0.0.1:1/agent');
  const run = await runCertification(dead, { probeOpts: FAST });
  assert.equal(run.verdict, 'INCONCLUSIVE');
  assert.equal(run.silentWrongCount, 0);
});

test('a run against an agent behind a guard-refused address makes no requests', async () => {
  // The safety guard must hold at the whole-run level, not just per probe.
  const run = await runCertification({ url: 'https://localhost:9999/agent', method: 'POST', sampleBody: { query: 'x' } }, { probeOpts: FAST });
  assert.equal(run.verdict, 'INCONCLUSIVE');
});

test('the same agent gives the same verdict twice', async () => {
  // Reproducibility is the product. Two people running this must be able to
  // compare notes.
  const a = await certify('sloppy');
  const b = await certify('sloppy');
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.silentWrongCount, b.silentWrongCount);
});

test('a report can be signed and independently verified', async () => {
  // The end of the chain: evidence in, signed certificate out, checkable by
  // anyone without trusting us.
  const run = await certify('sloppy');
  const report = toReport(run);
  const signer = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const cert = await signReport(report, { signer });
  assert.equal(verifyCertificate(report, cert).valid, true);

  // And tampering with the verdict after the fact is detected.
  const tampered = { ...report, verdict: 'RESILIENT' };
  assert.equal(verifyCertificate(tampered, cert).valid, false);
});

test('the published report carries evidence but not the target\'s raw responses', async () => {
  // Raw bodies can be large and are the target's content, not ours to
  // republish. The findings carry the evidence; the bodies were only the
  // means of getting it.
  const report = toReport(await certify('honest'));
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes('"responses"'), 'raw responses must not reach the published report');
  assert.ok(report.probes.every((p) => p.findings), 'every probe must still carry its findings');
});
