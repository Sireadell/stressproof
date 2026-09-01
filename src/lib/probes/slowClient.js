// slow_client — send headers, then dribble the request body out slowly, to
// see whether the target holds the connection open past a sane limit.
//
// Budget: 1 request. Uses safeFetch's bodyWriter option, which exists for
// exactly this: it hands us the raw request object so we control the timing
// of what gets written, instead of safeFetch writing the whole body at once.
//
// Durations are injectable (defaulting to the frozen spec values) purely so
// tests do not have to burn 20-60 real seconds per run. Production code paths
// never override them, so the shipped behaviour still matches spec.js.

import { safeFetch } from '../safeFetch.js';
import { requestOptions, emptyObservation, enforceBudget, cloneBody } from '../probeContract.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../spec.js';

const PROBE_NAME = 'slow_client';

/**
 * Write `body` onto `req` in small chunks spread over `dripMs`, ending the
 * request either when the body is exhausted or `cutoffMs` is reached —
 * whichever comes first.
 */
function makeBodyWriter(body, { dripMs, cutoffMs }) {
  return (req) => {
    const chunks = body.match(/.{1,16}/gs) ?? [body];
    const chunkIntervalMs = Math.max(1, Math.floor(dripMs / Math.max(1, chunks.length)));
    let i = 0;
    let cutoffHit = false;

    const cutoffTimer = setTimeout(() => {
      cutoffHit = true;
      req.destroy();
    }, cutoffMs);
    cutoffTimer.unref();

    const writeNext = () => {
      if (cutoffHit) return;
      if (i >= chunks.length) {
        clearTimeout(cutoffTimer);
        req.end();
        return;
      }
      req.write(chunks[i]);
      i += 1;
      const t = setTimeout(writeNext, chunkIntervalMs);
      t.unref();
    };
    writeNext();
  };
}

/**
 * @param {import('../probeContract.js').TargetDescriptor} target
 * @param {object} [opts]
 * @param {number} [opts.dripMs] override for THRESHOLDS.SLOW_CLIENT_DRIP_MS (tests only)
 * @param {number} [opts.cutoffMs] override for THRESHOLDS.SLOW_CLIENT_CUTOFF_MS (tests only)
 * @returns {Promise<import('../probeContract.js').ProbeObservation>}
 */
export async function slowClient(target, opts = {}) {
  const budget = REQUEST_BUDGET.slow_client;
  const { dripMs = THRESHOLDS.SLOW_CLIENT_DRIP_MS, cutoffMs = THRESHOLDS.SLOW_CLIENT_CUTOFF_MS, ...rest } = opts;

  const body = JSON.stringify(cloneBody(target.sampleBody));
  const bodyWriter = makeBodyWriter(body, { dripMs, cutoffMs });

  // Give safeFetch's own socket timeout enough headroom to see the whole
  // drip/cutoff dance play out, rather than cutting it off itself.
  const timeoutMs = cutoffMs + 5000;

  // No `body` is passed here — bodyWriter is what controls what gets
  // written and when. safeFetch only falls back to writing `body` directly
  // when bodyWriter is absent, so leaving body out is what keeps the drip
  // in control instead of the whole body going out at once.
  const options = requestOptions(target, { headers: {}, bodyWriter, timeoutMs, ...rest });

  const response = await safeFetch(target.url, options);

  let behavior;
  if (response.networkError === 'ETIMEDOUT' || response.elapsedMs >= cutoffMs) {
    behavior = 'held_past_cutoff';
  } else if (!response.ok && response.networkError) {
    behavior = 'connection_closed';
  } else if (response.ok) {
    behavior = 'responded';
  } else {
    behavior = 'unknown';
  }

  const observation = {
    ...emptyObservation(PROBE_NAME),
    requestsUsed: 1,
    responses: [response],
    findings: {
      behavior,
      elapsedMs: response.elapsedMs,
      status: response.status,
      networkError: response.networkError,
      dripMs,
      cutoffMs,
    },
  };

  return enforceBudget(observation, budget);
}
