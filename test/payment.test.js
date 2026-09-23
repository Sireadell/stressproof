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
  toAtomicUnits,
  BASE_MAINNET,
  BASE_SEPOLIA,
  ARC_MAINNET,
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
    /does not settle sepolia/,
  );
  // Arc is settled by Circle alone. Both Base facilitators publish /supported
  // lists with no Arc entry, so either would 402 forever.
  assert.throws(
    () => resolvePaymentConfig({ STRESSPROOF_NETWORK: 'arc', STRESSPROOF_FACILITATOR: 'xpay' }),
    /does not settle arc/,
  );
  assert.throws(() => resolvePaymentConfig({ STRESSPROOF_NETWORK: 'nonsense' }), /Unknown network/);
});

test('Arc bills in Arc USDC, through Circle, against the Gateway signing domain', () => {
  const config = resolvePaymentConfig({ STRESSPROOF_NETWORK: 'arc' });
  assert.equal(config.network, ARC_MAINNET);
  // Circle is the default for Arc, so no deployment has to know to set it.
  assert.equal(config.facilitatorKey, 'circle');
  assert.equal(config.token.address, '0x3600000000000000000000000000000000000000');

  const opt = buildCertifyPaymentOption({ payTo: PAY_TO, config });
  assert.equal(opt.network, ARC_MAINNET);
  // The domain a payer signs against on Arc is Circle's Gateway contract, not
  // the USDC token. Signing against the token is rejected as an unsupported
  // scheme, which looks like a broken payer rather than a wrong domain.
  assert.equal(opt.price.extra.name, 'GatewayWalletBatched');
  assert.equal(opt.price.extra.verifyingContract, '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee');
  assert.notEqual(opt.price.extra.verifyingContract, opt.price.asset);
  // Below Circle's published one-week minimum the payment is refused before
  // any money moves, so the window must be advertised and must clear it.
  assert.ok(opt.maxTimeoutSeconds > 604800, 'must exceed Circle minValiditySeconds');
  assert.equal(opt.price.amount, toAtomicUnits(RUN_PRICE_USDC, 6).toString());
});

test('Base keeps signing against the token, and advertises no forced window', () => {
  const opt = buildCertifyPaymentOption({ payTo: PAY_TO, config: resolvePaymentConfig({}) });
  assert.equal(opt.network, BASE_MAINNET);
  assert.equal(opt.price.extra.name, 'USD Coin');
  assert.equal(opt.price.extra.verifyingContract, undefined);
  assert.equal(opt.maxTimeoutSeconds, undefined);
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
  // Atomic units, not the decimal display price — a payer signs this number
  // directly, and a decimal here is what broke the first real payment.
  assert.equal(opt.price.amount, toAtomicUnits(RUN_PRICE_USDC, 6).toString());
  assert.equal(opt.price.amount, '5000');
});

test('a malformed payout address is refused', () => {
  assert.throws(() => buildCertifyPaymentOption({ payTo: 'not-an-address' }), /payTo/);
  assert.throws(() => buildCertifyPaymentOption({ payTo: '' }), /payTo/);
});

test('toAtomicUnits converts a decimal price to the atomic units a payer signs', () => {
  assert.equal(toAtomicUnits('0.10', 6), 100000n);
  assert.equal(toAtomicUnits('1', 6), 1000000n);
  assert.equal(toAtomicUnits('0', 6), 0n);
  assert.equal(toAtomicUnits('123.456789', 6), 123456789n);
  assert.throws(() => toAtomicUnits('0.1234567', 6), /more than 6 decimal places/);
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
