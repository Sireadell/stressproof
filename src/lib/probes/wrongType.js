// wrong_type — flip ONE field's type (string <-> number <-> array) and send
// the rest of the sample body unchanged.
//
// Like missing_required_field, the field chosen must be stable across runs
// against the same target — editableKeys() gives a deterministic, sorted
// order to pick from, so "the first flippable field" is the same field every
// time. Not every field is flippable in a meaningful way: booleans, null and
// nested objects do not fit the string/number/array cycle this probe is
// scoped to, so they are skipped over when choosing which field to mutate.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.wrong_type).
//
// Per the probe contract: this file only observes. It never decides whether
// the target's response was acceptable.

import { emptyObservation, cloneBody, editableKeys, requestOptions, enforceBudget } from '../probeContract.js';
import { safeFetch } from '../safeFetch.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'wrong_type';
const BUDGET = 1;

function typeOfValue(value) {
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

/** Deterministically pick the first key (in editableKeys order) whose value
 * is a string, number or array — the three types this probe cycles between. */
function pickFlippableField(sampleBody) {
  for (const key of editableKeys(sampleBody)) {
    const t = typeOfValue(sampleBody[key]);
    if (t === 'string' || t === 'number' || t === 'array') return key;
  }
  return null;
}

/** string -> number -> array -> string, a full cycle through the three types
 * this probe is scoped to (per the task: "string, number, or array"). */
function flip(value) {
  const t = typeOfValue(value);
  if (t === 'string') {
    const n = Number(value);
    return { newValue: Number.isNaN(n) ? 42 : n, newType: 'number' };
  }
  if (t === 'number') {
    return { newValue: [value], newType: 'array' };
  }
  // array
  return { newValue: value.join(','), newType: 'string' };
}

export async function wrongType(target, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const fieldFlipped = pickFlippableField(target.sampleBody);

  if (!fieldFlipped) {
    // Nothing in the sample body is a string, number or array. Never invent
    // a mutation that does not actually exercise the intended type flip.
    return enforceBudget(emptyObservation(PROBE_NAME, 'no_flippable_field'), BUDGET);
  }

  const body = cloneBody(target.sampleBody);
  const originalType = typeOfValue(body[fieldFlipped]);
  const { newValue, newType } = flip(body[fieldFlipped]);
  body[fieldFlipped] = newValue;
  const serialized = JSON.stringify(body);

  const response = await fetchImpl(target.url, requestOptions(target, { body: serialized }));

  const observation = {
    probe: PROBE_NAME,
    requestsUsed: 1,
    responses: [response],
    findings: {
      fieldFlipped,
      originalType,
      newType,
      ...analyzeResponse(response, serialized),
    },
    skipped: null,
  };

  return enforceBudget(observation, BUDGET);
}

export default wrongType;
