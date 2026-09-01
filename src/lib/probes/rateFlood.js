// rate_flood — fire REQUEST_BUDGET.rate_flood requests as fast as possible
// and record exactly where the target's behaviour changed, if it did.
//
// This probe never decides whether the change is good or bad (a target that
// starts returning 429s is arguably behaving *better*, not worse). It just
// pins down the index and the reason, because that timeline — "your agent
// started returning 500s at request 5 of 7" — is the evidence a buyer
// actually wants. The classifier turns this into an outcome.

import { safeFetch } from '../safeFetch.js';
import { requestOptions, emptyObservation, enforceBudget, cloneBody } from '../probeContract.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../spec.js';

const PROBE_NAME = 'rate_flood';

function statusClass(status) {
  if (status == null) return null;
  return Math.floor(status / 100);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Find the first index (0-based) where behaviour changed, per the frozen
 * definition: status class differs from request 0's class, OR latency
 * exceeds RATE_FLOOD_LATENCY_SPIKE_MULTIPLE times the median of the first
 * RATE_FLOOD_MEDIAN_SAMPLE requests. Returns null if nothing changed.
 */
function findChangePoint(timeline) {
  if (timeline.length === 0) return null;
  const baselineClass = statusClass(timeline[0].status);
  const sampleSize = Math.min(THRESHOLDS.RATE_FLOOD_MEDIAN_SAMPLE, timeline.length);
  const sampleLatencies = timeline.slice(0, sampleSize).map((r) => r.elapsedMs);
  const medianLatency = median(sampleLatencies);
  // A spike must clear BOTH the multiple and an absolute floor.
  //
  // The floor was added after this probe's own "behaves consistently" test
  // went red: against a fast target the median is about a millisecond, so a
  // completely ordinary 3ms response is "3x the median" and would be reported
  // as the moment the agent started to struggle. A multiple alone is
  // meaningless at small values.
  const latencyCeiling = Math.max(
    medianLatency * THRESHOLDS.RATE_FLOOD_LATENCY_SPIKE_MULTIPLE,
    THRESHOLDS.RATE_FLOOD_MIN_SPIKE_MS,
  );

  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i];
    const classChanged = statusClass(entry.status) !== baselineClass;
    // Only a genuine spike counts, and only once we have a real median to
    // compare against — checking the sample itself against its own median
    // would flag the sample requests spuriously.
    const latencySpiked = i >= sampleSize && medianLatency > 0 && entry.elapsedMs > latencyCeiling;

    if (classChanged || latencySpiked) {
      const reasons = [];
      if (classChanged) reasons.push('status_class_change');
      if (latencySpiked) reasons.push('latency_spike');
      return { index: i, reasons };
    }
  }
  return null;
}

/**
 * @param {import('../probeContract.js').TargetDescriptor} target
 * @param {object} [opts]
 * @returns {Promise<import('../probeContract.js').ProbeObservation>}
 */
export async function rateFlood(target, opts = {}) {
  const budget = REQUEST_BUDGET.rate_flood;
  const body = JSON.stringify(cloneBody(target.sampleBody));
  const options = requestOptions(target, { body, ...opts });

  // Fired one after another with no delay in between, never in parallel.
  // "The exact request index where behaviour changed" is only a meaningful,
  // reproducible fact if request order and arrival order are the same thing
  // — firing all 7 at once (like concurrent_burst does deliberately) would
  // let them race each other to the server and make the index noise instead
  // of evidence.
  const responses = [];
  for (let i = 0; i < budget; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- ordering is the point
    responses.push(await safeFetch(target.url, options));
  }

  const timeline = responses.map((r, i) => ({
    index: i,
    status: r.status,
    ok: r.ok,
    elapsedMs: r.elapsedMs,
    networkError: r.networkError,
  }));

  const changePoint = findChangePoint(timeline);

  // A 429 with Retry-After is graceful throttling; a 429 without one, or a
  // hard failure, is not. Recorded as a fact for the classifier, not judged
  // here.
  const rateLimitResponses = responses
    .map((r, i) => ({ index: i, r }))
    .filter(({ r }) => r.status === 429)
    .map(({ index, r }) => ({
      index,
      retryAfter: r.headers?.['retry-after'] ?? null,
    }));

  const observation = {
    ...emptyObservation(PROBE_NAME),
    requestsUsed: responses.length,
    responses,
    findings: {
      timeline,
      changePoint,
      rateLimitResponses,
      sawRateLimit: rateLimitResponses.length > 0,
    },
  };

  return enforceBudget(observation, budget);
}
