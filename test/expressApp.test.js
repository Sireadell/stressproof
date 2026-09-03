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

test('an unrecognised consent mode is refused by name rather than silently defaulted', async () => {
  // Silently falling back would be dangerous in either direction: a caller who
  // typed "standng" would get a one-time code they cannot use, or worse, a
  // caller who meant one-time would land on the long-lived permission without
  // ever having asked for it.
  const { status, body } = await req('POST', '/runs', {
    targetUrl: 'https://example.com/agent',
    sampleBody: { query: 'hi' },
    consentMode: 'permanent',
  });
  assert.equal(status, 400);
  assert.match(body.error, /permanent/);
  assert.deepEqual(body.allowed, ['challenge', 'standing']);
});

test('/about names both consent modes and says which is the default', async () => {
  const { body } = await req('GET', '/about');
  assert.deepEqual(body.consent.modes, ['challenge', 'standing']);
  assert.equal(body.consent.default, 'challenge');
  assert.equal(body.consent.standing.maxPermissionDays, 30);
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

test('the honesty table is served, not just filed in the repo', async () => {
  const res = await fetch(base + '/honesty');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  // The three status words are the whole point of the document. If any of
  // them has gone missing, it has stopped being an honesty table.
  assert.match(text, /Real/);
  assert.match(text, /Simplified/);
  assert.match(text, /Not built/);
});

test('/about says whether the explainer is switched on', async () => {
  const { body } = await req('GET', '/about');
  assert.equal(typeof body.explainer.available, 'boolean');
  assert.ok(body.explainer.note, 'an unexplained absence reads as a broken feature');
});

test('a report with no explanation says why, rather than leaving a blank', async () => {
  // No explanation model is configured in the test environment, so this is
  // the real unconfigured path rather than a simulated one.
  assert.equal(honestRun.explanation, null);
  assert.match(honestRun.explanationUnavailable, /no explanation model is configured/);
  // The important half: a missing summary must not read as a missing verdict.
  assert.match(honestRun.explanationUnavailable, /verdict is unaffected/i);
  assert.equal(honestRun.report.verdict, 'RESILIENT');
});

test('an unsigned report is reported as unsigned, not as untrustworthy', async () => {
  // The failure this guards against is the product contradicting its own
  // pitch. A deployment with no signing key produces reports with no
  // certificate. Running those through the tamper check answers "no
  // certificate supplied", and worded as a verdict that reads "do not trust
  // this report" about a report that is perfectly sound.
  const app = createApp({ payment: createPaymentGate({ env: { STRESSPROOF_PAYMENT: 'off' } }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;

  try {
    // Take a real stored report and strip its certificate, which is exactly
    // the shape a keyless deployment produces.
    const { reports } = await import('../src/expressApp.js');
    const stored = reports.get(honestRun.id);
    assert.ok(stored, 'the shared run should still be in the store');
    const saved = stored.certificate;
    stored.certificate = null;

    try {
      const res = await fetch(`${local}/verify/${honestRun.id}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.signed, false);
      assert.equal(body.valid, null, 'unsigned is neither valid nor invalid');
      assert.doesNotMatch(body.meaning, /Do not trust/i);
      assert.match(body.reason, /never signed/i);
      assert.match(body.reason, /not a sign of tampering/i);
      // The verdict still has to come through, or an unsigned report becomes
      // unreadable as well as uncheckable.
      assert.equal(body.verdict, 'RESILIENT');
    } finally {
      stored.certificate = saved;
    }
  } finally {
    server.close();
  }
});

// --- the permanent certificate link ---------------------------------------
//
// The failure these guard against is the one that would have made the whole
// product look broken in front of a judge: the free hosting plan spins the
// process down after 15 quiet minutes, which drops every stored report, and
// every certificate link ever issued would then answer 404.
//
// So the test that matters is not "does the link work", it is "does the link
// work when the server has forgotten everything". That is what is simulated
// below by clearing the store outright before following the link.

test('every report is issued with a permanent link, absolute and clickable', async () => {
  assert.ok(honestRun.permanentLink, 'a report with no durable link is a link that dies on the next restart');
  assert.ok(honestRun.permanentLink.startsWith('/c/'));
  assert.ok(
    honestRun.permanentUrl.startsWith(base + '/c/'),
    `expected an absolute link on the host the caller used, got ${honestRun.permanentUrl}`,
  );
  // Nobody should have to guess why a URL that long is a good thing.
  assert.match(honestRun.permanentLinkNote, /inside the URL/);
  assert.equal(honestRun.permanentLinkUnavailable, null);
});

test('the permanent link still verifies after the server has forgotten every report', async () => {
  const { reports } = await import('../src/expressApp.js');
  const snapshot = new Map(reports);
  // Exactly what a spin-down does: the process comes back with an empty store.
  reports.clear();

  try {
    // The id route is now dead, which is the honest state of affairs.
    const byId = await req('GET', `/verify/${honestRun.id}`);
    assert.equal(byId.status, 404, 'a report id is a pointer into memory and must admit it when memory is gone');

    // The link is not, because it never depended on memory.
    const res = await fetch(honestRun.permanentUrl);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.valid, true, body.reason);
    assert.equal(body.signedByStressProof, true);
    assert.equal(body.verdict, 'RESILIENT');
    assert.match(body.meaning, /has not been altered/);
    // The evidence has to travel with the verdict. A surviving verdict with no
    // surviving report would be exactly the unbacked claim this product objects to.
    assert.deepEqual(body.report, honestRun.report);
    assert.match(body.source, /read from the link itself/);
    // No id, because there is no stored thing for one to point at.
    assert.equal(body.reportId, null);
  } finally {
    for (const [k, v] of snapshot) reports.set(k, v);
  }
});

test('both verification routes give the same answer about the same report', async () => {
  const byId = await req('GET', `/verify/${honestRun.id}`);
  const byLink = await fetch(honestRun.permanentUrl).then((r) => r.json());

  // Everything except where the bytes came from. A reader must not be able to
  // get a friendlier verdict by choosing a different route.
  for (const field of ['valid', 'signedByStressProof', 'signed', 'verdict', 'score', 'target', 'meaning']) {
    assert.deepEqual(byLink[field], byId.body[field], `'${field}' differs between the two verification routes`);
  }
});

test('a permanent link with an edited verdict is caught, not served', async () => {
  const { encodeCertificateLink } = await import('../src/lib/certificateLink.js');
  // The only forgery a link holder can actually attempt: change the report,
  // keep the real certificate, re-encode. Nothing stored is consulted, so the
  // signature is the entire defence, which is the point being tested.
  const forged = encodeCertificateLink({
    // Point the same clean verdict at a different agent, which is the version
    // of this forgery that actually pays: reselling somebody else's pass.
    report: { ...honestRun.report, target: 'https://not-the-agent-we-tested.example.com/api' },
    certificate: honestRun.certificate,
  });
  assert.equal(forged.ok, true);

  const res = await fetch(`${base}${forged.path}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.valid, false);
  assert.match(body.meaning, /Do not trust/);
});

test('a mangled permanent link explains itself rather than 404ing', async () => {
  const res = await fetch(`${base}/c/sp1.notarealtoken`);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /damaged or incomplete|not part of one/);
  // The distinction that matters: this is the link being wrong, not us having
  // forgotten something. Those are two very different accusations.
  assert.match(body.note, /not that we have forgotten anything/);
});

test('the unknown-id message points at the link that does not go stale', async () => {
  const { body } = await req('GET', '/verify/0000000000000000');
  assert.match(body.note, /permanent link/);
});

test('/about publishes which verification routes survive a restart and which do not', async () => {
  const { body } = await req('GET', '/about');
  assert.equal(body.verification.permanentLink, 'GET /c/<token>');
  assert.ok(body.verification.stateDependent.includes('GET /verify/<reportId>'));
  assert.match(body.verification.stateDependentNote, /spun down/);
});

// --- deployed behind a proxy ----------------------------------------------

test('the free demo counts visitors separately behind a load balancer', async () => {
  // WITHOUT `trust proxy`, this is the bug that kills the deployed demo. Every
  // request arrives from the load balancer's address, so all visitors share one
  // per-address bucket and the fourth person to ever try the demo is refused as
  // a repeat offender. On a laptop there is no proxy and it looks perfect.
  //
  // The shared 127.0.0.1 bucket is already spent by the budget test above, so
  // if these two forwarded visitors are being counted as that same caller they
  // will be refused, and this test fails.
  const demoAs = (forwardedFor) =>
    fetch(base + '/demo/certify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ demoMode: 'honest' }),
    });

  const first = await demoAs('203.0.113.7');
  assert.equal(first.status, 200, 'a visitor behind the proxy was refused for somebody else`s runs');
  const second = await demoAs('198.51.100.22');
  assert.equal(second.status, 200, 'a second, different visitor was refused for the first one`s runs');
});

test('one visitor behind the proxy still hits the per-address ceiling', async () => {
  // The other half of the same fix. Separating visitors must not remove the
  // limit: an open route with no ceiling is the abuse vector the paid route
  // exists to avoid.
  const ip = '203.0.113.99';
  let sawLimit = false;
  for (let i = 0; i < 5 && !sawLimit; i += 1) {
    const res = await fetch(base + '/demo/certify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ demoMode: 'honest' }),
    });
    if (res.status === 429) sawLimit = true;
  }
  assert.ok(sawLimit, 'a forwarded visitor with no ceiling is an unlimited free run');
});

test('the in-memory shortcut is capped, because it is no longer what makes a report durable', async () => {
  const { reports, MAX_HELD_REPORTS } = await import('../src/expressApp.js');
  const snapshot = new Map(reports);

  try {
    // Fill it past the ceiling with placeholders, then do one real run and
    // check the store pruned itself rather than growing forever on a 512MB box.
    for (let i = 0; i < MAX_HELD_REPORTS + 50; i += 1) reports.set(`filler_${i}`, { id: `filler_${i}` });

    const res = await fetch(base + '/demo/certify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' },
      body: JSON.stringify({ demoMode: 'honest' }),
    });
    const stored = await res.json();
    assert.equal(res.status, 200);

    assert.ok(reports.size <= MAX_HELD_REPORTS, `store held ${reports.size}, past the ${MAX_HELD_REPORTS} ceiling`);
    // Oldest first: the newest report must be the one that survived.
    assert.ok(reports.has(stored.id), 'eviction dropped the report it had just written');
    assert.equal(reports.has('filler_0'), false, 'eviction should take the oldest first');
    // And the evicted ones lost nothing that mattered, which is what makes
    // evicting them acceptable at all.
    const stillWorks = await fetch(stored.permanentUrl);
    assert.equal(stillWorks.status, 200);
  } finally {
    reports.clear();
    for (const [k, v] of snapshot) reports.set(k, v);
  }
});

test('a real signed report packs into a link well under the ceiling we promise', async () => {
  // The honesty table states a number, so a test has to hold it. This is the
  // real thing: a full twelve-probe run, signed, encoded the way it is served.
  const { MAX_TOKEN_CHARS } = await import('../src/lib/certificateLink.js');
  const token = honestRun.permanentLink.slice('/c/'.length);
  assert.ok(honestRun.certificate, 'this has to be a signed report to be a fair measurement');
  assert.ok(
    token.length < MAX_TOKEN_CHARS,
    `a real report packed to ${token.length} chars, at or past the ${MAX_TOKEN_CHARS} ceiling`,
  );
  // The documented figure is "about 2,200". If a report ever doubles, the
  // document is wrong and should be corrected rather than quietly outgrown.
  assert.ok(
    token.length < 4000,
    `a real report packed to ${token.length} chars, which no longer matches the size the honesty table states`,
  );
});
