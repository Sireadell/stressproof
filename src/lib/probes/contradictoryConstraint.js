// contradictory_constraint — one request carrying two mutually exclusive
// values for the same thing. An honest agent rejects it.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.contradictory_constraint).
//
// WHY THIS PROBE AND NOT false_premise
// ------------------------------------
// The probe this replaced asked the target something it *should* have been
// unable to verify. Deciding what a stranger's agent cannot know needs domain
// knowledge a black-box tester does not have — so that probe was really
// testing our guess about someone else's data. A self-contradiction needs no
// domain knowledge at all: a request asking for at least 6 results and at
// most 5 is unanswerable on its face, in any domain, forever.
//
// HOW THE CONTRADICTION IS BUILT
// ------------------------------
// Preference order, and it matters:
//   1. The sample already has a min_X / max_X pair -> invert it. Nothing is
//      added, so a target that ignores unknown fields cannot be misread.
//   2. Only one half exists -> add the counterpart. This is recorded as
//      counterpartWasAdded: true, because a target that silently ignores
//      fields it does not know about is a WEAKER observation than one that
//      ignored a contradiction between two fields it already accepts. The
//      classifier needs to see the difference; it is not this file's to
//      decide.
//   3. Neither exists -> skipped. No inventing a contradiction out of a
//      schema we cannot see.
//
// Per the probe contract: this file only observes.

import { safeFetch } from '../safeFetch.js';
import { emptyObservation, cloneBody, editableKeys, requestOptions, enforceBudget } from '../probeContract.js';
import { REQUEST_BUDGET } from '../spec.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'contradictory_constraint';

const MIN_PREFIXES = ['min_', 'minimum_', 'min'];
const MAX_PREFIXES = ['max_', 'maximum_', 'max'];

function suffixAfter(key, prefixes) {
  const lower = key.toLowerCase();
  for (const p of prefixes) {
    if (!lower.startsWith(p) || lower.length <= p.length) continue;
    const rest = key.slice(p.length);
    // A bare 'min'/'max' prefix only counts when a camelCase boundary follows
    // (minResults, maxResults). Without this, 'minutes' would be read as a
    // minimum of 'utes' and the probe would invent a field called 'maxutes'.
    if (!p.endsWith('_') && !/^[A-Z]/.test(rest)) continue;
    return { prefix: key.slice(0, p.length), suffix: rest };
  }
  return null;
}

function isNumeric(v) {
  return typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

/**
 * Find the pair of keys to put in conflict. Deterministic: keys are walked in
 * editableKeys order so the same target gets the same contradiction every run.
 */
export function planContradiction(sampleBody) {
  const keys = editableKeys(sampleBody);
  const mins = new Map();
  const maxes = new Map();
  for (const k of keys) {
    if (!isNumeric(sampleBody[k])) continue;
    const asMin = suffixAfter(k, MIN_PREFIXES);
    if (asMin) { if (!mins.has(asMin.suffix.toLowerCase())) mins.set(asMin.suffix.toLowerCase(), k); continue; }
    const asMax = suffixAfter(k, MAX_PREFIXES);
    if (asMax && !maxes.has(asMax.suffix.toLowerCase())) maxes.set(asMax.suffix.toLowerCase(), k);
  }

  // 1. Both halves already present: the cleanest case, nothing invented.
  for (const [suffix, minKey] of mins) {
    if (maxes.has(suffix)) {
      const maxKey = maxes.get(suffix);
      return { minKey, maxKey, counterpartWasAdded: false, maxValue: Number(sampleBody[maxKey]) };
    }
  }

  // 2. Only a max_X exists: add the matching min_X above it.
  for (const [suffix, maxKey] of maxes) {
    if (mins.has(suffix)) continue;
    const found = suffixAfter(maxKey, MAX_PREFIXES);
    const prefix = found.prefix.toLowerCase().startsWith('max_') ? 'min_' : 'min';
    return {
      minKey: `${prefix}${found.suffix}`,
      maxKey,
      counterpartWasAdded: true,
      maxValue: Number(sampleBody[maxKey]),
    };
  }

  // 2b. Only a min_X exists: add the matching max_X below it.
  for (const [suffix, minKey] of mins) {
    if (maxes.has(suffix)) continue;
    const found = suffixAfter(minKey, MIN_PREFIXES);
    const prefix = found.prefix.toLowerCase().startsWith('min_') ? 'max_' : 'max';
    return {
      minKey,
      maxKey: `${prefix}${found.suffix}`,
      counterpartWasAdded: true,
      minValue: Number(sampleBody[minKey]),
    };
  }

  return null;
}

/**
 * @param {import('../probeContract.js').TargetDescriptor} target
 * @param {object} [opts]
 * @returns {Promise<import('../probeContract.js').ProbeObservation>}
 */
export async function contradictoryConstraint(target, opts = {}) {
  const budget = REQUEST_BUDGET.contradictory_constraint;
  const fetchImpl = opts.fetchImpl ?? safeFetch;

  const plan = planContradiction(target.sampleBody);
  if (!plan) {
    // No numeric range field to contradict. Skipping is the honest answer:
    // a made-up field would test whether the target ignores unknown keys,
    // which is a different question this probe does not claim to answer.
    return enforceBudget(emptyObservation(PROBE_NAME, 'no_contradictable_field'), budget);
  }

  const body = cloneBody(target.sampleBody);
  // Whichever half is known, the other is set to the impossible side of it,
  // by exactly one — a large gap would look like a typo, one step apart is
  // unambiguously a contradiction.
  let minValue;
  let maxValue;
  if (plan.minValue != null && Number.isFinite(plan.minValue)) {
    minValue = plan.minValue;
    maxValue = plan.minValue - 1;
  } else {
    maxValue = Number.isFinite(plan.maxValue) ? plan.maxValue : 5;
    minValue = maxValue + 1;
  }
  body[plan.minKey] = minValue;
  body[plan.maxKey] = maxValue;
  const serialized = JSON.stringify(body);

  const response = await fetchImpl(target.url, requestOptions(target, { body: serialized }));

  const observation = {
    ...emptyObservation(PROBE_NAME),
    requestsUsed: 1,
    responses: [response],
    findings: {
      minField: plan.minKey,
      maxField: plan.maxKey,
      minValue,
      maxValue,
      contradictionKind: 'min_greater_than_max',
      // See the header: an added counterpart is weaker evidence than two
      // fields the target already accepts.
      counterpartWasAdded: plan.counterpartWasAdded,
      ...analyzeResponse(response, serialized),
    },
  };

  return enforceBudget(observation, budget);
}

export default contradictoryConstraint;
