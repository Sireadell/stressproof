// THE RUN — twelve probes, in order, inside one published budget.
//
// This is the only place that knows how a whole certification fits together.
// It enforces three things no individual probe can enforce for itself:
//
//   1. The total request cap. Each probe polices its own share, but only this
//      file can see the sum, and the 30-request ceiling is an abuse limit
//      before it is a budget.
//
//   2. Probe order and the one real dependency between probes:
//      repeat_determinism must run first, because differential_corruption
//      learns which response fields are volatile from its baseline pair.
//
//   3. That one probe failing never takes the run down with it. A probe that
//      throws is recorded as unmeasured and the run continues — a single
//      unlucky request must not destroy eleven good observations.

import { PROBE_ORDER, REQUEST_BUDGET, MAX_REQUESTS_PER_RUN, SPEC_VERSION } from './spec.js';
import { scoreRun } from './scoring.js';
import { emptyObservation } from './probeContract.js';

import { repeatDeterminism } from './probes/repeatDeterminism.js';
import { malformedJson } from './probes/malformedJson.js';
import { missingRequiredField } from './probes/missingRequiredField.js';
import { wrongType } from './probes/wrongType.js';
import { oversizePayload } from './probes/oversizePayload.js';
import { contradictoryConstraint } from './probes/contradictoryConstraint.js';
import { differentialCorruption } from './probes/differentialCorruption.js';
import { injectionCanary } from './probes/injectionCanary.js';
import { authAbsent } from './probes/authAbsent.js';
import { slowClient } from './probes/slowClient.js';
import { concurrentBurst } from './probes/concurrentBurst.js';
import { rateFlood } from './probes/rateFlood.js';

const PROBE_FNS = {
  repeat_determinism: repeatDeterminism,
  malformed_json: malformedJson,
  missing_required_field: missingRequiredField,
  wrong_type: wrongType,
  oversize_payload: oversizePayload,
  contradictory_constraint: contradictoryConstraint,
  differential_corruption: differentialCorruption,
  injection_canary: injectionCanary,
  auth_absent: authAbsent,
  slow_client: slowClient,
  concurrent_burst: concurrentBurst,
  rate_flood: rateFlood,
};

/**
 * Run a full certification.
 *
 * @param {import('./probeContract.js').TargetDescriptor} target
 * @param {{ probeOpts?: object, onProgress?: Function }} [opts]
 * @returns {Promise<{ target, startedAt, finishedAt, requestsUsed, observations, ...scoring }>}
 */
export async function runCertification(target, opts = {}) {
  const startedAt = Date.now();
  const observations = [];
  let requestsUsed = 0;
  let baselineResponses = null;

  for (const probeName of PROBE_ORDER) {
    const fn = PROBE_FNS[probeName];
    const budget = REQUEST_BUDGET[probeName];

    // Never start a probe that could take the run past its published ceiling.
    if (requestsUsed + budget > MAX_REQUESTS_PER_RUN) {
      observations.push(emptyObservation(probeName, 'budget_exhausted'));
      continue;
    }

    let observation;
    try {
      observation = await fn(target, {
        ...(opts.probeOpts ?? {}),
        // differential_corruption is the one probe that depends on another's
        // output. Passing it explicitly keeps the dependency visible here
        // rather than hidden inside a probe reaching for shared state.
        ...(probeName === 'differential_corruption' ? { baselineResponses } : {}),
      });
    } catch (err) {
      // A probe that throws is a bug in that probe, not a finding about the
      // target. Record it honestly as unmeasured and keep going: one bad
      // probe must not discard eleven good observations.
      observation = {
        ...emptyObservation(probeName, `probe_error: ${err.message}`),
        findings: { probeThrew: true, error: err.message },
      };
    }

    observations.push(observation);
    requestsUsed += observation.requestsUsed ?? 0;

    if (probeName === 'repeat_determinism' && observation.responses?.length >= 2) {
      baselineResponses = observation.responses;
    }

    opts.onProgress?.({ probe: probeName, observation, requestsUsed });
  }

  const scored = scoreRun(observations);
  const finishedAt = Date.now();

  return {
    target: target.url,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    requestsUsed,
    maxRequests: MAX_REQUESTS_PER_RUN,
    ...scored,
    observations,
  };
}

/**
 * Strip a run down to what belongs in a published report.
 *
 * Raw response bodies are deliberately left out: they can be large, and they
 * can contain whatever the target chose to send back, including content we
 * should not be republishing on its behalf. The findings and outcomes carry
 * the evidence; the bodies were only ever the means of getting it.
 */
/**
 * The probe counts, in a sentence, so nobody has to infer what they mean.
 *
 * The distinction that keeps getting lost: a probe that ran but could not
 * reach a firm conclusion is neither a pass nor a failure. Counting it as
 * either would be the exact dishonesty this product exists to measure.
 */
function summariseProbeCounts(run) {
  const total = run.breakdown?.length ?? 0;
  const parts = [`All ${total} probes ran.`];
  const families = run.completedFamilies ?? [];
  parts.push(
    families.length > 0
      ? `${run.probesCompleted} reached a conclusion firm enough to score, covering ${families.length} different kinds of failure (${families.join(', ')}).`
      : `${run.probesCompleted} reached a conclusion firm enough to score.`,
  );
  if (run.unclassifiedCount > 0) {
    parts.push(
      `${run.unclassifiedCount} could not be judged from outside the API and are reported as unclear, not as failures.`,
    );
  }
  if (run.notApplicable > 0) {
    parts.push(`${run.notApplicable} did not apply to this target.`);
  }
  return parts.join(' ');
}

export function toReport(run) {
  return {
    target: run.target,
    // Which test produced this. Without it two reports look comparable whether
    // or not the same probes and thresholds produced them, and anyone holding
    // an old report next to a new one could read a change in the TEST as a
    // change in the agent. Derived from the spec's own numbers, so it cannot go
    // stale when a threshold moves.
    specVersion: SPEC_VERSION,
    verdict: run.verdict,
    verdictReason: run.verdictReason,
    score: run.score,
    probesCompleted: run.probesCompleted,
    probesScorable: run.probesScorable,
    completedFamilies: run.completedFamilies,
    // Said in words because the numbers alone are read wrongly. Seeing
    // "6 of 12" next to a verdict, a reader concludes half the test failed to
    // run. Every probe runs; what varies is how many of them reach a
    // conclusion firm enough to score, and an unclear result is deliberately
    // not counted as a failure.
    probesRunSummary: summariseProbeCounts(run),
    silentWrongCount: run.silentWrongCount,
    unclassifiedCount: run.unclassifiedCount,
    notApplicable: run.notApplicable,
    requestsUsed: run.requestsUsed,
    maxRequests: run.maxRequests,
    durationMs: run.durationMs,
    probes: run.breakdown.map((b) => {
      const observation = run.observations.find((o) => o.probe === b.probe);
      return {
        probe: b.probe,
        outcome: b.outcome,
        reason: b.reason,
        points: b.points,
        requestsUsed: observation?.requestsUsed ?? 0,
        findings: observation?.findings ?? {},
        skipped: observation?.skipped ?? null,
      };
    }),
  };
}
