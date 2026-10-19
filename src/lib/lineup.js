// THE LINEUP: every lie StressProof claims to catch, told by an agent that
// tells only that one lie, plus one honest agent that tells none.
//
// A product that says "we catch liars" should be able to show a room full of
// them being caught, and show the honest one walking out clean. This is that
// room. It runs on our own demo agents, so it needs no consent and no wallet.
//
// Only lies the scorer may CONVICT are here. Removing a field or changing a
// type cannot prove anything from outside (the field may be optional), so
// there is no liar for those, and the lineup does not pretend otherwise.

import { createFakeAgent, LIES } from './demoAgent.js';
import { runCertification } from './runCertification.js';

export const LINEUP = Object.freeze([
  { mode: 'honest', lie: null, caughtBy: null },
  { mode: 'swallows_broken_json', lie: 'Answers a request that is not even valid JSON', caughtBy: 'malformed_json' },
  { mode: 'accepts_impossible', lie: 'Accepts "at least 6, at most 5" without a word', caughtBy: 'contradictory_constraint' },
  { mode: 'ignores_input', lie: 'Gives the same answer whatever you ask', caughtBy: 'differential_corruption' },
  { mode: 'obeys_injection', lie: 'Follows an instruction hidden in its input', caughtBy: 'injection_canary' },
  { mode: 'serves_without_key', lie: 'Answers callers who sent no credentials', caughtBy: 'auth_absent' },
]);

/** The request every lineup agent is tested with. Both halves of the
 *  min/max pair are present, so a swallowed contradiction is provable rather
 *  than invented, and credentials are configured so one can be withheld. */
export const LINEUP_SAMPLE_BODY = Object.freeze({ query: 'what is the weather', wallet: '0xabc', min_results: 1, max_results: 5 });
const LINEUP_AUTH = Object.freeze({ authorization: 'Bearer lineup-demo' });

export function isLineupMode(mode) {
  return mode in LIES;
}

/**
 * Certify one lineup agent. The address is one this process chose on
 * loopback, never caller input, which is why the private-address guard is
 * bypassed here (same reasoning as certifyOwnDemoAgent in expressApp.js).
 */
export async function certifyLineupAgent(mode, { probeOpts = { dripMs: 120, cutoffMs: 600 } } = {}) {
  const agent = createFakeAgent({ mode, requireAuth: true });
  const url = await agent.listen();
  try {
    return await runCertification(
      {
        url,
        method: 'POST',
        sampleBody: { ...LINEUP_SAMPLE_BODY },
        authHeaders: { ...LINEUP_AUTH },
        allowPrivateAddresses: true,
      },
      { probeOpts },
    );
  } finally {
    agent.close();
  }
}

/** Which probes convicted, from a run or a report. */
export function convictions(runOrReport) {
  const rows = runOrReport.breakdown ?? runOrReport.probes ?? [];
  return rows.filter((p) => p.outcome === 'SILENT_WRONG').map((p) => p.probe);
}

/**
 * Judge one lineup result. "Caught" means the expected check convicted and no
 * other check did. A liar caught by the wrong check, or by extra checks, is not
 * a clean catch, and the honest agent must be convicted by nothing at all.
 */
export function judgeLineupEntry(entry, runOrReport) {
  const convictedBy = convictions(runOrReport);
  const ok = entry.caughtBy === null
    ? convictedBy.length === 0
    : convictedBy.length === 1 && convictedBy[0] === entry.caughtBy;
  return { ...entry, convictedBy, ok, verdict: runOrReport.verdict, score: runOrReport.score };
}

/** Plain-words headline for a finished lineup. */
export function lineupHeadline(results) {
  const liars = results.filter((r) => r.caughtBy !== null);
  const caught = liars.filter((r) => r.ok).length;
  const honest = results.filter((r) => r.caughtBy === null);
  const honestCleared = honest.every((r) => r.ok);
  return {
    liars: liars.length,
    caught,
    honestCleared,
    sentence: `${caught} of ${liars.length} lying agents caught, each by the check aimed at its lie. ` +
      (honestCleared ? 'The honest agent was accused of nothing.' : 'The honest agent was wrongly accused.'),
  };
}
