// differential_corruption — send the sample request with ONE critical field
// corrupted to nonsense. If the target answers 2xx with a response that is
// identical to its clean baseline once genuinely volatile fields are stripped,
// it demonstrably never looked at the field we corrupted.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.differential_corruption). The
// baseline pair is NOT sent by this probe — repeat_determinism already spent
// two requests on it, and re-sending them would blow the published 30-request
// cap. The pair arrives as `opts.baselineResponses`.
//
// VOLATILE FIELDS ARE LEARNED, NOT ASSUMED
// ----------------------------------------
// "Strip the documented volatile fields" is hand-waving when the schema is a
// stranger's. So: whatever differed between two IDENTICAL requests is by
// definition volatile — request ids, timestamps, model sampling. Those fields
// are learned from the baseline pair and stripped before comparison. This is
// measurable rather than assumed.
//
// AND IF THE TARGET IS TOO NOISY, IT SAYS SO
// ------------------------------------------
// With fewer than THRESHOLDS.MIN_STABLE_FIELDS_FOR_COMPARISON steady fields
// left after the volatile ones are stripped, a field comparison means nothing
// and the honest answer is "we could not tell". The probe records what it
// found and skips. It never guesses, and it never invents a baseline it was
// not given.
//
// Per the probe contract: this file only observes. Whether "identical to
// baseline" is a failure is the classifier's call, not this file's.

import { safeFetch } from '../safeFetch.js';
import { emptyObservation, cloneBody, editableKeys, requestOptions, enforceBudget } from '../probeContract.js';
import { REQUEST_BUDGET, THRESHOLDS } from '../spec.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'differential_corruption';

/** The nonsense a field is corrupted to. Fixed, not random: two runs against
 *  the same target must send the same bytes or the run is not reproducible. */
const CORRUPTION_STRING = 'zzqx-NOT-A-REAL-VALUE-9182734650-zzqx';
const CORRUPTION_NUMBER = -918273465;

/** Flatten a parsed body to leaf path -> JSON-encoded value, so two responses
 *  can be compared field by field at any nesting depth. Arrays are indexed by
 *  position, which is what makes "the third result changed" visible. */
function flatten(value, prefix = '', out = {}, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') {
    out[prefix || '$'] = JSON.stringify(value ?? null);
    return out;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.keys(value).sort().map((k) => [k, value[k]]);
  if (entries.length === 0) {
    out[prefix || '$'] = Array.isArray(value) ? '[]' : '{}';
    return out;
  }
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  return out;
}

function parseBody(response) {
  if (!response || typeof response.body !== 'string' || response.body.length === 0) return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

/**
 * Learn which fields legitimately change between two identical requests.
 * A field is volatile if the two baselines disagree on it, INCLUDING a field
 * present in one and absent from the other — an appearing/disappearing key is
 * every bit as unstable as a changing value.
 */
export function learnVolatileFields(bodyA, bodyB) {
  const a = flatten(bodyA);
  const b = flatten(bodyB);
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const volatileFields = paths.filter((p) => a[p] !== b[p]);
  return {
    fieldCount: paths.length,
    volatileFields,
    volatileFieldRatio: paths.length === 0 ? 1 : volatileFields.length / paths.length,
  };
}

/** Deterministically pick the field to corrupt: the first string-valued
 *  top-level key in editableKeys order, falling back to the first key of any
 *  type. A string field is preferred because it is the one carrying meaning —
 *  corrupting an incidental numeric knob would prove nothing when the answer
 *  legitimately does not depend on it. */
function pickCriticalField(sampleBody) {
  const keys = editableKeys(sampleBody);
  for (const key of keys) if (typeof sampleBody[key] === 'string') return key;
  return keys[0] ?? null;
}

function corrupt(value) {
  if (typeof value === 'number') return CORRUPTION_NUMBER;
  if (typeof value === 'string') return CORRUPTION_STRING;
  if (Array.isArray(value)) return [CORRUPTION_STRING];
  if (value && typeof value === 'object') return { corrupted: CORRUPTION_STRING };
  return CORRUPTION_STRING;
}

/**
 * @param {import('../probeContract.js').TargetDescriptor} target
 * @param {{ baselineResponses?: object[], fetchImpl?: Function }} [opts]
 *   baselineResponses is repeat_determinism's pair of safeFetch results.
 * @returns {Promise<import('../probeContract.js').ProbeObservation>}
 */
export async function differentialCorruption(target, opts = {}) {
  const budget = REQUEST_BUDGET.differential_corruption;
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const baselineResponses = opts.baselineResponses ?? null;

  // No baseline means no comparison. Never manufacture one — a baseline this
  // probe invented would be a comparison against our own assumption.
  if (!Array.isArray(baselineResponses) || baselineResponses.length < 2) {
    return enforceBudget(emptyObservation(PROBE_NAME, 'no_baseline_pair'), budget);
  }

  const bodyA = parseBody(baselineResponses[0]);
  const bodyB = parseBody(baselineResponses[1]);
  if (bodyA === null || bodyB === null) {
    // Field-level comparison needs parseable JSON on both sides. A non-JSON
    // target is not a failure, it is simply outside what this probe can see.
    return enforceBudget(emptyObservation(PROBE_NAME, 'baseline_not_json'), budget);
  }

  const { fieldCount, volatileFields, volatileFieldRatio } = learnVolatileFields(bodyA, bodyB);

  // Facts worth keeping even when the probe cannot go on: "we looked, and the
  // target changed half its response between two identical requests" is a
  // real finding, not an absence of one.
  // REVISION 3, corrected after this probe was built and tested.
  // The gate is how many stable fields REMAIN, not what fraction is volatile.
  // A four-field response carrying a request id and a timestamp is 50%
  // volatile and still perfectly comparable on its other two fields; the
  // original ratio rule skipped it, and would have skipped a large share of
  // real targets with it, quietly dragging whole runs toward INCONCLUSIVE.
  // What actually stops a comparison is having nothing left to compare.
  const stableFieldCount = fieldCount - volatileFields.length;

  const learningFindings = {
    baselineFieldCount: fieldCount,
    volatileFields,
    volatileFieldRatio,
    stableFieldCount,
    minStableFieldsRequired: THRESHOLDS.MIN_STABLE_FIELDS_FOR_COMPARISON,
  };

  if (stableFieldCount < THRESHOLDS.MIN_STABLE_FIELDS_FOR_COMPARISON) {
    // Nothing steady enough left to compare against. Spend no request: the
    // result could not have been interpreted either way.
    return enforceBudget(
      { ...emptyObservation(PROBE_NAME, 'baseline_too_noisy'), findings: learningFindings },
      budget,
    );
  }

  const fieldCorrupted = pickCriticalField(target.sampleBody);
  if (fieldCorrupted == null) {
    return enforceBudget(
      { ...emptyObservation(PROBE_NAME, 'no_corruptible_field'), findings: learningFindings },
      budget,
    );
  }

  const body = cloneBody(target.sampleBody);
  const corruptedValue = corrupt(body[fieldCorrupted]);
  body[fieldCorrupted] = corruptedValue;
  const serialized = JSON.stringify(body);

  const response = await fetchImpl(target.url, requestOptions(target, { body: serialized }));
  const corruptedBody = parseBody(response);

  // Compare against the first baseline with the learned volatile fields
  // removed from both sides.
  const stable = (flat) => {
    const copy = { ...flat };
    for (const p of volatileFields) delete copy[p];
    return copy;
  };
  const baselineStable = stable(flatten(bodyA));
  const corruptedStable = corruptedBody === null ? null : stable(flatten(corruptedBody));

  const comparedFields = Object.keys(baselineStable);
  const differingFields = corruptedStable === null
    ? null
    : [...new Set([...comparedFields, ...Object.keys(corruptedStable)])]
      .filter((p) => baselineStable[p] !== corruptedStable[p])
      .sort();

  const observation = {
    ...emptyObservation(PROBE_NAME),
    requestsUsed: 1,
    responses: [response],
    findings: {
      ...learningFindings,
      fieldCorrupted,
      corruptedValue,
      comparedFieldCount: comparedFields.length,
      differingFields,
      // The headline fact: with everything that legitimately varies removed,
      // did corrupting a critical field change the answer at all?
      identicalAfterStrippingVolatile: differingFields !== null && differingFields.length === 0,
      // Kept separately because a target whose response never varies at all
      // is a different observation from one stripped down to a match.
      rawBodyIdenticalToBaseline: response.body === baselineResponses[0].body,
      ...analyzeResponse(response, serialized),
    },
  };

  return enforceBudget(observation, budget);
}

export default differentialCorruption;
