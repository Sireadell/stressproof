// The HTTP surface.
//
// Three things a judge, a buyer, or a curious builder can do without reading
// any documentation:
//   GET  /                      the page, explaining what this does and does not do
//   POST /demo/certify          certify an allow-listed target, free, no wallet
//   GET  /c/<token>             a certificate link that needs no server state
//   POST /verify                check any signed report, without trusting us
//
// And the real flow, which requires proving you control the target:
//   POST /runs                  ask for a one-time consent code
//   POST /runs/:runId/start     prove consent, then run the certification
//
// The route layer NEVER passes allowPrivateAddresses. That option exists only
// so the test suite can point at a local fixture; because it is a function
// argument rather than an environment variable, no deployment mistake or stray
// env var can switch the safety guard off in production.

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { issueChallenge, issueStandingRun, verifyConsent, CONSENT_MODE } from './lib/consent.js';
import { runCertification, toReport } from './lib/runCertification.js';
import { signReport, verifyCertificate, getSignerAddress } from './lib/attestation.js';
import { resolvePaymentConfig, buildCertifyPaymentOption, RUN_PRICE_USDC } from './lib/payment.js';
import { createPaymentGate, readPayerFromRequest, paymentMatchesConsent } from './lib/paymentGate.js';
import { MAX_REQUESTS_PER_RUN, PROBE_ORDER, CANARY_TOKEN, CONSENT_POLICY } from './lib/spec.js';
import { explainVerdict, explainerStatus } from './lib/explain.js';
import { encodeCertificateLink, decodeCertificateLink } from './lib/certificateLink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reports live in memory, and that is now a convenience rather than the
 * mechanism.
 *
 * This Map is a same-process shortcut: while the instance that issued a report
 * is still alive, `GET /reports/<id>` and `GET /verify/<id>` can answer from
 * it. It is not what makes a certificate durable, because it cannot be. On the
 * free hosting plan the process is spun down after 15 minutes of quiet and the
 * filesystem goes with it, so anything kept here has a lifetime measured in
 * minutes.
 *
 * The durable answer is the permanent link built in `storeReport`, which
 * carries the whole report and certificate inside the URL and needs no stored
 * state at all. See `lib/certificateLink.js` for why that beat a database.
 */
const reports = new Map();

/** Free demo budget, so an open route cannot become the abuse vector the
 *  paid route was designed to prevent. */
const demoState = { day: new Date().toDateString(), used: 0, byIp: new Map() };
const DEMO_DAILY_LIMIT = 40;
const DEMO_PER_IP_LIMIT = 3;

function demoBudgetCheck(ip) {
  const today = new Date().toDateString();
  if (demoState.day !== today) {
    demoState.day = today;
    demoState.used = 0;
    demoState.byIp.clear();
  }
  if (demoState.used >= DEMO_DAILY_LIMIT) {
    return { ok: false, reason: 'the free demo budget for today is spent; try again tomorrow' };
  }
  const perIp = demoState.byIp.get(ip) ?? 0;
  if (perIp >= DEMO_PER_IP_LIMIT) {
    return { ok: false, reason: `the free demo allows ${DEMO_PER_IP_LIMIT} runs per address` };
  }
  return { ok: true };
}

function noteDemoUse(ip) {
  demoState.used += 1;
  demoState.byIp.set(ip, (demoState.byIp.get(ip) ?? 0) + 1);
}

function validateTargetInput(body) {
  const { targetUrl, method, sampleBody } = body ?? {};
  if (typeof targetUrl !== 'string' || !targetUrl) return 'targetUrl is required';
  if (sampleBody == null || typeof sampleBody !== 'object') {
    // Stated plainly because it is the least obvious requirement, and the
    // reason for it is worth explaining rather than just enforcing.
    return 'sampleBody is required: one request your agent accepts and answers correctly. Without it we would have to guess your schema, and guessing is what makes a tester unfair.';
  }
  if (method && !['POST', 'GET', 'PUT', 'PATCH'].includes(String(method).toUpperCase())) {
    return `unsupported method '${method}'`;
  }
  return null;
}

/**
 * Answer the question `verifyCertificate` deliberately does not: was this
 * signed by *us*?
 *
 * `verifyCertificate` is a pure self-consistency check — it proves the report
 * matches its hash and the signature matches the address the certificate
 * claims. A forger can satisfy all of that with their own key. Comparing
 * against our published signer address is what separates "internally
 * consistent" from "issued by StressProof", and the two are reported as
 * separate fields so neither can be mistaken for the other.
 */
function withSignerCheck(result, certificate) {
  const ours = getSignerAddress();
  const claimed = certificate?.signerAddress;
  const signedByStressProof =
    Boolean(result.valid) &&
    Boolean(ours) &&
    String(claimed).toLowerCase() === String(ours).toLowerCase();

  const out = { ...result, signedByStressProof };
  if (result.valid && !signedByStressProof) {
    out.reason = ours
      ? 'the signature is internally consistent but was not made by the StressProof signing key — this certificate did not come from us'
      : 'this deployment has no signing key configured, so we cannot confirm the certificate came from us';
  }
  return out;
}

/**
 * The one description of what a verification found, used by both routes that
 * can produce one.
 *
 * Shared rather than written twice on purpose. `GET /verify/<id>` and
 * `GET /c/<token>` differ only in where the bytes came from, and the answer to
 * "is this certificate sound" must not depend on that. Two hand-maintained
 * copies of this wording is how one route quietly starts calling an unsigned
 * report untrustworthy while the other calls it unsigned.
 *
 * @param {{ id: string|null, report: object, certificate: object|null }} held
 */
function describeVerification(held) {
  // An UNSIGNED report is not a failed one, and saying so matters. A
  // deployment with no signing key produces reports with no certificate;
  // running those through the tamper check answers "no certificate supplied"
  // and, worded as a failure, would tell a reader to distrust a report that
  // is perfectly sound and simply was never signed. Two different states,
  // two different answers.
  const unsigned = !held.certificate;
  const result = unsigned
    ? {
        valid: null,
        signedByStressProof: false,
        reason:
          'this report was never signed, because the deployment that produced it has no signing key configured. That is not a sign of tampering: there is simply nothing to check it against.',
      }
    : withSignerCheck(verifyCertificate(held.report, held.certificate), held.certificate);

  return {
    reportId: held.id,
    signed: !unsigned,
    ...result,
    target: held.certificate?.target ?? held.report?.target,
    verdict: held.certificate?.verdict ?? held.report?.verdict,
    score: held.certificate?.score ?? held.report?.score,
    meaning: unsigned
      ? 'Unsigned, so it cannot be checked. Take it as an unverified claim rather than as evidence.'
      : result.valid && result.signedByStressProof
        ? 'This report has not been altered since we signed it.'
        : 'Do not trust this report. ' + (result.reason ?? 'It failed verification.'),
    // The full report travels with the answer here. On the link route there is
    // no id to look it up by afterwards, and a verdict with no evidence under
    // it is the shape of claim this product exists to object to.
    report: held.report,
    checkItYourself: {
      report: held.id ? `GET /reports/${held.id}` : 'included above, in full',
      method:
        'POST the report and certificate to /verify from anywhere, or recover the signer from the EIP-712 signature with any library. You do not have to take our word for any of this.',
      publishedSignerAddress: getSignerAddress(),
    },
  };
}

export function createApp({ demoAllowlist = [], payment = createPaymentGate() } = {}) {
  const app = express();

  // WITHOUT THIS, THE FREE DEMO ALLOWS THREE RUNS IN TOTAL, NOT THREE PER
  // VISITOR. Deployed, we sit behind Render's load balancer, so every request
  // arrives from the same proxy address. `req.ip` is then that proxy for
  // everybody, the per-address demo limit counts all visitors as one caller,
  // and the fourth person to ever try the demo is refused as a repeat
  // offender. It works perfectly on a laptop, where there is no proxy, which
  // is exactly the kind of difference that only shows up in front of an
  // audience.
  //
  // Trusting exactly ONE hop, not `true`. `trust proxy: true` would take the
  // leftmost entry of X-Forwarded-For, which is supplied by the caller and can
  // therefore be invented at will, handing anyone an unlimited supply of fresh
  // identities and defeating the limit in the other direction. One hop reads
  // the entry our own load balancer added. The daily budget still stands
  // behind it either way.
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // The paid route's door, mounted before any route so an unpaid request
  // never reaches a handler. When the gate is not live there is no middleware
  // to mount, and the paid handler refuses on its own. See the top of it.
  if (payment.middleware) app.use(payment.middleware);

  // --- what this is, in machine-readable form ------------------------------
  app.get('/about', (_req, res) => {
    const config = resolvePaymentConfig();
    res.json({
      product: 'StressProof',
      claim: 'We do not check whether your agent is correct. We check whether it tells you when it cannot answer.',
      probes: PROBE_ORDER,
      maxRequestsPerRun: MAX_REQUESTS_PER_RUN,
      price: { amount: RUN_PRICE_USDC, currency: 'USDC', network: config.network, per: 'run' },
      // Stated plainly rather than inferred from whether a 402 comes back,
      // so nobody has to probe the paid route to find out what it will do.
      payment: {
        status: payment.mode, // live | off | misconfigured
        paidRunsAvailable: payment.enabled,
        chargesFor: 'POST /runs/:runId/start',
        note: payment.reason ?? 'One charge per run, not per probe. A run against an unreachable or broken target still bills: the work is the probing, not the verdict.',
      },
      // Same reasoning as the payment block above. A missing explanation is
      // ambiguous unless the service says which kind of missing it is.
      explainer: (() => {
        const status = explainerStatus();
        return {
          available: status.configured,
          model: status.model ?? null,
          note:
            status.reason ??
            'Describes an already-decided verdict in plain English. It never sees the scoring rules and cannot change a verdict. On any failure it stays silent rather than inventing one.',
        };
      })(),
      // Said here rather than left to be discovered, because a scheduler
      // deciding whether unattended re-certification is possible at all needs
      // to know the second mode exists before it writes any code.
      consent: {
        modes: Object.values(CONSENT_MODE),
        default: CONSENT_MODE.CHALLENGE,
        standing: {
          askFor: "POST /runs with consentMode: 'standing'",
          maxPermissionDays: Math.round(CONSENT_POLICY.STANDING_CONSENT_MAX_LIFETIME_MS / 86_400_000),
          note: 'The permission file is re-fetched and fully re-checked before every run. Deleting it stops the next run, and it expires on a date you publish.',
        },
      },
      // Named here so nobody has to work out which of the three verification
      // routes survives a restart. Two of them depend on this process still
      // holding the report; one of them does not, and that is the difference
      // worth publishing.
      verification: {
        permanentLink: 'GET /c/<token>',
        note: 'every report is issued with a permanent link that carries the whole report and signature inside the URL. It needs no stored state, so it still verifies after this service restarts, sleeps, redeploys, or is shut down for good.',
        stateDependent: ['GET /verify/<reportId>', 'GET /reports/<reportId>'],
        stateDependentNote: 'these read a copy held in this process. On the free hosting plan the process is spun down after 15 minutes without traffic, which drops every copy, so treat a report id as a shortcut rather than as an address.',
        offline: 'POST /verify checks a report and certificate you already hold, against no stored state at all.',
      },
      signerAddress: getSignerAddress(),
      canaryToken: CANARY_TOKEN, // published on purpose: see the page
      limitations: [
        'We do not judge whether an answer is correct, only whether failure is honest.',
        'Two probes cannot reach a firm conclusion when a target answers normally, and say so rather than accusing it.',
        'A RESILIENT verdict is twelve fixed probes run once, not a security audit.',
      ],
    });
  });

  // --- consent: step 1 ------------------------------------------------------
  app.post('/runs', async (req, res) => {
    const invalid = validateTargetInput(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    const { targetUrl, payerAddress, consentMode } = req.body;

    // Standing consent has to be asked for by name. Defaulting to it, or
    // inferring it from the shape of the request, would mean a caller could
    // end up on the long-lived permission without ever choosing it.
    if (consentMode !== undefined && !Object.values(CONSENT_MODE).includes(consentMode)) {
      return res.status(400).json({
        error: `unknown consentMode '${consentMode}'`,
        allowed: Object.values(CONSENT_MODE),
      });
    }

    const result =
      consentMode === CONSENT_MODE.STANDING
        ? await issueStandingRun({ targetUrl, payerAddress })
        : await issueChallenge({ targetUrl, payerAddress });
    if (!result.ok) {
      return res.status(400).json({ error: result.reason, retryAfterMs: result.retryAfterMs, limitHit: result.limitHit });
    }

    // Hold the run's inputs until it starts. The consent module owns the
    // permission side; this owns what to actually send.
    pendingTargets.set(result.runId, {
      url: targetUrl,
      method: (req.body.method ?? 'POST').toUpperCase(),
      sampleBody: req.body.sampleBody,
      authHeaders: req.body.authHeaders ?? null,
    });
    res.status(201).json(result);
  });

  // --- consent: step 2, then the actual run --------------------------------
  app.post('/runs/:runId/start', async (req, res) => {
    // Refuse before anything else if this deployment was meant to charge and
    // cannot. Reaching this line at all means the x402 middleware was never
    // mounted, so continuing would hand out a free run, the one outcome a
    // broken payment setup must never produce.
    if (payment.mode === 'misconfigured') {
      return res.status(503).json({ error: payment.reason });
    }

    const target = pendingTargets.get(req.params.runId);
    if (!target) return res.status(404).json({ error: 'unknown run id' });

    // Dispatches on the mode the run was issued under. A run's permission
    // mode is fixed when it is created, so a caller cannot ask for a one-time
    // run and then satisfy it with a standing file, or the reverse.
    const consent = await verifyConsent({ runId: req.params.runId });
    if (!consent.ok) {
      return res.status(403).json({ error: consent.reason, retryAfterMs: consent.retryAfterMs, limitHit: consent.limitHit });
    }

    // Payment proves a wallet spent money. Consent proves a wallet controls
    // the target. Neither is worth much unless they are the same wallet: if
    // they may differ, anyone holding a run id can buy 30 requests aimed at an
    // agent somebody else vouched for.
    const binding = paymentMatchesConsent({
      paymentEnabled: payment.enabled,
      paidBy: readPayerFromRequest(req),
      consentPayer: consent.payerAddress,
    });
    if (!binding.ok) {
      return res.status(403).json({ error: binding.reason, paidBy: binding.paidBy, expected: binding.expected });
    }

    pendingTargets.delete(req.params.runId);
    const run = await runCertification(target);
    const stored = await storeReport(run);
    res.json(withAbsoluteLink(stored, req));
  });

  // --- free demo -----------------------------------------------------------
  //
  // Two ways in. `demoMode` runs against the deliberately flawed agent WE
  // host, which is what the page uses: no wallet, and no consent question at
  // all, because the target is us. Anything else must be on the allow-list.
  app.post('/demo/certify', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const budget = demoBudgetCheck(ip);
    if (!budget.ok) return res.status(429).json({ error: budget.reason });

    if (typeof req.body?.demoMode === 'string') {
      if (!DEMO_MODES.includes(req.body.demoMode)) {
        return res.status(400).json({ error: `unknown demo mode`, allowed: DEMO_MODES });
      }
      noteDemoUse(ip);
      const run = await certifyOwnDemoAgent(req.body.demoMode);
      return res.json(withAbsoluteLink(await storeReport(run), req));
    }

    const invalid = validateTargetInput(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    // The free route sends real traffic, so it needs the same permission
    // discipline as the paid one. An allow-list is the honest way to offer a
    // no-wallet demo without becoming a way to attack strangers for free.
    const { targetUrl } = req.body;
    const allowed = demoAllowlist.some((entry) => targetUrl.startsWith(entry));
    if (!allowed) {
      return res.status(403).json({
        error: 'the free demo only runs against targets that have already agreed to it',
        allowed: demoAllowlist,
        howToRunAgainstYourOwn: 'POST /runs to get a one-time consent code for your own agent',
      });
    }

    noteDemoUse(ip);
    const run = await runCertification({
      url: targetUrl,
      method: (req.body.method ?? 'POST').toUpperCase(),
      sampleBody: req.body.sampleBody,
      authHeaders: null,
    });
    res.json(withAbsoluteLink(await storeReport(run), req));
  });

  // --- verification: check any report without trusting us -------------------
  //
  // Two ways in, because they answer different questions.
  //
  // POST /verify takes a report and certificate you already hold and checks
  // them against each other. It never consults our stored copy, so it keeps
  // working on a report you saved months ago, from a machine we do not run.
  //
  // GET /verify/:reportId checks the copy we are serving. It is the one a
  // judge wants: open a link, see whether the certificate we are publishing
  // still matches the report we are publishing beside it.
  //
  // Both report `signedByStressProof` separately from `valid`. A certificate
  // can be perfectly self-consistent and still have been signed by somebody
  // else's key. That is a forged certificate, not a valid one, and reading
  // `valid: true` alone would miss it.
  app.post('/verify', (req, res) => {
    const { report, certificate } = req.body ?? {};
    if (!report || !certificate) {
      return res.status(400).json({ error: 'send { report, certificate }' });
    }
    res.json(withSignerCheck(verifyCertificate(report, certificate), certificate));
  });

  app.get('/verify/:reportId', (req, res) => {
    const found = reports.get(req.params.reportId);
    if (!found) {
      return res.status(404).json({
        error: 'unknown report id',
        // Said plainly, and with the fix named rather than only the problem.
        // An id is a pointer into this process's memory, and the process is
        // spun down after 15 quiet minutes on the free plan. The permanent
        // link handed out with every report is not a pointer at all: it
        // carries the report, so it cannot go stale.
        note: 'a report id only points at a copy held in this process, and the process is restarted or spun down regularly, which drops it. The permanent link issued with every report carries the whole report inside the URL and keeps working. If you saved the report and certificate, POST them to /verify instead, because that check does not need our copy either.',
      });
    }

    res.json(describeVerification(found));
  });

  // --- verification: the link that needs nothing from us --------------------
  //
  // The one a judge should be given. Everything needed to check the
  // certificate is inside the URL, so this answers identically on a freshly
  // woken instance, on a redeployed one, and on a copy of this code running
  // somewhere we have never heard of. There is no lookup here to miss.
  //
  // It is deliberately the SAME answer `GET /verify/<id>` gives, produced by
  // the same function. Two verification routes that could word the same
  // finding differently is how a reader ends up trusting whichever one they
  // happened to open.
  app.get('/c/:token', (req, res) => {
    const decoded = decodeCertificateLink(req.params.token);
    if (!decoded.ok) {
      return res.status(400).json({
        error: decoded.reason,
        note: 'this link is checked entirely from its own contents, so a failure here means the link itself is wrong, not that we have forgotten anything.',
      });
    }

    // Note what is NOT trusted: the link supplied both the report and the
    // certificate, so a stranger controls every byte that arrived. That is
    // fine, and it is the whole point. The signature check below is what
    // decides whether these two belong together and whether we signed them,
    // and it would catch a hand-edited link exactly as it catches a
    // hand-edited report.
    res.json({
      ...describeVerification({ id: null, report: decoded.report, certificate: decoded.certificate }),
      // Repeated here because a reader arriving from a pasted link has no
      // other way to know how much of this the link's sender could have
      // chosen. They chose all of it; the signature is what makes that safe.
      source: 'read from the link itself, not from anything we stored. The signature is what makes that safe: a link with an edited verdict fails the check below.',
    });
  });

  app.get('/reports/:id', (req, res) => {
    const found = reports.get(req.params.id);
    if (!found) return res.status(404).json({ error: 'unknown report id' });
    res.json(found);
  });

  // --- the honesty table, served rather than filed away --------------------
  //
  // This document is the product's main claim about itself: what is real, what
  // is narrower than its name suggests, and what was never built. Keeping it
  // in the repo where only a reader who clones the code would find it would
  // undercut the point of writing it.
  app.get('/honesty', (_req, res) => {
    readFile(path.join(__dirname, '..', 'docs', 'REAL_VS_SIMPLIFIED.md'), 'utf8')
      .then((text) => res.type('text/plain; charset=utf-8').send(text))
      .catch(() => res.status(404).json({ error: 'the honesty table is not available on this deployment' }));
  });

  app.get('/health', (_req, res) => res.json({ ok: true, reports: reports.size }));

  return app;
}

const pendingTargets = new Map();

const DEMO_MODES = ['honest', 'sloppy', 'crashy', 'echoer'];

/**
 * Certify the demo agent this process is hosting.
 *
 * THE ONE PLACE THE ADDRESS GUARD IS BYPASSED, and it is worth being precise
 * about why that is still safe. The guard exists to stop a *caller* pointing
 * us at a private or internal address. Here the URL is not caller input at
 * all: this process started the agent itself, on a loopback port it chose, and
 * the only thing a caller supplies is which of four behaviours it should
 * pretend to have. No user input reaches the address.
 *
 * Every other route passes user-supplied URLs straight to the guard with no
 * bypass available, because `allowPrivateAddresses` is a function argument and
 * not an environment variable — there is no setting that could switch the
 * guard off in production by accident.
 */
async function certifyOwnDemoAgent(mode) {
  const { createFakeAgent } = await import('./lib/demoAgent.js');
  const agent = createFakeAgent({ mode });
  const url = await agent.listen();
  try {
    return await runCertification(
      {
        url,
        method: 'POST',
        sampleBody: { query: 'what is the weather', wallet: '0xabc', max_results: 5 },
        allowPrivateAddresses: true, // see the note above: not caller input
      },
      { probeOpts: { dripMs: 120, cutoffMs: 600 } },
    );
  } finally {
    agent.close();
  }
}

async function storeReport(run) {
  const report = toReport(run);
  const certificate = await signReport(report);
  const explanation = await explainVerdict(report);
  const id = certificate?.reportHash?.slice(2, 18) ?? Math.random().toString(16).slice(2, 18);

  // A null explanation is never left unlabelled. "Switched off", "the model
  // failed just now" and "nothing to say" all look the same from outside, and
  // a reader who cannot tell them apart will assume the feature is broken.
  const status = explainerStatus();
  const explanationUnavailable = explanation
    ? null
    : status.configured
      ? 'the explanation model did not answer in time, so this report carries evidence and a verdict without a summary. Nothing about the verdict changes.'
      : status.reason;

  // The durable half of the answer. Built once, here, so every route that can
  // produce a report hands out the same kind of link without having to
  // remember to. A link that came out too long to serve reliably is reported
  // as unavailable with the reason, rather than published and left to break
  // inside somebody's proxy.
  const link = encodeCertificateLink({ report, certificate });

  const stored = {
    id,
    report,
    certificate,
    explanation,
    explanationUnavailable,
    permanentLink: link.ok ? link.path : null,
    permanentLinkUnavailable: link.ok ? null : link.reason,
  };
  reports.set(id, stored);
  evictOldReports();
  return stored;
}

/**
 * How many reports the same-process shortcut will hold.
 *
 * A cap became the obviously correct thing the moment the permanent link
 * existed. Before it, dropping a report meant losing it, so an unbounded Map
 * was at least arguable. Now the link is what makes a report durable and this
 * Map is only a convenience, so holding every report a long-lived process ever
 * produced buys nothing and slowly spends a 512MB instance's memory on it.
 *
 * 200 is generous next to the free demo's 40 runs a day, and a report is about
 * ten kilobytes, so the ceiling is roughly two megabytes.
 */
const MAX_HELD_REPORTS = 200;

/**
 * Drop the oldest reports once the shortcut is full.
 *
 * Oldest first, relying on Map preserving insertion order. Evicting a report
 * is not losing it: whoever ran it holds a permanent link that verifies with no
 * help from us, which is exactly the property that makes this safe to do.
 */
function evictOldReports() {
  while (reports.size > MAX_HELD_REPORTS) {
    const oldest = reports.keys().next().value;
    reports.delete(oldest);
  }
}

/**
 * Turn the stored report's relative permanent link into one somebody can
 * actually click.
 *
 * Done at response time rather than at storage time because only a request
 * knows what host it arrived on. The same report served from localhost and
 * from the deployed service should hand back a link to whichever one the
 * caller is actually talking to, and a base URL baked in at boot gets that
 * wrong the first time anyone runs this anywhere else.
 */
function withAbsoluteLink(stored, req) {
  if (!stored.permanentLink) return stored;
  return {
    ...stored,
    permanentUrl: `${req.protocol}://${req.get('host')}${stored.permanentLink}`,
    // Said next to the link, because the reason a link this long is worth
    // having is not obvious from looking at it.
    permanentLinkNote:
      'this link carries the whole report and its signature inside the URL, so it verifies with no help from us. It keeps working after this service restarts, sleeps, redeploys, or shuts down for good. The report id above is only a shortcut while this process happens to still be running.',
  };
}

export { reports, MAX_HELD_REPORTS };
