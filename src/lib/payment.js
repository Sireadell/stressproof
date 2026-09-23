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

// Circle's own facilitator is the only one of the three that settles Arc.
// Confirmed live against GET https://gateway-api.circle.com/v1/x402/supported,
// which lists eip155:5042 alongside Ethereum, Base and the rest; xpay's and
// 0xarchive's own /supported lists were checked the same way and carry no Arc
// entry at all, so pointing an Arc deployment at either would 402 forever.
const FACILITATORS = Object.freeze({
  xpay: 'https://facilitator.xpay.sh',
  '0xarchive': 'https://facilitator.0xarchive.io',
  circle: 'https://gateway-api.circle.com/v1/x402',
});

export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export const ARC_MAINNET = 'eip155:5042';

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
 * USDC on Arc.
 *
 * Arc does NOT follow the pattern the two Base entries above use. Everywhere
 * else the EIP-712 domain belongs to the USDC token itself and the payer signs
 * against the token address. Circle's Arc settlement signs against its
 * GatewayWalletBatched contract instead, so the domain carries an explicit
 * `verifyingContract` that is not the asset. Taken from Circle's own
 * /supported response, not from a docs table. Getting this wrong does not
 * fail loudly: the signature verifies against the wrong contract and the
 * facilitator rejects every payment as "unsupported_scheme".
 */
export const USDC_ARC = Object.freeze({
  address: '0x3600000000000000000000000000000000000000',
  decimals: 6,
  eip712Domain: Object.freeze({
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
  }),
});

/**
 * How long an Arc payment authorization must stay valid.
 *
 * Circle publishes minValiditySeconds 604800 (one week) for Arc and refuses
 * anything shorter as "authorization_validity_too_short". Advertising exactly
 * 604800 still fails, because the payer signs `validBefore` from its own clock
 * and the window has already shrunk below the minimum by the time the
 * facilitator checks it. The extra day is that headroom, not a preference.
 */
export const ARC_AUTH_VALIDITY_SECONDS = 604800 + 86400;

/**
 * Price of one certification run. Per run, never per probe.
 */
export const RUN_PRICE_USDC = '0.005';

/**
 * A human-readable decimal amount, in atomic units for a token with the given
 * number of decimals.
 *
 * This exists because of a real, live bug: the object-shaped price the x402
 * server library accepts (`{ amount, asset, extra }`) is treated as an
 * AssetAmount and passed straight through with no conversion of its own — see
 * `parsePrice` in @x402/evm's exact/server, which returns `price.amount`
 * verbatim when `price` is already an object. A decimal string like "0.10"
 * put there is signed on the payer's side as a raw EIP-3009 `value`, and
 * `BigInt("0.10")` throws. Found on the first real payment this project ever
 * attempted, which is also why no earlier test caught it: nothing before that
 * moment ever passed a price through actual EIP-712 signing.
 */
export function toAtomicUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`${decimal} has more than ${decimals} decimal places`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * Resolve payment config from the environment.
 *
 * Defaults are mainnet + xpay. STRESSPROOF_NETWORK=sepolia flips the whole
 * config coherently — network, token and domain together — so a half-switched
 * state (mainnet network, testnet token) is not expressible.
 */
const NETWORKS = Object.freeze({
  base: Object.freeze({
    caip2: BASE_MAINNET,
    token: USDC_BASE,
    isTestnet: false,
    defaultFacilitator: 'xpay',
    settledBy: Object.freeze(['xpay', '0xarchive']),
    authValiditySeconds: null,
  }),
  sepolia: Object.freeze({
    caip2: BASE_SEPOLIA,
    token: USDC_BASE_SEPOLIA,
    isTestnet: true,
    defaultFacilitator: 'xpay',
    settledBy: Object.freeze(['xpay']),
    authValiditySeconds: null,
  }),
  arc: Object.freeze({
    caip2: ARC_MAINNET,
    token: USDC_ARC,
    isTestnet: false,
    defaultFacilitator: 'circle',
    settledBy: Object.freeze(['circle']),
    authValiditySeconds: ARC_AUTH_VALIDITY_SECONDS,
  }),
});

export function resolvePaymentConfig(env = process.env) {
  const requested = (env.STRESSPROOF_NETWORK ?? '').trim().toLowerCase();
  const networkKey = requested || 'base';
  const network = NETWORKS[networkKey];

  if (!network) {
    throw new Error(
      `Unknown network '${requested}'. Known: ${Object.keys(NETWORKS).join(', ')}`,
    );
  }

  const facilitatorKey = env.STRESSPROOF_FACILITATOR || network.defaultFacilitator;
  const facilitatorUrl = FACILITATORS[facilitatorKey];

  if (!facilitatorUrl) {
    throw new Error(
      `Unknown facilitator '${facilitatorKey}'. Known: ${Object.keys(FACILITATORS).join(', ')}`,
    );
  }
  // Caught at boot rather than at first payment. A facilitator that does not
  // settle the chosen chain does not fail on startup by itself: it 402s
  // forever with a confusing error, which is the expensive way to learn this.
  if (!network.settledBy.includes(facilitatorKey)) {
    throw new Error(
      `Facilitator '${facilitatorKey}' does not settle ${networkKey} (${network.caip2}) — ` +
        `use ${network.settledBy.join(' or ')}.`,
    );
  }

  return {
    network: network.caip2,
    networkKey,
    token: network.token,
    facilitatorUrl,
    facilitatorKey,
    price: RUN_PRICE_USDC,
    isTestnet: network.isTestnet,
    authValiditySeconds: network.authValiditySeconds,
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
    // Only set where the chain demands it. Arc's settlement refuses an
    // authorization whose window is shorter than Circle's published minimum,
    // and the payer builds `validBefore` from this number, so leaving it off
    // on Arc means every payment is rejected before any money moves.
    ...(config.authValiditySeconds ? { maxTimeoutSeconds: config.authValiditySeconds } : {}),
    price: {
      // Atomic units, not the decimal display price. See toAtomicUnits above
      // for why: an object-shaped price is treated as already-atomic and
      // handed straight through to EIP-712 signing with no conversion of its
      // own, so a decimal string here breaks every payer that reaches it.
      amount: toAtomicUnits(config.price, config.token.decimals).toString(),
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
