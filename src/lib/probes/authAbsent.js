// auth_absent — call the target with its credentials deliberately removed.
//
// The question is not "is this endpoint protected?" — plenty of agents are
// meant to be open, and an open endpoint is a design choice, not a defect.
// The question is whether the target behaves COHERENTLY when credentials are
// missing: a clean 401/403 is honest, a 500 is an honest crash, and quietly
// serving the request anyway while claiming to require auth is the dishonest
// case this whole product exists to surface.
//
// THE N/A CASE
// ------------
// If the run was configured without any auth headers, there is nothing to
// remove, and "it answered without credentials" proves nothing at all. This
// probe then reports itself as not-applicable and DROPS OUT OF THE
// DENOMINATOR entirely, rather than being counted as a pass or a failure.
// Scoring an open endpoint either way would be inventing an opinion about a
// design decision we were never asked about.
//
// Per the probe contract: observe only.

import { safeFetch } from '../safeFetch.js';
import { emptyObservation, enforceBudget, cloneBody } from '../probeContract.js';
import { REQUEST_BUDGET } from '../spec.js';
import { analyzeResponse } from './probeObserve.js';

const PROBE_NAME = 'auth_absent';

export async function authAbsent(target, opts = {}) {
  const budget = REQUEST_BUDGET.auth_absent;
  const fetchImpl = opts.fetchImpl ?? safeFetch;

  const authHeaders = target?.authHeaders ?? null;
  const hasAuth = authHeaders && Object.keys(authHeaders).length > 0;

  if (!hasAuth) {
    // Not applicable, and deliberately distinguished from "skipped because
    // something went wrong". The classifier removes this from the denominator.
    return enforceBudget(
      {
        ...emptyObservation(PROBE_NAME, 'not_applicable_no_auth_configured'),
        findings: { notApplicable: true, reason: 'the run was configured without credentials, so none could be withheld' },
      },
      budget,
    );
  }

  const body = JSON.stringify(cloneBody(target.sampleBody));

  // Note the deliberate absence of target.authHeaders here — this is the one
  // place in the codebase that must NOT use requestOptions(), because that
  // helper's whole job is to apply auth consistently.
  const response = await fetchImpl(target.url, {
    method: target.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    allowPrivateAddresses: target.allowPrivateAddresses ?? false,
  });

  const analysis = analyzeResponse(response);
  const status = response.status;

  return enforceBudget(
    {
      probe: PROBE_NAME,
      requestsUsed: 1,
      responses: [response],
      findings: {
        notApplicable: false,
        withheldHeaderNames: Object.keys(authHeaders),
        status,
        // Named facts, not verdicts. The classifier maps these to outcomes.
        refusedCleanly: status === 401 || status === 403,
        servedAnyway: typeof status === 'number' && status >= 200 && status < 300,
        serverError: typeof status === 'number' && status >= 500,
        ...analysis,
      },
      skipped: null,
    },
    budget,
  );
}
