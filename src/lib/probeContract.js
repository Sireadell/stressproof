// THE PROBE CONTRACT — the one shape every probe must fit.
//
// Every probe is a pure-ish function: it takes a target descriptor and a
// request budget, makes its own requests through safeFetch, and returns an
// observation. It never decides a verdict and it never scores anything. The
// classifier (Day 7) turns observations into outcomes; probes only observe.
//
// That separation is what keeps the scoring deterministic. If a probe could
// both gather evidence and judge it, the judgment would drift into the probe
// files one plausible special case at a time, and "no model touches the
// verdict" would quietly stop being true.

/**
 * @typedef {Object} TargetDescriptor
 * @property {string} url            Target endpoint (https in production).
 * @property {string} method         HTTP method, usually POST.
 * @property {object} sampleBody     A known-good request body the target accepts.
 * @property {object} [authHeaders]  Optional auth headers.
 * @property {boolean} [allowPrivateAddresses] Test-only; routes never set it.
 */

/**
 * @typedef {Object} ProbeObservation
 * @property {string} probe          Probe name, matching spec.js PROBE_ORDER.
 * @property {number} requestsUsed   Actual requests made. Must never exceed budget.
 * @property {object[]} responses    Raw safeFetch results, in order.
 * @property {object} findings       Probe-specific observed facts (no judgments).
 * @property {string|null} skipped   Reason if the probe could not run at all.
 */

/**
 * Build an empty observation, so every probe reports the same shape even when
 * it does nothing.
 */
export function emptyObservation(probe, skipped = null) {
  return { probe, requestsUsed: 0, responses: [], findings: {}, skipped };
}

/**
 * Wrap a probe so its request budget is enforced from the outside.
 *
 * A probe that miscounts its own requests would break the published 30-request
 * cap, which is an abuse limit and not merely a budget. Enforcing it here means
 * no individual probe has to be trusted to get it right.
 */
export function enforceBudget(observation, allowed) {
  if (observation.requestsUsed > allowed) {
    throw new Error(
      `probe '${observation.probe}' used ${observation.requestsUsed} requests but was allotted ${allowed}. ` +
        'The 30-request cap is published and enforced; a probe may not exceed its share.',
    );
  }
  return observation;
}

/**
 * Deep-clone a sample body so a probe's mutation cannot leak into the next
 * probe's copy. Every probe mutates the sample; none may corrupt the original.
 */
export function cloneBody(body) {
  return structuredClone(body);
}

/**
 * List the top-level keys a probe may edit, in a stable order.
 * Stable ordering matters: two runs against the same target must pick the same
 * field, or the run is not reproducible.
 */
export function editableKeys(sampleBody) {
  if (!sampleBody || typeof sampleBody !== 'object' || Array.isArray(sampleBody)) return [];
  return Object.keys(sampleBody).sort();
}

/**
 * Build the request options a probe passes to safeFetch, with auth and content
 * type applied consistently.
 */
export function requestOptions(target, { body, headers = {}, ...rest } = {}) {
  return {
    method: target.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(target.authHeaders ?? {}),
      ...headers,
    },
    body,
    allowPrivateAddresses: target.allowPrivateAddresses ?? false,
    ...rest,
  };
}
