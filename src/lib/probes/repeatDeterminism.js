// repeat_determinism — send the same valid request twice.
//
// INSTRUMENTATION ONLY. This probe is deliberately excluded from SCORED_PROBES
// in spec.js and can never cost a target a single point.
//
// The reason matters. Language-model agents are legitimately non-deterministic:
// the same question can produce two differently worded, equally correct
// answers. Scoring that as a failure would penalise normal, correct behaviour
// and would quietly punish every agent built on a model rather than a lookup
// table. So this probe exists for two other purposes:
//
//   1. It produces the baseline pair differential_corruption needs in order to
//      learn which response fields are volatile (ids, timestamps) and must be
//      stripped before any comparison. Without this, that probe has nothing to
//      measure against and skips.
//
//   2. It records whether the SET OF FIELDS changed between two identical
//      requests — not whether the values changed. A target that returns
//      different *shapes* for the same input is a real observation worth
//      reporting, and it is a different thing from ordinary model variation.
//
// Per the probe contract: observe only. Nothing here decides an outcome.

import { safeFetch } from '../safeFetch.js';
import { requestOptions, emptyObservation, enforceBudget, cloneBody } from '../probeContract.js';
import { REQUEST_BUDGET } from '../spec.js';
import { analyzeResponse } from './probeObserve.js';

const PROBE_NAME = 'repeat_determinism';

/** Top-level field names of a parsed body, sorted for stable comparison. */
function fieldNames(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.keys(parsed).sort();
  } catch {
    return null;
  }
}

export async function repeatDeterminism(target, opts = {}) {
  const budget = REQUEST_BUDGET.repeat_determinism;
  const fetchImpl = opts.fetchImpl ?? safeFetch;

  if (!target?.sampleBody || typeof target.sampleBody !== 'object') {
    return enforceBudget(emptyObservation(PROBE_NAME, 'no_sample_body'), budget);
  }

  const body = JSON.stringify(cloneBody(target.sampleBody));
  const responses = [];

  // Sequential, not parallel. Two simultaneous requests can be served by
  // different instances behind a load balancer, which would make "the shape
  // changed" a fact about their deployment rather than about the agent.
  for (let i = 0; i < budget; i += 1) {
    responses.push(await fetchImpl(target.url, requestOptions(target, { body })));
  }

  const [first, second] = responses;
  const fieldsA = fieldNames(first?.body ?? '');
  const fieldsB = fieldNames(second?.body ?? '');

  const bothJson = fieldsA !== null && fieldsB !== null;
  const fieldSetChanged = bothJson ? JSON.stringify(fieldsA) !== JSON.stringify(fieldsB) : null;

  return enforceBudget(
    {
      probe: PROBE_NAME,
      requestsUsed: responses.length,
      responses,
      findings: {
        scored: false, // stated in the data, not only in a comment
        statuses: responses.map((r) => r.status),
        bothParsedAsJson: bothJson,
        fieldSetChanged,
        fieldsFirst: fieldsA,
        fieldsSecond: fieldsB,
        // Recorded but explicitly NOT judged: two identical bodies and two
        // different bodies are both perfectly normal for a model-backed agent.
        bodiesIdentical: first?.body === second?.body,
        analyses: responses.map((r) => analyzeResponse(r)),
      },
      skipped: null,
    },
    budget,
  );
}
