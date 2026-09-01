// oversize_payload — send a body of exactly THRESHOLDS.OVERSIZE_PAYLOAD_BYTES
// (1 MB, spec.js), and nothing more.
//
// 1 MB, not some larger round number: a metered target pays real money for
// whatever we send it, and 1 MB is already far past any sane request-size
// limit. This probe pads the known-good sample body up to exactly that byte
// count rather than sending an unbounded amount, so the cost to the target is
// capped and known in advance — see THRESHOLDS.OVERSIZE_PAYLOAD_BYTES in
// spec.js for why 1 MB specifically was chosen over 5 MB.
//
// Budget: 1 request (spec.js REQUEST_BUDGET.oversize_payload).
//
// Per the probe contract: this file only observes. It never decides whether
// the target's response was acceptable.

import { emptyObservation, cloneBody, requestOptions, enforceBudget } from '../probeContract.js';
import { safeFetch } from '../safeFetch.js';
import { THRESHOLDS } from '../spec.js';
import { analyzeResponse } from './probeObserve.js';

export const PROBE_NAME = 'oversize_payload';
const BUDGET = 1;
const PADDING_KEY = '_stressproof_padding';

/**
 * Build a serialized body that is exactly `targetBytes` long, by padding the
 * sample body with an ASCII filler field. ASCII is deliberate: every added
 * character costs exactly one byte in JSON, so the target size lands exactly
 * rather than approximately.
 */
function padToExactSize(sampleBody, targetBytes) {
  const body = cloneBody(sampleBody);
  body[PADDING_KEY] = '';
  const baseBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const padLength = Math.max(0, targetBytes - baseBytes);
  body[PADDING_KEY] = 'x'.repeat(padLength);
  return JSON.stringify(body);
}

export async function oversizePayload(target, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? safeFetch;
  const targetBytes = THRESHOLDS.OVERSIZE_PAYLOAD_BYTES;
  const serialized = padToExactSize(target.sampleBody, targetBytes);
  const actualBytes = Buffer.byteLength(serialized, 'utf8');

  if (actualBytes < targetBytes) {
    // The sample body itself (with an empty padding field) was already
    // larger than the target size, so no amount of padding could shrink it
    // down to exactly 1 MB. This should not happen with any realistic sample
    // body, but never silently send a size other than the one asked for.
    return enforceBudget(emptyObservation(PROBE_NAME, 'sample_body_already_exceeds_oversize_threshold'), BUDGET);
  }

  const response = await fetchImpl(target.url, requestOptions(target, { body: serialized }));

  const observation = {
    probe: PROBE_NAME,
    requestsUsed: 1,
    responses: [response],
    findings: {
      sentBytes: actualBytes,
      targetBytes,
      // A short, distinctive marker (not the full megabyte) is enough to
      // tell whether the target echoed our padding back.
      ...analyzeResponse(response, PADDING_KEY),
    },
    skipped: null,
  };

  return enforceBudget(observation, BUDGET);
}

export default oversizePayload;
