// missing_required_field — delete ONE top-level key from the sample body and
// send the rest as-is.
//
// The field removed must be the SAME field on every run against the same
// target, or the run stops being reproducible — two runs could see two
// different failure shapes purely by chance and report different verdicts
// for no real reason. editableKeys() from probeContract.js sorts the sample
// body's keys, so "the first editable key" is a stable, deterministic pick.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.missing_required_field).
//
// Per the probe contract: this file only observes. It never decides whether
// the target's response was acceptable.

import { emptyObservation, cloneBody, editableKeys, requestOptions, enforceBudget } from '../probeContract.js';
import { safeFetch } from '../safeFetch.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'missing_required_field';
const BUDGET = 1;

export async function missingRequiredField(target, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const keys = editableKeys(target.sampleBody);

  if (keys.length === 0) {
    // Nothing to delete. Never invent a mutation that was not actually made.
    return enforceBudget(emptyObservation(PROBE_NAME, 'sample_body_has_no_keys'), BUDGET);
  }

  const fieldRemoved = keys[0];
  const body = cloneBody(target.sampleBody);
  delete body[fieldRemoved];
  const serialized = JSON.stringify(body);

  const response = await fetchImpl(target.url, requestOptions(target, { body: serialized }));

  const observation = {
    probe: PROBE_NAME,
    requestsUsed: 1,
    responses: [response],
    findings: {
      fieldRemoved,
      ...analyzeResponse(response, serialized),
    },
    skipped: null,
  };

  return enforceBudget(observation, BUDGET);
}

export default missingRequiredField;
