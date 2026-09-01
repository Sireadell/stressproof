// Shared fact-extraction for Family A (and any later probe that needs the
// same raw signals). This file draws NO conclusions and reaches NO verdicts —
// it only turns a safeFetch response into named observed facts. The line
// between "observe" and "judge" is the whole point of the probe contract
// (see probeContract.js), so this stays deliberately dumb: it reports what
// is there, never whether that is good or bad.
//
// Shared across the four Family A probes because they all need the exact
// same four facts from a response. Duplicating this logic four times would
// let the definitions drift out of sync with each other, which would make
// the classifier's job (Day 7) unreliable in a way a single test could not
// catch.

/**
 * Keys/shapes that count as "the target signalled an error", for the
 * purposes of an observation only. This is NOT a judgment about whether the
 * error was appropriate — just whether an error-shaped signal is present at
 * all. The classifier decides what that means for a given status code.
 */
function hasErrorSignal(parsedBody) {
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) return false;
  if (['error', 'errors', 'err', 'detail'].some((k) => k in parsedBody)) return true;
  if (parsedBody.ok === false) return true;
  if (parsedBody.success === false) return true;
  if (typeof parsedBody.status === 'string' && ['error', 'failed'].includes(parsedBody.status.toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Whether the response body contains a recognisable trace of the mutated
 * input we sent. This is how the injection-canary-style "echoer" failure
 * mode (see fakeAgent.js) gets caught as a fact rather than silently
 * misread — a target that quotes bad input back in its error is a
 * different observation from one that stays silent about it, even though
 * both may otherwise look identical.
 *
 * Checked two ways, because a target that embeds our raw text inside its own
 * JSON error field (the common case — see fakeAgent.js's 'echoer' mode) will
 * have re-escaped it, so the needle's quotes become \" and no longer match
 * literally. Checking both the raw needle and its JSON-escaped form catches
 * a target that reflects the text verbatim (e.g. as plain text) as well as
 * one that reflects it as a nested JSON string, without guessing which.
 *
 * `needle` should be a stable, distinctive substring of what was sent. An
 * empty/missing needle means "not checked", not "not echoed" — callers
 * that cannot produce a meaningful needle (e.g. a multi-hundred-KB payload)
 * should pass a short marker instead of skipping the check silently.
 */
function echoedMutatedInput(rawBody, needle) {
  if (!needle || typeof rawBody !== 'string' || rawBody.length === 0) return false;
  if (rawBody.includes(needle)) return true;
  const escaped = JSON.stringify(needle).slice(1, -1); // drop the surrounding quotes JSON.stringify adds
  return escaped.length > 0 && rawBody.includes(escaped);
}

/**
 * Turn one safeFetch response into the observed facts every Family A probe
 * records. `needle`, if given, is checked for verbatim in the raw response
 * body (see echoedMutatedInput above).
 */
export function analyzeResponse(response, needle = null) {
  let parsedBody = null;
  let bodyParsedAsJson = false;
  if (typeof response.body === 'string' && response.body.length > 0) {
    try {
      parsedBody = JSON.parse(response.body);
      bodyParsedAsJson = true;
    } catch {
      // Not JSON. That is itself an observed fact (bodyParsedAsJson: false),
      // not an error — plenty of honest rejections are plain text.
    }
  }

  return {
    status: response.status,
    bodyParsedAsJson,
    errorSignalPresent: hasErrorSignal(parsedBody),
    elapsedMs: response.elapsedMs,
    echoedMutatedInput: echoedMutatedInput(response.body, needle),
  };
}
