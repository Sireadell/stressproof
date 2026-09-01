// concurrent_burst — fire THRESHOLDS.CONCURRENT_BURST_SIZE requests
// genuinely simultaneously (Promise.all over independent safeFetch calls,
// none awaited before the next is started) and record how the target coped.
//
// Scored ONLY on 5xx status and dropped/network-error connections. Latency
// under concurrency is recorded as information but MUST NOT be judged by the
// classifier: it is a function of network jitter and machine load at the
// moment of the run, not of the target's behaviour, and would not reproduce
// running the same probe again from a different machine.

import { safeFetch } from '../safeFetch.js';
import { requestOptions, emptyObservation, enforceBudget, cloneBody } from '../probeContract.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../spec.js';

const PROBE_NAME = 'concurrent_burst';

/**
 * @param {import('../probeContract.js').TargetDescriptor} target
 * @param {object} [opts]
 * @returns {Promise<import('../probeContract.js').ProbeObservation>}
 */
export async function concurrentBurst(target, opts = {}) {
  const budget = REQUEST_BUDGET.concurrent_burst;
  const size = THRESHOLDS.CONCURRENT_BURST_SIZE;
  const body = JSON.stringify(cloneBody(target.sampleBody));
  const options = requestOptions(target, { body, ...opts });

  // All requests are started in this synchronous loop before any is
  // awaited — that is what makes this "simultaneous" rather than a fast
  // sequential loop that merely looks parallel from the outside.
  const responses = await Promise.all(
    Array.from({ length: size }, () => safeFetch(target.url, options)),
  );

  const serverErrorCount = responses.filter((r) => r.status != null && r.status >= 500 && r.status < 600).length;
  const networkErrorCount = responses.filter((r) => r.networkError != null).length;
  const successCount = responses.filter((r) => r.ok && r.status != null && r.status < 500).length;

  // Informational only — see the file-level comment. Not an input to any
  // pass/fail decision.
  const latenciesMs = responses.map((r) => r.elapsedMs);

  const observation = {
    ...emptyObservation(PROBE_NAME),
    requestsUsed: responses.length,
    responses,
    findings: {
      serverErrorCount,
      networkErrorCount,
      successCount,
      // NOT to be judged by the classifier — network-jitter dependent, kept
      // for human/debug context only.
      latenciesMs,
    },
  };

  return enforceBudget(observation, budget);
}
