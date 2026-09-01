// CONSENT — proof that whoever asked for a run actually controls the target.
//
// WHY A ONE-TIME CODE AND NOT A PERMISSION FILE
// ----------------------------------------------
// The obvious design is "put a file on your site saying you allow this." It
// was the original design here, and it is not good enough, for two reasons
// found in review before any of this was written:
//
//   1. A file written once and left up never expires. Whoever wrote it
//      consented in the past, forever, to anyone who can pay. Consent that
//      cannot be withdrawn by inaction is not really consent.
//
//   2. It proves nothing about *now*. Domains change hands, subdomains get
//      handed to different teams, hosting gets re-pointed.
//
// So instead: a code that only exists for this run, must appear at the
// target's own origin within 15 minutes, and is useless afterwards. That
// proves live control at the moment of asking.
//
// The file must also carry the paying wallet and the exact target URL. Those
// two bindings stop a valid consent for one endpoint being reused to authorise
// traffic at a different one, or by a different payer.
//
// A REAL COST, ACCEPTED KNOWINGLY
// --------------------------------
// Some hosts (managed platforms, certain PaaS subdomains) will not let an
// operator serve a file at /.well-known/. Those targets cannot be certified,
// and that is a genuine limitation rather than an oversight — it is written in
// the honesty table. The alternative is accepting weaker proof, and weak proof
// on a tool that sends traffic at strangers is not a trade worth making.

import { randomBytes } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { checkTarget } from './netGuard.js';
import { THRESHOLDS, MAX_REQUESTS_PER_RUN } from './spec.js';

export const WELL_KNOWN_PATH = '/.well-known/stressproof.txt';

/**
 * Runs awaiting their consent proof, and the last time each target was run.
 *
 * In-memory on purpose for now: a restart forgetting pending challenges is
 * harmless (re-issue one), and it keeps Day 3 free of a database. The
 * per-target cooldown is the one thing that would ideally survive a restart —
 * noted in the honesty table rather than quietly ignored.
 */
const pendingRuns = new Map();
const lastRunByOrigin = new Map();

/** The origin that is authoritative for consenting to a probe URL. */
export function authoritativeOrigin(rawUrl) {
  const url = new URL(rawUrl);
  return url.origin;
}

/**
 * Step 1: issue a one-time code for a run.
 *
 * Returns instructions plain enough to follow without reading any docs.
 */
export async function issueChallenge({ targetUrl, payerAddress, now = Date.now(), allowPrivateAddresses = false }) {
  const guard = await checkTarget(targetUrl, { allowPrivateAddresses });
  if (!guard.ok) {
    return { ok: false, reason: guard.reason };
  }
  if (!payerAddress || !/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) {
    return { ok: false, reason: 'a valid paying wallet address is required' };
  }

  const origin = authoritativeOrigin(targetUrl);

  // Cross-run cooldown, enforced per target regardless of who is paying.
  // Without this, paying repeatedly is simply unlimited flooding with extra
  // steps — the per-run cap alone does not bound total traffic over time.
  const last = lastRunByOrigin.get(origin);
  if (last && now - last < THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET) {
    const waitMs = THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET - (now - last);
    return {
      ok: false,
      reason: `this target was certified recently; next run allowed in ${Math.ceil(waitMs / 60000)} minute(s)`,
      retryAfterMs: waitMs,
    };
  }

  const runId = randomBytes(12).toString('hex');
  const challengeCode = `sp-${randomBytes(16).toString('hex')}`;
  const expiresAt = now + THRESHOLDS.CONSENT_CHALLENGE_TTL_MS;
  const payer = payerAddress.toLowerCase();

  pendingRuns.set(runId, { runId, targetUrl, origin, payerAddress: payer, challengeCode, expiresAt, verified: false });

  return {
    ok: true,
    runId,
    challengeCode,
    expiresAt,
    consentUrl: `${origin}${WELL_KNOWN_PATH}`,
    expiresInMinutes: Math.round(THRESHOLDS.CONSENT_CHALLENGE_TTL_MS / 60000),
    instructions:
      `Publish a plain-text file at ${origin}${WELL_KNOWN_PATH} containing these three lines, ` +
      `then start the run within ${Math.round(THRESHOLDS.CONSENT_CHALLENGE_TTL_MS / 60000)} minutes:\n` +
      `challenge=${challengeCode}\n` +
      `payer=${payer}\n` +
      `target=${targetUrl}`,
    willSendAtMost: MAX_REQUESTS_PER_RUN,
  };
}

/**
 * Parse the consent file. Tolerant of formatting, strict about content.
 *
 * Being fussy about whitespace or line order would generate support pain for
 * no security benefit — an attacker is not stopped by requiring CRLF. Being
 * fussy about the three values is the part that matters.
 */
export function parseConsentFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Step 2: fetch the consent file and check it proves what it must.
 *
 * All three bindings are required together:
 *   challenge — proves control right now, not at some point in the past
 *   payer     — ties the permission to whoever is paying for this run
 *   target    — stops permission for one endpoint authorising another
 */
export async function verifyChallenge({ runId, now = Date.now(), allowPrivateAddresses = false, fetchImpl = safeFetch }) {
  const run = pendingRuns.get(runId);
  if (!run) return { ok: false, reason: 'unknown or already-used run id' };
  if (run.verified) return { ok: false, reason: 'this run has already been started' };
  if (now > run.expiresAt) {
    pendingRuns.delete(runId);
    return { ok: false, reason: 'the consent code expired; request a new one' };
  }

  const consentUrl = `${run.origin}${WELL_KNOWN_PATH}`;
  const res = await fetchImpl(consentUrl, {
    method: 'GET',
    timeoutMs: 10_000,
    maxBytes: THRESHOLDS.CONSENT_FILE_MAX_BYTES,
    allowPrivateAddresses,
  });

  if (res.refusedByGuard) return { ok: false, reason: `consent file refused: ${res.refusedByGuard}` };
  if (res.networkError) return { ok: false, reason: `could not fetch ${consentUrl} (${res.networkError})` };
  if (res.status !== 200) return { ok: false, reason: `${consentUrl} returned HTTP ${res.status}, expected 200` };
  if (res.truncated) return { ok: false, reason: 'consent file is larger than 4KB' };

  const fields = parseConsentFile(res.body);

  if (fields.challenge !== run.challengeCode) {
    return {
      ok: false,
      reason: fields.challenge
        ? 'the consent file has a different code — it may be from an earlier run'
        : 'the consent file has no challenge= line',
    };
  }
  if ((fields.payer ?? '').toLowerCase() !== run.payerAddress) {
    return { ok: false, reason: 'the consent file names a different paying wallet' };
  }
  if (fields.target !== run.targetUrl) {
    return { ok: false, reason: 'the consent file names a different target URL' };
  }

  run.verified = true;
  run.verifiedAt = now;
  lastRunByOrigin.set(run.origin, now);
  return { ok: true, runId, targetUrl: run.targetUrl, payerAddress: run.payerAddress, maxRequests: MAX_REQUESTS_PER_RUN };
}

/** Test-only reset, so suites do not leak state into one another. */
export function _resetConsentState() {
  pendingRuns.clear();
  lastRunByOrigin.clear();
}

export function _peekRun(runId) {
  return pendingRuns.get(runId);
}
