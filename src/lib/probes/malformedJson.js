// malformed_json — send the known-good sample body truncated mid-structure.
//
// This is the cheapest possible test of input handling: does the target even
// check that what arrived is valid JSON before doing anything with it? A
// dropped connection, a flaky proxy or a client bug all produce exactly this
// shape (a request that started out fine and got cut off), so it is a
// realistic failure to probe for, not a contrived one.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.malformed_json). This probe
// makes exactly one request, or none at all if it has to skip.
//
// Per the probe contract (probeContract.js): this file only observes. It
// never decides whether the target's response was acceptable — that is the
// classifier's job, working from the facts recorded in `findings`.

import { emptyObservation, cloneBody, requestOptions, enforceBudget } from '../probeContract.js';
import { safeFetch } from '../safeFetch.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'malformed_json';
const BUDGET = 1;

export async function malformedJson(target, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const body = cloneBody(target.sampleBody);
  const fullJson = JSON.stringify(body);

  // Drop the final character. For any object or array (the only shapes a
  // sample body can legally be, per the TargetDescriptor contract) this
  // removes the closing brace/bracket — an unclosed structure, exactly the
  // "truncated mid-structure" failure this probe exists to send.
  const truncated = fullJson.slice(0, -1);

  if (!truncated) {
    // A sample body that serialises to '' or a single character has nothing
    // left to truncate into something meaningfully malformed. Never invent a
    // result — report that the probe could not run.
    return enforceBudget(emptyObservation(PROBE_NAME, 'sample_body_too_small_to_truncate'), BUDGET);
  }

  const response = await fetchImpl(target.url, requestOptions(target, { body: truncated }));

  const observation = {
    probe: PROBE_NAME,
    requestsUsed: 1,
    responses: [response],
    findings: {
      sentBytes: Buffer.byteLength(truncated, 'utf8'),
      ...analyzeResponse(response, truncated),
    },
    skipped: null,
  };

  return enforceBudget(observation, BUDGET);
}

export default malformedJson;
