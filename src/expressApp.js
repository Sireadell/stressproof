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

import { issueChallenge, verifyChallenge } from './lib/consent.js';
import { runCertification, toReport } from './lib/runCertification.js';
import { signReport, verifyCertificate, getSignerAddress } from './lib/attestation.js';
import { resolvePaymentConfig, buildCertifyPaymentOption, RUN_PRICE_USDC } from './lib/payment.js';
import { MAX_REQUESTS_PER_RUN, PROBE_ORDER, CANARY_TOKEN } from './lib/spec.js';
import { explainVerdict } from './lib/explain.js';

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

export function createApp({ demoAllowlist = [] } = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- what this is, in machine-readable form ------------------------------
  app.get('/about', (_req, res) => {
    const payment = resolvePaymentConfig();
    res.json({
      product: 'StressProof',
      claim: 'We do not check whether your agent is correct. We check whether it tells you when it cannot answer.',
      probes: PROBE_ORDER,
      maxRequestsPerRun: MAX_REQUESTS_PER_RUN,
      price: { amount: RUN_PRICE_USDC, currency: 'USDC', network: payment.network, per: 'run' },
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
    const target = pendingTargets.get(req.params.runId);
    if (!target) return res.status(404).json({ error: 'unknown run id' });

    const consent = await verifyChallenge({ runId: req.params.runId });
    if (!consent.ok) return res.status(403).json({ error: consent.reason });

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
  app.post('/verify', (req, res) => {
    const { report, certificate } = req.body ?? {};
    if (!report || !certificate) {
      return res.status(400).json({ error: 'send { report, certificate }' });
    }
    res.json(verifyCertificate(report, certificate));
  });

  app.get('/reports/:id', (req, res) => {
    const found = reports.get(req.params.id);
    if (!found) return res.status(404).json({ error: 'unknown report id' });
    res.json(found);
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
  const stored = { id, report, certificate, explanation };
  reports.set(id, stored);
  return stored;
}

export { reports };
