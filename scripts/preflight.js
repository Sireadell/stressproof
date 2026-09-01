#!/usr/bin/env node
// Preflight: does the configured facilitator ACTUALLY settle the configured
// network, right now?
//
// This exists because of a specific, expensive lesson. PulseVerify assumed the
// public x402.org facilitator settled X Layer because the documentation implied
// it. It does not, and the failure surfaced as a rejected submission weeks
// later rather than as an error at build time. On Day 2 of this build the same
// facilitator turned out not to settle Base mainnet either.
//
// So: never trust a docs table about which chains a facilitator supports. Ask
// the facilitator. Run this before deploying, and any time payments misbehave.
//
//   node scripts/preflight.js
//   STRESSPROOF_NETWORK=sepolia node scripts/preflight.js

import { resolvePaymentConfig, buildCertifyPaymentOption } from '../src/lib/payment.js';

const TIMEOUT_MS = 15_000;

async function main() {
  const config = resolvePaymentConfig();
  console.log('StressProof payment preflight');
  console.log('─'.repeat(52));
  console.log(`facilitator : ${config.facilitatorKey} (${config.facilitatorUrl})`);
  console.log(`network     : ${config.network}${config.isTestnet ? '  [TESTNET]' : '  [MAINNET]'}`);
  console.log(`token       : ${config.token.address}`);
  console.log(`price       : ${config.price} USDC per run`);
  console.log('─'.repeat(52));

  const url = `${config.facilitatorUrl}/supported`;
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.error(`\nFAIL  could not reach ${url}\n      ${err.message}`);
    console.error('\n      The facilitator is down or unreachable. Payments will fail closed.');
    process.exit(1);
  }

  const kinds = Array.isArray(body?.kinds) ? body.kinds : [];
  const networks = [...new Set(kinds.map((k) => k.network))];
  const match = kinds.find((k) => k.network === config.network && k.scheme === 'exact');

  if (!match) {
    console.error(`\nFAIL  ${config.facilitatorKey} does not settle ${config.network}.`);
    console.error(`      It advertises: ${networks.join(', ') || '(nothing)'}`);
    console.error('\n      This is exactly the failure that must never reach production.');
    console.error('      Switch facilitator, or fall back to Sepolia and disclose it.');
    process.exit(1);
  }

  // The payment option must also be constructible, including the EIP-712
  // domain. A missing domain makes paying clients abort *before* sending a
  // paid request, which looks like a timeout on their end and is very hard to
  // diagnose from ours.
  const probeAddress = '0x1111111111111111111111111111111111111111';
  const option = buildCertifyPaymentOption({ payTo: probeAddress, config });
  if (!option?.price?.extra?.name || !option?.price?.extra?.version) {
    console.error('\nFAIL  payment option is missing its EIP-712 domain; payers cannot sign.');
    process.exit(1);
  }

  console.log(`\nOK    ${config.facilitatorKey} settles ${config.network} (scheme: ${match.scheme})`);
  console.log(`OK    EIP-712 domain present: ${JSON.stringify(option.price.extra)}`);
  console.log(`\n      Facilitator also advertises: ${networks.join(', ')}`);
  console.log('\n      Preflight passed. Settlement itself still needs one real');
  console.log('      paid call from a funded wallet — see docs/DAY2_PAYMENT.md.');
}

main().catch((err) => {
  console.error('preflight crashed:', err);
  process.exit(1);
});
