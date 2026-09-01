// The paid route's gate.
//
// Day 2 proved the *config* is right: a facilitator that really settles Base
// mainnet, a USDC contract checked on-chain, an EIP-712 domain in the one
// place a paying client actually reads it. This file is what turns that config
// into a door.
//
// Three rules it exists to enforce, in order of how badly each one hurts if
// it is wrong:
//
//   1. NEVER RUN FREE BY ACCIDENT. Every path that cannot confirm payment must
//      refuse. Not "log a warning and continue". Refuse. A facilitator that
//      times out, a deployment missing its payout address, an unreadable
//      payment header: all of them are a closed door. The only way to run
//      without paying is to say so out loud, in configuration, on purpose.
//   2. THE PAYER MUST BE THE PERSON WHO PROVED CONSENT. Consent binds a wallet
//      to a target. Payment proves a wallet spent money. If those two wallets
//      are allowed to differ, then anyone holding a run id can pay to fire 30
//      requests at a target somebody *else* proved they control, and the
//      consent check stops meaning anything.
//   3. SAY WHAT WAS CHARGED FOR. A run that reaches an unreachable target
//      still costs us the work and still bills. That is defensible, but only
//      if it is stated in advance rather than discovered afterwards.

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

import {
  resolvePaymentConfig,
  buildCertifyPaymentOption,
  extractPayerAddress,
  RUN_PRICE_USDC,
} from './payment.js';

/**
 * The one route that costs money.
 *
 * `POST /runs` is deliberately free: asking for a consent code makes no
 * outbound requests and commits us to nothing. The charge lands on the step
 * that actually spends our time and somebody else's bandwidth.
 *
 * `:runId` is a named parameter in x402's own pattern syntax, which compiles
 * it to a single non-slash segment.
 */
export const PAID_ROUTE = 'POST /runs/:runId/start';

/** Where a paid run's money goes. No default: see `createPaymentGate`. */
export function resolvePayTo(env = process.env) {
  const raw = (env.STRESSPROOF_PAY_TO ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
}

/**
 * The route table handed to the x402 middleware.
 *
 * The payment option itself comes from `buildCertifyPaymentOption` rather than
 * being spelled out here, so the shape the middleware serves is the same
 * object the payment tests already check. Two copies of an EIP-712 domain is
 * exactly how the wrong one ships.
 */
export function buildRoutesConfig({ payTo, config = resolvePaymentConfig() }) {
  return {
    [PAID_ROUTE]: {
      accepts: buildCertifyPaymentOption({ payTo, config }),
      description:
        `One StressProof certification run: up to 30 probe requests against a target you have proven you control, ` +
        `scored and signed. Billed per run, not per probe. ` +
        `A run that reaches an unreachable or broken target still bills, because the work is the probing, not the verdict.`,
    },
  };
}

/**
 * Decide, once at boot, whether this deployment charges.
 *
 * The three states are deliberately not two. "Charging", and "explicitly free
 * because somebody said so", are both fine. The third, "meant to charge but
 * cannot", is the dangerous one, and it is dangerous precisely because it
 * looks like the second. A deployment that lost its payout address would, on a
 * two-state design, quietly start giving runs away. Here it refuses instead,
 * and says why.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] environment to read
 * @param {object} [opts.resourceServer] pre-built server, for tests
 * @param {boolean} [opts.syncFacilitatorOnStart] ask the facilitator which
 *   networks and schemes it can settle, on the first paid request. Leave it on:
 *   without it the server cannot build a challenge at all and answers 500. The
 *   test suite keeps it on and passes a stubbed facilitator instead, so the
 *   real path runs offline rather than being skipped.
 */
export function createPaymentGate({
  env = process.env,
  resourceServer,
  syncFacilitatorOnStart = true,
} = {}) {
  // The one way to be free: say so.
  if ((env.STRESSPROOF_PAYMENT ?? '').trim().toLowerCase() === 'off') {
    return {
      mode: 'off',
      enabled: false,
      price: null,
      middleware: null,
      reason: 'payment is switched off for this deployment (STRESSPROOF_PAYMENT=off)',
    };
  }

  const payTo = resolvePayTo(env);
  if (!payTo) {
    // Not an exception: a boot crash on a missing env var takes down the free
    // demo and the verification endpoints too, which have nothing to do with
    // payment. Closing one door is the proportionate response to losing one
    // key.
    return {
      mode: 'misconfigured',
      enabled: false,
      price: RUN_PRICE_USDC,
      middleware: null,
      reason:
        'paid runs are unavailable: this deployment has no payout address configured (STRESSPROOF_PAY_TO). ' +
        'Refusing rather than running for free, because a missing setting must never quietly become a discount.',
    };
  }

  const config = resolvePaymentConfig(env);
  const server =
    resourceServer ??
    new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(
      config.network,
      new ExactEvmScheme(),
    );

  const routes = buildRoutesConfig({ payTo, config });

  return {
    mode: 'live',
    enabled: true,
    price: config.price,
    config,
    payTo,
    routes,
    // No paywall UI is configured on purpose. This endpoint is for agents and
    // scripts; a browser hitting it gets the plain 402 challenge, which is the
    // machine-readable thing a paying client needs anyway.
    middleware: paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart),
    reason: null,
  };
}

/**
 * Who paid, according to the payment header on this request.
 *
 * Read AFTER the middleware has already verified the payment, so this is not
 * re-doing a security check, because the signature is someone else's job by this
 * point. All this answers is "which wallet was on the thing that was verified",
 * so the consent binding below has something to compare against.
 *
 * Returns null on anything unreadable. A null here becomes a refusal, never a
 * pass, at the only call site.
 */
export function readPayerFromRequest(req) {
  const header = req.get?.('payment-signature') ?? req.get?.('x-payment') ?? null;
  if (!header) return null;
  try {
    return extractPayerAddress(decodePaymentSignatureHeader(header));
  } catch {
    return null;
  }
}

/**
 * The binding between "who paid" and "who proved they control the target".
 *
 * Kept as a pure function with no request, no response and no middleware
 * anywhere near it, because this is the rule that stops a paid run from being
 * pointed at somebody else's agent, and a rule that important should be
 * testable by calling it.
 *
 * @param {object} args
 * @param {boolean} args.paymentEnabled whether this deployment charges at all
 * @param {string|null} args.paidBy wallet taken from the verified payment
 * @param {string|null} args.consentPayer wallet bound at consent time
 */
export function paymentMatchesConsent({ paymentEnabled, paidBy, consentPayer }) {
  if (!paymentEnabled) {
    // Nothing was charged, so there is no payer to disagree with. The consent
    // check has already run on its own and is unaffected.
    return { ok: true, unpaid: true };
  }
  if (!consentPayer) {
    return { ok: false, reason: 'this run has no wallet bound to it, so payment cannot be matched to consent' };
  }
  if (!paidBy) {
    return {
      ok: false,
      reason:
        'the payment was accepted but its paying wallet could not be read, so it cannot be matched against the wallet that proved consent',
    };
  }
  if (paidBy.toLowerCase() !== consentPayer.toLowerCase()) {
    return {
      ok: false,
      reason:
        'the wallet that paid is not the wallet that proved control of this target. ' +
        'Consent is granted to a specific wallet, and paying from a different one does not inherit it.',
      paidBy,
      expected: consentPayer,
    };
  }
  return { ok: true, unpaid: false };
}
