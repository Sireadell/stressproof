// Payment config tests.
//
// These encode the two mistakes that cost PulseVerify a rejected submission:
// a missing EIP-712 domain (payer aborts before ever sending a paid request,
// which looks like a timeout on their side), and a facilitator/network
// mismatch that only shows up at first payment instead of at boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePaymentConfig,
  buildCertifyPaymentOption,
  withFacilitatorTimeout,
  extractPayerAddress,
  BASE_MAINNET,
  BASE_SEPOLIA,
  USDC_BASE,
  RUN_PRICE_USDC,
} from '../src/lib/payment.js';

const PAY_TO = '0x1111111111111111111111111111111111111111';

test('defaults to Base mainnet via xpay', () => {
  const c = resolvePaymentConfig({});
  assert.equal(c.network, BASE_MAINNET);
  assert.equal(c.facilitatorUrl, 'https://facilitator.xpay.sh');
  assert.equal(c.isTestnet, false);
});

test('the public x402.org facilitator is deliberately not an option', () => {
  // Confirmed live on Day 2: its /supported list returns eip155:84532 and
  // never eip155:8453. Selecting it for mainnet would 402 forever.
  assert.throws(() => resolvePaymentConfig({ STRESSPROOF_FACILITATOR: 'x402org' }), /Unknown facilitator/);
});

test('sepolia switch flips network AND token together', () => {
  // A half-switched config (mainnet network, testnet token) must not be
  // expressible — that class of mismatch is invisible until settlement fails.
  const c = resolvePaymentConfig({ STRESSPROOF_NETWORK: 'sepolia' });
  assert.equal(c.network, BASE_SEPOLIA);
  assert.notEqual(c.token.address, USDC_BASE.address);
  assert.equal(c.isTestnet, true);
});

test('a facilitator that cannot settle the chosen network fails at boot, not at first payment', () => {
  assert.throws(
    () => resolvePaymentConfig({ STRESSPROOF_NETWORK: 'sepolia', STRESSPROOF_FACILITATOR: '0xarchive' }),
    /does not settle Base Sepolia/,
  );
});

test('the EIP-712 domain sits in price.extra, where a payer actually looks', () => {
  // Two failures in one assertion. The domain must be present at all (without
  // name+version a payer cannot build a signature and gives up before sending
  // anything — the exact omission that got PulseVerify rejected twice), AND
  // it must be in `extra`, because that is the only field @x402/evm copies
  // into the 402 challenge. Nested anywhere else it is silently ignored,
  // which looks identical to not having it.
  const opt = buildCertifyPaymentOption({ payTo: PAY_TO });
  assert.ok(opt.price.extra, 'EIP-712 domain missing from price.extra — payers cannot sign');
  assert.equal(opt.price.extra.name, 'USD Coin');
  assert.equal(opt.price.extra.version, '2');
});

test('payment option matches the on-chain USDC contract', () => {
  // Values verified on Day 2 by eth_call against mainnet.base.org, not copied
  // from a docs table.
  const opt = buildCertifyPaymentOption({ payTo: PAY_TO });
  assert.equal(opt.price.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(opt.network, BASE_MAINNET);
  assert.equal(opt.price.amount, RUN_PRICE_USDC);
});

test('a malformed payout address is refused', () => {
  assert.throws(() => buildCertifyPaymentOption({ payTo: 'not-an-address' }), /payTo/);
  assert.throws(() => buildCertifyPaymentOption({ payTo: '' }), /payTo/);
});

test('facilitator timeout fails closed', async () => {
  // A hanging facilitator must reject fast. It must never resolve as if the
  // payment succeeded.
  const hangs = new Promise(() => {});
  await assert.rejects(withFacilitatorTimeout(hangs, 25, 'test'), /timed out/);
});

test('facilitator timeout passes a fast result through untouched', async () => {
  const result = await withFacilitatorTimeout(Promise.resolve({ ok: true }), 1000);
  assert.deepEqual(result, { ok: true });
});

test('payer address is extracted and lowercased', () => {
  const payer = extractPayerAddress({
    payload: { authorization: { from: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' } },
  });
  assert.equal(payer, '0xabcdef0123456789abcdef0123456789abcdef01');
});

test('an unreadable payment header yields null, never a crash', () => {
  // This becomes a 402 for the caller, not a 500 for us.
  assert.equal(extractPayerAddress(null), null);
  assert.equal(extractPayerAddress({}), null);
  assert.equal(extractPayerAddress({ payload: { from: 'garbage' } }), null);
  assert.equal(extractPayerAddress('nonsense'), null);
});
