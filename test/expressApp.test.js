// Tests for the HTTP surface.
//
// Everything underneath these routes is tested elsewhere. What is tested here
// is the layer a stranger actually touches: does an unknown id 404 instead of
// crashing, does a bad request explain itself, does the free route refuse to
// be pointed at somebody who never agreed to it, and, the important one,
// does verification actually catch a tampered or forged certificate rather
// than waving it through.
//
// A fixed throwaway signing key, public by definition, so signatures are
// reproducible. Set before any import that reads it.
process.env.STRESSPROOF_SIGNER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import { createApp } from '../src/expressApp.js';
import { createPaymentGate } from '../src/lib/paymentGate.js';
import { signReport, getSignerAddress } from '../src/lib/attestation.js';
import { PROBE_ORDER } from '../src/lib/spec.js';

let server;
let base;

/** One honest certification, run once and shared.
 *
 *  Not a convenience: the free route only allows three runs per caller, and
 *  that ceiling is itself under test at the bottom of this file. Certifying
 *  afresh in every test would spend the budget the last test needs. */
let honestRun;

before(async () => {
  // Payment is switched off explicitly for this file. Left to the default,
  // the gate would read the real environment, find no payout address and
  // correctly refuse every paid run, which is the right behaviour and is
  // tested on its own in paymentGate.test.js, but it is not what these
  // route tests are about.
  const app = createApp({
    demoAllowlist: ['https://agreed.example.com/'],
    payment: createPaymentGate({ env: { STRESSPROOF_PAYMENT: 'off' } }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  honestRun = await certifyDemo('honest');
});

after(() => server?.close());

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** One real certification against the demo agent we host ourselves. */
async function certifyDemo(mode = 'honest') {
  const res = await req('POST', '/demo/certify', { demoMode: mode });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test('/health answers', async () => {
  const { status, body } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('/about publishes the probe list, the price and the signing address', async () => {
  const { status, body } = await req('GET', '/about');
  assert.equal(status, 200);
  // The probe list is frozen. If this ever grows, the freeze was broken.
  assert.deepEqual(body.probes, PROBE_ORDER);
  assert.equal(body.probes.length, 12);
  assert.equal(body.signerAddress, getSignerAddress());
  assert.ok(body.limitations.length > 0, 'the honesty list must never be empty');
});

test('a run request without a sample body is refused, and the refusal explains why', async () => {
  const { status, body } = await req('POST', '/runs', {
    targetUrl: 'https://example.com/agent',
  });
  assert.equal(status, 400);
  // Not just refused: the message has to say what to send and why, because
  // this is the least obvious requirement in the whole product.
  assert.match(body.error, /sampleBody is required/);
  assert.match(body.error, /guess/);
});

test('a run request with an unsupported method is refused by name', async () => {
  const { status, body } = await req('POST', '/runs', {
    targetUrl: 'https://example.com/agent',
    method: 'DELETE',
    sampleBody: { query: 'hi' },
  });
  assert.equal(status, 400);
  assert.match(body.error, /DELETE/);
});

test('starting an unknown run id is a 404, not a crash', async () => {
  const { status, body } = await req('POST', '/runs/does-not-exist/start');
  assert.equal(status, 404);
  assert.match(body.error, /unknown run id/);
});

test('the free demo refuses a target that never agreed to be probed', async () => {
  const { status, body } = await req('POST', '/demo/certify', {
    targetUrl: 'https://stranger.example.com/agent',
    sampleBody: { query: 'hi' },
  });
  assert.equal(status, 403);
  // Refusing is not enough on its own; it has to point at the legitimate way in.
  assert.match(body.howToRunAgainstYourOwn, /consent code/);
});

test('the free demo refuses an unknown demo mode and lists the real ones', async () => {
  const { status, body } = await req('POST', '/demo/certify', { demoMode: 'nonsense' });
  assert.equal(status, 400);
  assert.ok(Array.isArray(body.allowed) && body.allowed.includes('honest'));
});

test('certifying our own honest demo agent produces a stored, signed, verifiable report', async () => {
  const stored = honestRun;
  assert.ok(stored.id, 'a report must get an id');
  assert.equal(stored.report.verdict, 'RESILIENT');

  const fetched = await req('GET', `/reports/${stored.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.report.verdict, 'RESILIENT');

  const verified = await req('GET', `/verify/${stored.id}`);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.signedByStressProof, true);
  assert.equal(verified.body.verdict, 'RESILIENT');
  assert.match(verified.body.meaning, /has not been altered/);
  // The whole pitch is "do not take our word for it", so the answer has to
  // carry the instructions for checking it without us.
  assert.equal(verified.body.checkItYourself.publishedSignerAddress, getSignerAddress());
});

test('a deliberately flawed demo agent scores worse than the honest one', async () => {
  const honest = honestRun;
  const sloppy = await certifyDemo('sloppy');
  assert.ok(
    sloppy.report.score < honest.report.score,
    `sloppy scored ${sloppy.report.score}, honest scored ${honest.report.score}, so the product is not discriminating`,
  );
});

test('an unknown report id explains that reports are held in memory', async () => {
  const { status, body } = await req('GET', '/verify/0000000000000000');
  assert.equal(status, 404);
  // A judge hitting a dropped report must be told it is still checkable,
  // not left thinking the evidence vanished.
  assert.match(body.note, /POST them to \/verify/);
});

test('an unknown report id on /reports is a 404', async () => {
  const { status } = await req('GET', '/reports/0000000000000000');
  assert.equal(status, 404);
});

test('/verify demands both halves', async () => {
  const { status, body } = await req('POST', '/verify', { report: { a: 1 } });
  assert.equal(status, 400);
  assert.match(body.error, /report.*certificate/);
});

test('/verify accepts an untouched report and certificate', async () => {
  const stored = honestRun;
  const { status, body } = await req('POST', '/verify', {
    report: stored.report,
    certificate: stored.certificate,
  });
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.signedByStressProof, true);
});

test('/verify catches a score edited after signing', async () => {
  const stored = honestRun;
  // A single point is enough. The check is not "did it change a lot", it is
  // "is this byte for byte the thing we signed".
  const tampered = { ...stored.report, score: (stored.report.score ?? 0) + 1 };

  const { status, body } = await req('POST', '/verify', {
    report: tampered,
    certificate: stored.certificate,
  });
  assert.equal(status, 200);
  assert.equal(body.valid, false);
  assert.match(body.reason, /altered since signing/);
  assert.equal(body.signedByStressProof, false);
});

test('a certificate signed by somebody else is internally consistent but not ours', async () => {
  // This is the failure a naive `valid: true` check would wave through: a
  // forger signs a real-looking report with their own key. Every field checks
  // out against itself. It is still not a StressProof certificate.
  const stored = honestRun;
  const impostor = Wallet.createRandom();
  const forged = await signReport(stored.report, { signer: impostor });

  const { status, body } = await req('POST', '/verify', {
    report: stored.report,
    certificate: forged,
  });
  assert.equal(status, 200);
  assert.equal(body.valid, true, 'the forged certificate is self-consistent by construction');
  assert.equal(body.signedByStressProof, false, 'but it must not pass as ours');
  assert.match(body.reason, /not made by the StressProof signing key/);
  assert.notEqual(impostor.address, getSignerAddress());
});

// Left until last on purpose: it spends the shared free-run budget.
test('the free demo stops the same caller after a few runs', async () => {
  let sawLimit = false;
  for (let i = 0; i < 6 && !sawLimit; i += 1) {
    const { status, body } = await req('POST', '/demo/certify', { demoMode: 'honest' });
    if (status === 429) {
      sawLimit = true;
      assert.match(body.error, /free demo|budget/);
    }
  }
  assert.ok(sawLimit, 'an open route with no ceiling is an abuse vector');
});
