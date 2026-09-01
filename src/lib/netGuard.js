// NETWORK GUARD — the difference between a testing tool and a weapon.
//
// StressProof exists to fire awkward traffic at a server on request. That is
// the product, and it is also exactly why it needs hard limits: without them
// it is a denial-of-service service with a payment page, and a way for a
// stranger to reach systems they should not be able to reach.
//
// Two distinct dangers, both handled here:
//
//   1. Pointing traffic at somebody who never agreed to it.
//      Answered by consent.js, not this file.
//
//   2. Being tricked into reaching a PRIVATE address — a machine only our
//      server can see, like an internal admin panel or a cloud provider's
//      credential endpoint at 169.254.169.254. An attacker does not need to
//      break in if they can persuade our server to fetch it for them.
//      That is what this file exists to prevent.
//
// The subtle part is *when* the check happens. Checking the hostname when the
// request is submitted is not enough: a hostname can resolve to a harmless
// public address during the check and a private one moments later when the
// connection is actually made. So the address is resolved once, validated,
// and then that exact address is the one connected to — see safeFetch.js.

import ipaddr from 'ipaddr.js';
import dns from 'node:dns/promises';

/**
 * Address ranges that are never allowed to be a probe target.
 *
 * ipaddr.js classifies an address into a named range; anything not on this
 * allow-list is refused. Deliberately an allow-list of ONE ('unicast', i.e.
 * ordinary public internet) rather than a deny-list of many — a deny-list
 * fails open when a range is forgotten, and forgetting a range here means a
 * private network becomes reachable.
 */
const ALLOWED_RANGES = new Set(['unicast']);

/**
 * Human-readable reasons, so a refusal explains itself rather than being a
 * blank "forbidden". A builder who gets blocked should know why.
 */
const RANGE_REASONS = Object.freeze({
  loopback: 'a loopback address (the server itself)',
  private: 'a private network address',
  uniqueLocal: 'a private IPv6 address',
  linkLocal: 'a link-local address (this range includes cloud credential endpoints)',
  unspecified: 'an unspecified address',
  broadcast: 'a broadcast address',
  multicast: 'a multicast address',
  reserved: 'a reserved address',
  carrierGradeNat: 'a carrier-grade NAT address',
});

/**
 * Is this single resolved IP address safe to connect to?
 *
 * @param {string} address
 * @returns {{ ok: boolean, reason?: string, range?: string }}
 */
export function checkAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return { ok: false, reason: `'${address}' is not a valid IP address` };
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is the classic bypass: it reads as an
  // IPv6 address, but connects to the IPv4 address inside it. Unwrap it and
  // judge the address that will actually be contacted.
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    const inner = parsed.toIPv4Address();
    const innerRange = inner.range();
    if (!ALLOWED_RANGES.has(innerRange)) {
      return {
        ok: false,
        range: innerRange,
        reason: `${address} maps to ${inner.toString()}, which is ${RANGE_REASONS[innerRange] ?? innerRange}`,
      };
    }
    return { ok: true, range: innerRange };
  }

  const range = parsed.range();
  if (!ALLOWED_RANGES.has(range)) {
    return {
      ok: false,
      range,
      reason: `${address} is ${RANGE_REASONS[range] ?? range}`,
    };
  }
  return { ok: true, range };
}

/**
 * Validate a target URL's shape, before any DNS work.
 *
 * HTTPS only. Not a formality: over plain HTTP the consent proof and the
 * probe traffic are both readable and alterable in transit, which would make
 * the consent check meaningless.
 *
 * @param {string} rawUrl
 * @returns {{ ok: boolean, reason?: string, url?: URL }}
 */
export function checkUrlShape(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `only https targets are accepted, got '${url.protocol}'` };
  }
  if (url.username || url.password) {
    // Credentials in a URL are both a leak risk and a classic way to make a
    // hostile URL look like a familiar one (https://real.com@evil.com/).
    return { ok: false, reason: 'credentials in the URL are not accepted' };
  }
  return { ok: true, url };
}

/**
 * Resolve a hostname and refuse it unless EVERY address it resolves to is
 * safe.
 *
 * Every address, not just the first. A hostname that returns one public and
 * one private address would otherwise be a coin flip on which one gets
 * connected to, and a hostile operator gets to weight the coin.
 *
 * @param {string} hostname
 * @returns {Promise<{ ok: boolean, reason?: string, addresses?: string[] }>}
 */
export async function resolveAndCheckHost(hostname) {
  // A bare IP literal skips DNS but still gets checked. This catches the
  // decimal/octal/hex literal tricks too, because Node's parser normalises
  // them before ipaddr.js ever sees them.
  if (ipaddr.isValid(hostname)) {
    const single = checkAddress(hostname);
    return single.ok
      ? { ok: true, addresses: [hostname] }
      : { ok: false, reason: single.reason };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, reason: `could not resolve '${hostname}' (${err.code ?? err.message})` };
  }
  if (!records.length) {
    return { ok: false, reason: `'${hostname}' resolved to no addresses` };
  }

  for (const { address } of records) {
    const verdict = checkAddress(address);
    if (!verdict.ok) {
      return { ok: false, reason: `'${hostname}' resolves to ${verdict.reason}` };
    }
  }
  return { ok: true, addresses: records.map((r) => r.address) };
}

/**
 * Full pre-flight for a target URL: shape, then DNS, then every address.
 *
 * @param {string} rawUrl
 * @param {{ allowPrivateAddresses?: boolean }} [opts]
 *   allowPrivateAddresses exists ONLY so the test suite can point at a local
 *   fixture server. It is a function argument rather than an environment
 *   variable on purpose: the route layer never passes it, so no deployment
 *   mistake or stray env var can switch the guard off in production.
 */
export async function checkTarget(rawUrl, { allowPrivateAddresses = false } = {}) {
  const shape = checkUrlShape(rawUrl);
  if (!shape.ok) {
    if (allowPrivateAddresses && /only https/.test(shape.reason ?? '')) {
      // Local fixtures are plain http; still validated for URL validity above.
      const url = new URL(rawUrl);
      return { ok: true, url, addresses: [url.hostname], testModeBypass: true };
    }
    return shape;
  }
  if (allowPrivateAddresses) {
    return { ok: true, url: shape.url, addresses: [shape.url.hostname], testModeBypass: true };
  }

  const host = await resolveAndCheckHost(shape.url.hostname);
  if (!host.ok) return { ok: false, reason: host.reason };

  return { ok: true, url: shape.url, addresses: host.addresses };
}

export { ALLOWED_RANGES, RANGE_REASONS };
