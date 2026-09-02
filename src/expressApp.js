// The HTTP surface.
//
// Three things a judge, a buyer, or a curious builder can do without reading
// any documentation:
//   GET  /                      the page, explaining what this does and does not do
//   POST /demo/certify          certify an allow-listed target, free, no wallet
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

import { issueChallenge, verifyChallenge } from './lib/consent.js';
import { runCertification, toReport } from './lib/runCertification.js';
import { signReport, verifyCertificate, getSignerAddress } from './lib/attestation.js';
import { resolvePaymentConfig, buildCertifyPaymentOption, RUN_PRICE_USDC } from './lib/payment.js';
import { createPaymentGate, readPayerFromRequest, paymentMatchesConsent } from './lib/paymentGate.js';
import { MAX_REQUESTS_PER_RUN, PROBE_ORDER, CANARY_TOKEN } from './lib/spec.js';
import { explainVerdict, explainerStatus } from './lib/explain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Reports live in memory: a restart losing them is harmless, since every
 *  report is independently verifiable from its own signature. */
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

export function createApp({ demoAllowlist = [], payment = createPaymentGate() } = {}) {
  const app = express();
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

    const { targetUrl, payerAddress } = req.body;
    const result = await issueChallenge({ targetUrl, payerAddress });
    if (!result.ok) return res.status(400).json({ error: result.reason, retryAfterMs: result.retryAfterMs });

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

    const consent = await verifyChallenge({ runId: req.params.runId });
    if (!consent.ok) return res.status(403).json({ error: consent.reason });

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
    res.json(stored);
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
      return res.json(await storeReport(run));
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
    res.json(await storeReport(run));
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
        // Said plainly: reports are held in memory, so a restart drops them.
        // That is not a loss of evidence, because anyone holding the report
        // and certificate can still check them via POST /verify.
        note: 'reports are kept in memory and are dropped when the service restarts. If you saved the report and certificate, POST them to /verify instead, because that check does not need our copy.',
      });
    }

    // An UNSIGNED report is not a failed one, and saying so matters. A
    // deployment with no signing key produces reports with no certificate;
    // running those through the tamper check answers "no certificate supplied"
    // and, worded as a failure, would tell a reader to distrust a report that
    // is perfectly sound and simply was never signed. Two different states,
    // two different answers.
    const unsigned = !found.certificate;
    const result = unsigned
      ? {
          valid: null,
          signedByStressProof: false,
          reason:
            'this report was never signed, because the deployment that produced it has no signing key configured. That is not a sign of tampering: there is simply nothing to check it against.',
        }
      : withSignerCheck(verifyCertificate(found.report, found.certificate), found.certificate);

    res.json({
      reportId: found.id,
      signed: !unsigned,
      ...result,
      target: found.certificate?.target ?? found.report?.target,
      verdict: found.certificate?.verdict ?? found.report?.verdict,
      score: found.certificate?.score ?? found.report?.score,
      meaning: unsigned
        ? 'Unsigned, so it cannot be checked. Take it as an unverified claim rather than as evidence.'
        : result.valid && result.signedByStressProof
          ? 'This report has not been altered since we signed it.'
          : 'Do not trust this report. ' + (result.reason ?? 'It failed verification.'),
      checkItYourself: {
        report: `GET /reports/${found.id}`,
        method: 'POST the report and certificate to /verify from anywhere, or recover the signer from the EIP-712 signature with any library. You do not have to take our word for any of this.',
        publishedSignerAddress: getSignerAddress(),
      },
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

  const stored = { id, report, certificate, explanation, explanationUnavailable };
  reports.set(id, stored);
  return stored;
}

export { reports };
