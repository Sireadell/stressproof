// The paid route's gate.
//
// Most of this file is about refusing. That is deliberate: a payment gate that
// charges correctly but occasionally lets a run through free is a worse
// product than one that occasionally refuses a legitimate payer, because the
// first failure is invisible and the second is a support email.
//
// The tests that matter most, in order:
//   - a deployment that meant to charge and cannot must refuse, not run free
//   - the wallet that pays must be the wallet that proved consent
//   - the 402 challenge must carry the EIP-712 domain a payer needs to sign

process.env.STRESSPROOF_SIGNER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { x402ResourceServer } from '@x402/express';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';

import { createApp } from '../src/expressApp.js';
import {
  createPaymentGate,
  paymentMatchesConsent,
  readPayerFromRequest,
  buildRoutesConfig,
  resolvePayTo,
  PAID_ROUTE,
} from '../src/lib/paymentGate.js';
import { RUN_PRICE_USDC, USDC_BASE, BASE_MAINNET } from '../src/lib/payment.js';

const PAY_TO = '0x1111111111111111111111111111111111111111';

/**
 * A facilitator that answers offline.
 *
 * The real server asks its facilitator which scheme-and-network pairs it can
 * settle before it can build a 402 challenge, so a test that skips that step
 * is not testing the real path, it is testing a server that would 500 in
 * production. This stub answers the one question that matters and makes no
 * network call, so the whole live path runs in the suite.
 */
function stubFacilitator({ kinds, fail = false } = {}) {
  return {
    async getSupported() {
      if (fail) throw new Error('facilitator unreachable');
      return {
        x402Version: 2,
        kinds: kinds ?? [{ x402Version: 2, network: BASE_MAINNET, scheme: 'exact' }],
      };
    },
  };
}

function liveGate({ facilitator = stubFacilitator() } = {}) {
  return createPaymentGate({
    env: { STRESSPROOF_PAY_TO: PAY_TO },
    resourceServer: new x402ResourceServer(facilitator).register(BASE_MAINNET, new ExactEvmScheme()),
  });
}

/** Start an app with a given gate and return a caller for it. */
async function withApp(payment, fn) {
  const app = createApp({ payment });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(async (method, path, { body, headers } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return { status: res.status, headers: res.headers, body: parsed };
    });
  } finally {
    server.close();
  }
}

// --- the three boot states -------------------------------------------------

test('the gate has three states, not two', () => {
  const off = createPaymentGate({ env: { STRESSPROOF_PAYMENT: 'off' } });
  assert.equal(off.mode, 'off');
  assert.equal(off.enabled, false);

  const broken = createPaymentGate({ env: {} });
  assert.equal(broken.mode, 'misconfigured');
  assert.equal(broken.enabled, false);

  const live = liveGate();
  assert.equal(live.mode, 'live');
  assert.equal(live.enabled, true);
  assert.ok(live.middleware, 'a live gate must actually mount a door');
});

test('a missing payout address refuses the paid run instead of giving it away', async () => {
  // The whole point of separating "misconfigured" from "off". This is what a
  // deployment looks like when someone forgets one environment variable.
  const broken = createPaymentGate({ env: {} });
  assert.equal(broken.middleware, null, 'no middleware is mounted, so nothing else stops a free run');

  await withApp(broken, async (req) => {
    const { status, body } = await req('POST', '/runs/anything/start');
    assert.equal(status, 503);
    assert.match(body.error, /no payout address/);
    // A 404 here would mean the request reached the handler's run lookup,
    // which is one edit away from reaching the run itself.
    assert.notEqual(status, 404);
  });
});

test('a misconfigured deployment still serves everything that is not paid', async () => {
  // Refusing to charge must not take down verification or the free demo.
  // Those have nothing to do with payment and no reason to fail with it.
  await withApp(createPaymentGate({ env: {} }), async (req) => {
    assert.equal((await req('GET', '/health')).status, 200);
    assert.equal((await req('GET', '/about')).status, 200);
    assert.equal((await req('GET', '/verify/0000000000000000')).status, 404);
  });
});

test('/about says what the payment state is rather than making anyone probe for it', async () => {
  const cases = [
    [createPaymentGate({ env: { STRESSPROOF_PAYMENT: 'off' } }), 'off', false],
    [createPaymentGate({ env: {} }), 'misconfigured', false],
    [liveGate(), 'live', true],
  ];
  for (const [gate, expectedStatus, expectedAvailable] of cases) {
    await withApp(gate, async (req) => {
      const { body } = await req('GET', '/about');
      assert.equal(body.payment.status, expectedStatus);
      assert.equal(body.payment.paidRunsAvailable, expectedAvailable);
      assert.equal(body.price.amount, RUN_PRICE_USDC);
    });
  }
});

// --- the 402 challenge -----------------------------------------------------

test('an unpaid request to the paid route is answered with a 402, not a run', async () => {
  await withApp(liveGate(), async (req) => {
    const { status, body, headers } = await req('POST', '/runs/some-run-id/start');
    assert.equal(status, 402, JSON.stringify(body).slice(0, 300));

    // The challenge travels in a header, not the body. Worth pinning down,
    // because a payer that cannot find it behaves exactly like a payer that
    // did not want to pay.
    const challengeHeader = headers.get('payment-required');
    assert.ok(challengeHeader, 'a 402 with no challenge is a locked door with no keyhole');

    const challenge = decodePaymentRequiredHeader(challengeHeader);
    const accepts = challenge.accepts[0];
    assert.equal(accepts.network, BASE_MAINNET);
    assert.equal(accepts.payTo, PAY_TO);
    assert.equal(accepts.asset, USDC_BASE.address);
    assert.equal(accepts.amount, RUN_PRICE_USDC);
    // The field that matters most and is easiest to lose. Without it a paying
    // client cannot build the signing domain and gives up before sending
    // anything, which looks from our side like nobody wanted to pay.
    assert.deepEqual(accepts.extra, { name: 'USD Coin', version: '2' });
    assert.match(challenge.resource.description, /per run, not per probe/i);
  });
});

test('a facilitator that cannot be reached refuses the run rather than waving it through', async () => {
  // The failure this exists to prevent: a payment provider goes down, the
  // charge silently stops happening, and the runs keep going out. Anything
  // other than a refusal here is money and outbound traffic given away.
  await withApp(liveGate({ facilitator: stubFacilitator({ fail: true }) }), async (req) => {
    const { status } = await req('POST', '/runs/some-run-id/start');
    assert.ok(status >= 400, `a broken facilitator must not produce a success, got ${status}`);
    assert.notEqual(status, 404, 'a 404 would mean the request reached the run lookup');
  });
});

test('the free routes are not behind the paywall', async () => {
  await withApp(liveGate(), async (req) => {
    // Asking for a consent code costs nothing and commits us to nothing, so
    // charging for it would only push people towards guessing at the flow.
    const { status } = await req('POST', '/runs', { body: { targetUrl: 'https://x.example/a' } });
    assert.notEqual(status, 402);
    assert.equal((await req('GET', '/about')).status, 200);
    assert.equal((await req('GET', '/health')).status, 200);
  });
});

test('the served payment option carries the EIP-712 domain a payer must sign with', () => {
  // The failure this guards against is silent and total: without `extra`, a
  // paying client cannot build the signing domain and gives up before sending
  // anything. It looks like nobody wanted to pay.
  const routes = buildRoutesConfig({ payTo: PAY_TO });
  const accepts = routes[PAID_ROUTE].accepts;
  assert.equal(accepts.network, BASE_MAINNET);
  assert.equal(accepts.payTo, PAY_TO);
  assert.equal(accepts.price.amount, RUN_PRICE_USDC);
  assert.equal(accepts.price.asset, USDC_BASE.address);
  assert.deepEqual(accepts.price.extra, { name: 'USD Coin', version: '2' });
});

test('the price is charged per run, and the description says an unreachable target still bills', () => {
  const routes = buildRoutesConfig({ payTo: PAY_TO });
  const { description } = routes[PAID_ROUTE];
  assert.match(description, /per run, not per probe/i);
  // Charging for a run against a dead target is defensible. Discovering it
  // afterwards is not.
  assert.match(description, /unreachable/i);
});

test('only the start route is priced', () => {
  const routes = buildRoutesConfig({ payTo: PAY_TO });
  assert.deepEqual(Object.keys(routes), ['POST /runs/:runId/start']);
});

test('a payout address is only accepted if it is actually an address', () => {
  assert.equal(resolvePayTo({ STRESSPROOF_PAY_TO: PAY_TO }), PAY_TO);
  assert.equal(resolvePayTo({ STRESSPROOF_PAY_TO: '  ' }), null);
  assert.equal(resolvePayTo({ STRESSPROOF_PAY_TO: 'my-wallet' }), null);
  assert.equal(resolvePayTo({ STRESSPROOF_PAY_TO: '0xabc' }), null, 'a truncated address must not pass');
  assert.equal(resolvePayTo({}), null);
});

// --- payment bound to consent ----------------------------------------------

test('paying from a different wallet than the one that proved consent is refused', () => {
  const result = paymentMatchesConsent({
    paymentEnabled: true,
    paidBy: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    consentPayer: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not the wallet that proved control/);
});

test('the same wallet in different letter case is the same wallet', () => {
  // Addresses come back checksummed from some clients and lowercased from
  // others. Refusing a legitimate payer over capitalisation would be a real
  // bug hiding behind a security-shaped rule.
  const result = paymentMatchesConsent({
    paymentEnabled: true,
    paidBy: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    consentPayer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(result.ok, true);
  assert.equal(result.unpaid, false);
});

test('an unreadable paying wallet is a refusal, never a pass', () => {
  const result = paymentMatchesConsent({
    paymentEnabled: true,
    paidBy: null,
    consentPayer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be read/);
});

test('a run with no wallet bound to it cannot be paid for', () => {
  const result = paymentMatchesConsent({
    paymentEnabled: true,
    paidBy: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    consentPayer: null,
  });
  assert.equal(result.ok, false);
});

test('when payment is switched off there is no payer to disagree with', () => {
  // Free deployments must not be broken by a rule that only makes sense when
  // money changed hands.
  const result = paymentMatchesConsent({
    paymentEnabled: false,
    paidBy: null,
    consentPayer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(result.ok, true);
  assert.equal(result.unpaid, true);
});

// --- reading the payer off a request ---------------------------------------

function fakeReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] };
}

function encodeHeader(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

test('the paying wallet is read out of a real payment header', () => {
  const header = encodeHeader({
    x402Version: 2,
    scheme: 'exact',
    network: BASE_MAINNET,
    payload: { authorization: { from: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa', to: PAY_TO } },
  });
  assert.equal(
    readPayerFromRequest(fakeReq({ 'payment-signature': header })),
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
});

test('the older x-payment header name is still read', () => {
  const header = encodeHeader({ payload: { authorization: { from: PAY_TO } } });
  assert.equal(readPayerFromRequest(fakeReq({ 'x-payment': header })), PAY_TO.toLowerCase());
});

test('a missing, malformed or garbage payment header reads as no payer, never a crash', () => {
  // Every one of these ends up at `paidBy: null`, which the binding above
  // turns into a refusal. The important part is that none of them throw:
  // an exception here would be a 500 on a route that just took money.
  assert.equal(readPayerFromRequest(fakeReq({})), null);
  assert.equal(readPayerFromRequest(fakeReq({ 'payment-signature': 'not base64!!' })), null);
  assert.equal(readPayerFromRequest(fakeReq({ 'payment-signature': encodeHeader({}) })), null);
  assert.equal(
    readPayerFromRequest(fakeReq({ 'payment-signature': encodeHeader({ payload: { authorization: { from: 'nope' } } }) })),
    null,
  );
  assert.equal(readPayerFromRequest({}), null, 'a request object with no getter must not throw');
});
