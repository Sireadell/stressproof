// x402 payment config for Base.
//
// WHY THIS IS NOT A COPY OF PULSEVERIFY'S payment.js
// --------------------------------------------------
// PulseVerify's version is hard-wired to X Layer (eip155:196) through OKX's
// own facilitator, paying in USDT0, with a hand-worked EIP-712 domain because
// that token's on-chain name contains a real ₮ glyph. None of that transfers.
// What transfers is the *shape*: middleware wiring, payer extraction, and the
// hard timeout around every facilitator call.
//
// GO/NO-GO 1 RESULT, resolved live on Day 2 (2026-09-01)
// ------------------------------------------------------
// The public x402.org facilitator DOES NOT settle Base mainnet. Its own
// /supported list returns eip155:84532 (Base *Sepolia*) and never eip155:8453.
// This is the same trap PulseVerify hit with X Layer: the docs imply broad
// support, the live endpoint disagrees, and only the live endpoint is true.
//
// Two no-auth production facilitators DO settle Base mainnet, both confirmed
// live against their own /supported endpoints on Day 2:
//
//   facilitator.xpay.sh        eip155:8453 + eip155:84532  (+ v1 base/base-sepolia)
//   facilitator.0xarchive.io   eip155:8453 + eip155:999
//
// xpay is the default because it serves BOTH mainnet and testnet, so the
// GO/NO-GO fallback (ship on Sepolia if mainnet settlement misbehaves) is a
// one-line config change rather than swapping providers mid-build.
// Coinbase's CDP facilitator also settles mainnet but requires an account and
// API keys, so it is not the default — no owner-side signup blocks the build.

const FACILITATORS = Object.freeze({
  xpay: 'https://facilitator.xpay.sh',
  '0xarchive': 'https://facilitator.0xarchive.io',
});

export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';

/**
 * USDC on Base, verified on-chain on Day 2 via eth_call against
 * https://mainnet.base.org rather than taken from a docs table:
 *
 *   name()     -> "USD Coin"
 *   symbol()   -> "USDC"
 *   decimals() -> 6
 *   version()  -> "2"
 *   DOMAIN_SEPARATOR() -> present, so EIP-712 signing is live
 *
 * The name/version pair is REQUIRED in the 402 challenge's `accepts[].extra`
 * for the "exact" scheme with EIP-3009. Without it a paying client cannot
 * build the EIP-712 domain and aborts *before* it ever sends a paid request —
 * which is exactly how PulseVerify silently failed OKX's review twice. It
 * looked like a timeout on their side; it was a missing two-field object on
 * ours.
 */
export const USDC_BASE = Object.freeze({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  eip712Domain: Object.freeze({ name: 'USD Coin', version: '2' }),
});

/** USDC on Base Sepolia, for the testnet fallback path. */
export const USDC_BASE_SEPOLIA = Object.freeze({
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  decimals: 6,
  eip712Domain: Object.freeze({ name: 'USDC', version: '2' }),
});

/**
 * Price of one certification run. Per run, never per probe.
 *
 * Higher than PulseVerify's per-call price because a run spends real time and
 * makes up to 30 real outbound requests to somebody else's server.
 */
export const RUN_PRICE_USDC = '0.25';

/**
 * Resolve payment config from the environment.
 *
 * Defaults are mainnet + xpay. STRESSPROOF_NETWORK=sepolia flips the whole
 * config coherently — network, token and domain together — so a half-switched
 * state (mainnet network, testnet token) is not expressible.
 */
export function resolvePaymentConfig(env = process.env) {
  const useTestnet = env.STRESSPROOF_NETWORK === 'sepolia';
  const facilitatorKey = env.STRESSPROOF_FACILITATOR || 'xpay';
  const facilitatorUrl = FACILITATORS[facilitatorKey];

  if (!facilitatorUrl) {
    throw new Error(
      `Unknown facilitator '${facilitatorKey}'. Known: ${Object.keys(FACILITATORS).join(', ')}`,
    );
  }
  if (useTestnet && facilitatorKey === '0xarchive') {
    // Caught at boot rather than at first payment: 0xarchive serves mainnet
    // and HyperEVM only, so this combination would 402 forever with a
    // confusing error.
    throw new Error("Facilitator '0xarchive' does not settle Base Sepolia — use xpay for testnet.");
  }

  return {
    network: useTestnet ? BASE_SEPOLIA : BASE_MAINNET,
    token: useTestnet ? USDC_BASE_SEPOLIA : USDC_BASE,
    facilitatorUrl,
    facilitatorKey,
    price: RUN_PRICE_USDC,
    isTestnet: useTestnet,
  };
}

/**
 * The payment option served on the paid route, exported so tests exercise the
 * exact object the live middleware uses rather than a hand-rolled copy that
 * could drift.
 */
export function buildCertifyPaymentOption({ payTo, config = resolvePaymentConfig() }) {
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error('payTo must be a 0x-prefixed 20-byte address');
  }
  // SHAPE VERIFIED against a working implementation, not invented.
  //
  // `extra` is where the EIP-712 domain must sit: @x402/evm's ExactEvmScheme
  // .parsePrice copies `price.extra` straight into the 402 challenge's
  // accepts[].extra, which is where a paying client looks for it. An earlier
  // draft of this file nested it under `price.asset.eip712`, which is simply
  // ignored — the challenge would have gone out without a signing domain and
  // every payer would have aborted before sending anything, exactly the
  // failure that got PulseVerify rejected twice.
  return {
    scheme: 'exact',
    network: config.network,
    payTo,
    price: {
      amount: config.price,
      asset: config.token.address,
      extra: { ...config.token.eip712Domain },
    },
  };
}

/**
 * Hard timeout around any facilitator call.
 *
 * Carried over from PulseVerify by hand, not by copy. The lesson it encodes:
 * a facilitator that hangs must fail the request fast and loudly, because the
 * alternative is a paid endpoint that appears to work and silently never
 * settles. Fails CLOSED — a timeout is never treated as a successful payment.
 */
export async function withFacilitatorTimeout(promise, ms = 10_000, label = 'facilitator') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the paying wallet address from an x402 payment header.
 *
 * The payer address is load-bearing well beyond billing: the consent check
 * requires the *payer's* address to appear at the target's well-known URL, so
 * whoever pays must also demonstrably control the target. Returns null rather
 * than throwing — an unreadable header is a 402, not a crash.
 */
export function extractPayerAddress(decodedPayment) {
  if (!decodedPayment || typeof decodedPayment !== 'object') return null;
  const candidate =
    decodedPayment?.payload?.authorization?.from ??
    decodedPayment?.payload?.from ??
    decodedPayment?.from ??
    null;
  if (typeof candidate !== 'string') return null;
  return /^0x[0-9a-fA-F]{40}$/.test(candidate) ? candidate.toLowerCase() : null;
}

export { FACILITATORS };
