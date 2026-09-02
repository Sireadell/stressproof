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
//
// ONE ADDITION, MADE LATER AND KEPT SEPARATE
// -------------------------------------------
// Everything above still holds and is still the default. What it does not
// cover is recurring, unattended re-certification, where requiring a fresh
// code before every run means requiring a person before every run. A second
// opt-in mode, standing consent, is added further down this file with its own
// argument for why it is safe enough and its own list of what it does not
// cover. Nothing about the one-time flow changes to accommodate it.

import { randomBytes } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { checkTarget } from './netGuard.js';
import { THRESHOLDS, MAX_REQUESTS_PER_RUN, CONSENT_POLICY } from './spec.js';

export const WELL_KNOWN_PATH = '/.well-known/stressproof.txt';

/**
 * The two ways a run can be authorised. `challenge` is the default and is
 * unchanged; `standing` is opt-in and has to be asked for by name.
 */
export const CONSENT_MODE = Object.freeze({ CHALLENGE: 'challenge', STANDING: 'standing' });

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
 * The checks every run has to pass before it is allowed to exist, whichever
 * consent mode it will use.
 *
 * Pulled out of `issueChallenge` when standing consent was added, rather than
 * copied into it. The cooldown in particular is the whole reason paying twice
 * is not unlimited flooding, and a second entry point with its own hand-copied
 * version of that check is precisely how a rate limit ends up applying to one
 * route and not the other.
 */
async function admitRun({ targetUrl, payerAddress, now, allowPrivateAddresses }) {
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
      // Named so a caller can tell our limit apart from the one their own
      // consent file sets. Standing consent has two, and being told to wait
      // by the wrong one sends an owner to edit a file that was never the
      // problem.
      limitHit: 'stressproof',
    };
  }

  return { ok: true, origin, payer: payerAddress.toLowerCase() };
}

/**
 * Step 1: issue a one-time code for a run.
 *
 * Returns instructions plain enough to follow without reading any docs.
 */
export async function issueChallenge({ targetUrl, payerAddress, now = Date.now(), allowPrivateAddresses = false }) {
  const pre = await admitRun({ targetUrl, payerAddress, now, allowPrivateAddresses });
  if (!pre.ok) return pre;
  const { origin } = pre;

  const runId = randomBytes(12).toString('hex');
  const challengeCode = `sp-${randomBytes(16).toString('hex')}`;
  const expiresAt = now + THRESHOLDS.CONSENT_CHALLENGE_TTL_MS;
  const payer = payerAddress.toLowerCase();

  pendingRuns.set(runId, {
    runId,
    mode: CONSENT_MODE.CHALLENGE,
    targetUrl,
    origin,
    payerAddress: payer,
    challengeCode,
    expiresAt,
    verified: false,
  });

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

// STANDING CONSENT: the opt-in second mode, and the argument for it.
// ---------------------------------------------------------------------------
//
// The one-time code above is right for a one-off certification and impossible
// for a recurring one. Halflife's product is an unattended re-check on a
// schedule, and under the challenge flow every one of those would stall until
// a human went and published a fresh code. A permission model that requires a
// person at 3am is not a permission model for scheduled work, it is a way of
// guaranteeing the work never runs.
//
// So a target's owner may instead publish one file that authorises ONE named
// paying wallet to certify ONE exact target URL, no more often than the owner
// allows, until a date the owner picks. It carries everything the one-time
// file carries except the per-run code, plus two fields the one-time file has
// no need for.
//
// FIVE FIELDS, ALL FIVE RE-READ AND CHECKED BEFORE EVERY RUN:
//
//   target=                 the exact agent URL being authorised
//   payer=                  the one wallet allowed to pay for testing it
//   expires=                when this permission dies
//   min-hours-between-runs= the owner's own limit on how often we may run
//   standing=yes            the marker saying this is a standing permission
//
// The marker is not decoration. Without it a one-time file and a standing file
// are told apart by guesswork, and guessing wrong in either direction is bad:
// reading a one-time file as standing would turn a fifteen-minute permission
// into a month-long one, and reading a standing file as one-time would refuse
// an owner who did everything right.
//
// DELETION AND EXPIRY ARE TWO DIFFERENT PROTECTIONS AGAINST TWO DIFFERENT
// FAILURES, and the file needs both. Deleting the file cancels the permission
// immediately, on the next run, with nobody to notify. That covers the owner
// who changes their mind, or who discovers something and wants it stopped now.
// It does nothing at all for the far more common failure, which is a file
// somebody published once, forgot about, and never thinks about again. Only
// the expiry date covers that one, because it is the only protection that
// works when nobody is paying attention. Either one alone leaves a real hole.
//
// WHAT REPLACES THE CODE, AND WHAT DOES NOT
//
// The code did one job that the rest of the file could not: it proved control
// of the origin *at the moment of asking*, because a code that did not exist
// ten minutes ago cannot have been published by whoever controlled the domain
// last year. Three things stand in for that here, and it is worth being exact
// about how much each one actually buys.
//
//   1. THE FILE IS RE-FETCHED LIVE BEFORE EVERY SINGLE RUN. Never cached,
//      never remembered from the last run, never inferred. This is most of the
//      answer. It means the permission is not a record of something that
//      happened once, it is a question asked again every time, and the origin
//      has to keep answering it. Deleting the file, editing the payer, or
//      changing the target revokes the permission on the very next run with
//      nobody to notify and nothing to coordinate. An owner who loses control
//      of the domain does not need to reach us; the new controller stops
//      serving our file, or serves a different one, and the runs stop.
//
//   2. THE PERMISSION EXPIRES ON A DATE THE OWNER PUBLISHES, and we refuse
//      past it. Consent that cannot be withdrawn by inaction is not consent,
//      which is the objection at the top of this file, and it applies with
//      full force to a file left up and forgotten. The expiry is what turns
//      inaction back into withdrawal.
//
//   3. THE CEILING. However far out the file's own date is, we refuse anything
//      claiming more remaining life than CONSENT_POLICY allows. An owner
//      cannot write "expires 2099" and be done with it, so the file has to be
//      touched by somebody periodically, which is a weak but real recurring
//      proof of continued control.
//
// WHAT THIS HONESTLY DOES NOT COVER, and it is not nothing:
//
//   - It does not prove a human decided anything at run time. A file published
//     once and forgotten authorises every run until it expires. The one-time
//     code narrowed that window to fifteen minutes. Standing consent widens it
//     to as much as thirty days, and that is the trade being made rather than
//     an oversight.
//   - Anyone who can write files at the target's origin inherits the
//     permission for the rest of the window: a compromised deploy pipeline, a
//     stale build that redeploys an old copy of the file, a subdomain
//     takeover. The challenge flow has the same weakness but only for fifteen
//     minutes at a time.
//   - "Revocation takes effect on the next run" is only as fast as the
//     origin's own caching. A CDN still serving a deleted file will still be
//     consenting on the owner's behalf. We send no-cache request headers,
//     which asks politely and proves nothing.
//   - The owner's own frequency limit is a permission, not a defence. It says
//     how often the owner is willing to be tested, and it is honoured, but a
//     caller cannot use it to protect a target it does not control, because
//     the file it lives in is written by the target's own operator.
//   - It is still an origin-level permission. Anything that could make one
//     tenant able to publish at another tenant's origin was already fatal to
//     the challenge flow and is still fatal here.
//
// The mode is opt-in, and a standing file must say `standing=yes` out loud. A
// file written for the one-time flow is never silently reinterpreted as an
// open-ended permission.

/**
 * Ask for a run that will be authorised by a standing consent file.
 *
 * Issues no code, because there is none. The cooldown, the address guard and
 * the payer format check all apply exactly as they do to a one-time run: see
 * `admitRun`.
 */
export async function issueStandingRun({ targetUrl, payerAddress, now = Date.now(), allowPrivateAddresses = false }) {
  const pre = await admitRun({ targetUrl, payerAddress, now, allowPrivateAddresses });
  if (!pre.ok) return pre;
  const { origin, payer } = pre;

  const runId = randomBytes(12).toString('hex');
  pendingRuns.set(runId, {
    runId,
    mode: CONSENT_MODE.STANDING,
    targetUrl,
    origin,
    payerAddress: payer,
    challengeCode: null,
    // The run id itself still expires, on the same short window as a one-time
    // one. This is not the permission's expiry, it is a limit on how long an
    // unstarted run may sit in memory. A run id that lived forever would be a
    // slow memory leak and an unnecessary thing to hold.
    expiresAt: now + THRESHOLDS.CONSENT_CHALLENGE_TTL_MS,
    verified: false,
  });

  const maxDays = Math.round(CONSENT_POLICY.STANDING_CONSENT_MAX_LIFETIME_MS / 86_400_000);
  return {
    ok: true,
    runId,
    consentMode: CONSENT_MODE.STANDING,
    consentUrl: `${origin}${WELL_KNOWN_PATH}`,
    maxPermissionDays: maxDays,
    instructions:
      `Publish a plain-text file at ${origin}${WELL_KNOWN_PATH} containing these five lines:\n` +
      `standing=yes\n` +
      `payer=${payer}\n` +
      `target=${targetUrl}\n` +
      `expires=<an ISO 8601 date at most ${maxDays} days from now, for example 2026-10-01T00:00:00Z>\n` +
      `min-hours-between-runs=<the shortest gap you are willing to be tested at, for example 24>\n` +
      `That file authorises this one wallet to certify this one URL repeatedly until that date, ` +
      `no more often than you allow. It is fetched fresh before every run, so deleting or editing it ` +
      `stops the next run immediately, and it must be renewed at least every ${maxDays} days. ` +
      `We also enforce our own minimum gap of ${Math.round(THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET / 60000)} minutes ` +
      `between runs against any one target, and whichever of the two limits is stricter is the one that applies.`,
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
  if (run.mode === CONSENT_MODE.STANDING) {
    return { ok: false, reason: 'this run asked for standing consent, so it cannot be started with a one-time code' };
  }
  if (run.verified) return { ok: false, reason: 'this run has already been started' };
  if (now > run.expiresAt) {
    pendingRuns.delete(runId);
    return { ok: false, reason: 'the consent code expired; request a new one' };
  }

  const fetched = await fetchConsentFile(run, { allowPrivateAddresses, fetchImpl });
  if (!fetched.ok) return fetched;
  const fields = fetched.fields;

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
  return {
    ok: true,
    runId,
    consentMode: CONSENT_MODE.CHALLENGE,
    targetUrl: run.targetUrl,
    payerAddress: run.payerAddress,
    maxRequests: MAX_REQUESTS_PER_RUN,
  };
}

/**
 * Fetch the consent file for a run, with every transport failure turned into a
 * refusal rather than an exception.
 *
 * Shared by both modes deliberately. The standing mode's whole safety argument
 * rests on this being a live fetch every time, so it uses the same code path as
 * the one-time mode rather than a second one that could quietly grow a cache.
 */
async function fetchConsentFile(run, { allowPrivateAddresses, fetchImpl }) {
  const consentUrl = `${run.origin}${WELL_KNOWN_PATH}`;
  const res = await fetchImpl(consentUrl, {
    method: 'GET',
    timeoutMs: 10_000,
    maxBytes: THRESHOLDS.CONSENT_FILE_MAX_BYTES,
    allowPrivateAddresses,
    // Asks intermediaries not to answer from a copy. It is a request, not a
    // guarantee, and the honesty note above says so: a CDN still serving a
    // deleted file is still consenting on the owner's behalf.
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });

  if (res.refusedByGuard) return { ok: false, reason: `consent file refused: ${res.refusedByGuard}` };
  if (res.networkError) return { ok: false, reason: `could not fetch ${consentUrl} (${res.networkError})` };
  if (res.status !== 200) return { ok: false, reason: `${consentUrl} returned HTTP ${res.status}, expected 200` };
  if (res.truncated) return { ok: false, reason: 'consent file is larger than 4KB' };

  return { ok: true, fields: parseConsentFile(res.body), consentUrl };
}

/**
 * Read the owner's own frequency limit out of the file.
 *
 * Required, not optional. An owner who publishes an open-ended permission
 * should have to state how often they are willing to be tested, because the
 * alternative is that the number gets picked by us and presented as theirs.
 */
function parseOwnerInterval(raw) {
  if (raw === undefined || raw === '') {
    return { ok: false, reason: 'the consent file has no min-hours-between-runs= line, which says how often you are willing to be tested' };
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    return { ok: false, reason: `min-hours-between-runs=${raw} is not a number of hours` };
  }
  return { ok: true, ms: hours * 3_600_000, hours };
}

/**
 * Step 2, standing mode: re-read the whole permission and check all five
 * fields, every single run.
 *
 * Nothing here is remembered between runs. The only state consulted is when
 * this target was last run, which is the rate limit rather than the
 * permission.
 */
export async function verifyStandingConsent({ runId, now = Date.now(), allowPrivateAddresses = false, fetchImpl = safeFetch }) {
  const run = pendingRuns.get(runId);
  if (!run) return { ok: false, reason: 'unknown or already-used run id' };
  if (run.mode !== CONSENT_MODE.STANDING) {
    return { ok: false, reason: 'this run was issued a one-time code, so it cannot be started with standing consent' };
  }
  if (run.verified) return { ok: false, reason: 'this run has already been started' };
  if (now > run.expiresAt) {
    pendingRuns.delete(runId);
    return { ok: false, reason: 'this run id sat unstarted for too long; ask for a new one' };
  }

  const fetched = await fetchConsentFile(run, { allowPrivateAddresses, fetchImpl });
  if (!fetched.ok) return fetched;
  const fields = fetched.fields;

  // 1. The marker. Checked first so a one-time file gets the refusal that
  //    explains what it actually is, rather than a confusing complaint about a
  //    missing expiry date.
  if ((fields.standing ?? '').toLowerCase() !== 'yes') {
    return {
      ok: false,
      reason:
        `${fetched.consentUrl} is not a standing permission: it has no standing=yes line. ` +
        `Add one, or start this run with a one-time code instead.`,
    };
  }

  // 2. The paying wallet.
  if ((fields.payer ?? '').toLowerCase() !== run.payerAddress) {
    return {
      ok: false,
      reason:
        'the consent file names a different paying wallet. Standing permission is granted to one wallet, ' +
        'so update payer= in the file if the wallet paying for these checks has changed.',
    };
  }

  // 3. The exact agent address.
  if (fields.target !== run.targetUrl) {
    return {
      ok: false,
      reason:
        'the consent file names a different target URL. Permission for one endpoint does not authorise another, ' +
        'so target= has to match the agent being certified exactly.',
    };
  }

  // 4. The expiry, and the ceiling on it.
  const rawExpiry = fields.expires ?? '';
  const expiresAt = Date.parse(rawExpiry);
  if (!Number.isFinite(expiresAt)) {
    return {
      ok: false,
      reason: rawExpiry
        ? `expires=${rawExpiry} is not a date we can read; use an ISO 8601 date such as 2026-10-01T00:00:00Z`
        : 'the consent file has no expires= line, so this permission would never end on its own',
    };
  }
  if (now >= expiresAt) {
    return {
      ok: false,
      reason:
        `this standing permission expired at ${new Date(expiresAt).toISOString()}. ` +
        `Renew it by editing expires= in ${fetched.consentUrl}.`,
    };
  }
  if (expiresAt - now > CONSENT_POLICY.STANDING_CONSENT_MAX_LIFETIME_MS) {
    const maxDays = Math.round(CONSENT_POLICY.STANDING_CONSENT_MAX_LIFETIME_MS / 86_400_000);
    return {
      ok: false,
      reason:
        `this standing permission runs until ${new Date(expiresAt).toISOString()}, which is further out than we accept. ` +
        `Set expires= to at most ${maxDays} days from now. We do not quietly shorten it for you, because that would be ` +
        `us deciding something you said, and renewing it is the only recurring proof that somebody still controls this origin.`,
    };
  }

  // 5. The owner's frequency limit, applied alongside our own cooldown.
  //    Whichever is stricter wins, and the refusal says which one that was, so
  //    an owner is never told to wait by a limit they did not set.
  const owner = parseOwnerInterval(fields['min-hours-between-runs']);
  if (!owner.ok) return owner;

  const last = lastRunByOrigin.get(run.origin);
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < owner.ms && owner.ms >= THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET) {
      return {
        ok: false,
        reason:
          `your own consent file allows one run every ${owner.hours} hour(s) and the last one was ` +
          `${Math.floor(elapsed / 60000)} minute(s) ago. Waiting is the fix, or raise the limit in ${fetched.consentUrl}.`,
        retryAfterMs: owner.ms - elapsed,
        limitHit: 'owner',
      };
    }
    if (elapsed < THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET) {
      const waitMs = THRESHOLDS.MIN_MS_BETWEEN_RUNS_PER_TARGET - elapsed;
      return {
        ok: false,
        reason:
          `this target was certified recently; next run allowed in ${Math.ceil(waitMs / 60000)} minute(s). ` +
          `This is StressProof's own limit on how often any one target may be run, and it applies even when your ` +
          `consent file permits more.`,
        retryAfterMs: waitMs,
        limitHit: 'stressproof',
      };
    }
  }

  run.verified = true;
  run.verifiedAt = now;
  lastRunByOrigin.set(run.origin, now);
  return {
    ok: true,
    runId,
    consentMode: CONSENT_MODE.STANDING,
    targetUrl: run.targetUrl,
    payerAddress: run.payerAddress,
    permissionExpiresAt: new Date(expiresAt).toISOString(),
    ownerMinHoursBetweenRuns: owner.hours,
    maxRequests: MAX_REQUESTS_PER_RUN,
  };
}

/**
 * Start a run under whichever mode it was issued for.
 *
 * The route layer should not be the place that remembers which mode a run id
 * belongs to. Getting that wrong once would mean a standing file being read as
 * a challenge or the reverse, and the run itself already knows the answer.
 */
export async function verifyConsent(args) {
  const run = pendingRuns.get(args?.runId);
  return run?.mode === CONSENT_MODE.STANDING ? verifyStandingConsent(args) : verifyChallenge(args);
}

/** Test-only reset, so suites do not leak state into one another. */
export function _resetConsentState() {
  pendingRuns.clear();
  lastRunByOrigin.clear();
}

export function _peekRun(runId) {
  return pendingRuns.get(runId);
}
