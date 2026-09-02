// THE AI LAYER, AND ITS CAGE.
//
// This is the only place a language model touches StressProof, and it is
// allowed to do exactly one thing: put an already-decided verdict into plain
// English for a human reader.
//
// It may not decide anything. It may not soften anything. It never sees the
// scoring rules, is never asked whether a verdict is right, and its output is
// never read back into any decision. The verdict is computed by scoring.js
// before this function is called, and is unchanged after it returns.
//
// Everything fails to SILENCE, never to invention:
//   no API key      -> no explanation
//   request fails   -> no explanation
//   times out       -> no explanation
//   malformed reply -> no explanation
//
// A report with no explanation is a slightly worse product. A report with a
// confident, wrong, model-authored explanation is a broken promise. The
// asymmetry is the whole design.

const TIMEOUT_MS = 8_000;
const MODEL = 'llama-3.3-70b-versatile';

/**
 * Reduce a report to the bare facts the model is allowed to describe.
 * Nothing beyond this ever reaches it — not the scoring rules, not the
 * thresholds, and not the raw responses from the target.
 */
function evidenceFor(report) {
  return {
    verdict: report.verdict,
    score: report.score,
    probesCompleted: report.probesCompleted,
    silentFailures: report.silentWrongCount,
    findings: (report.probes ?? [])
      .filter((p) => ['SILENT_WRONG', 'CRASH', 'DEGRADED', 'UNCLASSIFIED'].includes(p.outcome))
      .map((p) => ({ probe: p.probe, outcome: p.outcome, reason: p.reason })),
  };
}

const SYSTEM_PROMPT = `You explain the result of an automated reliability test on an AI agent's API.

Rules, all absolute:
- The verdict has ALREADY been decided by a deterministic engine. Never question, soften, hedge or contradict it.
- Describe ONLY the findings you are given. Never invent a cause, a fix, or a detail that is not in the evidence.
- Never claim the agent's answers are correct or incorrect. This test does not measure that. It measures whether the agent tells you when it cannot answer.
- Two short paragraphs maximum. Plain English, no jargon, no bullet points, no headings.
- First paragraph: what was found. Second: what it means for someone deciding whether to rely on this agent.
- If the verdict is INCONCLUSIVE, say plainly that this is a statement about the test, not a criticism of the agent.`;

/**
 * @param {object} report a finished report from toReport()
 * @returns {Promise<string|null>} plain-English explanation, or null
 */
export async function explainVerdict(report, { apiKey = process.env.GROQ_API_KEY, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!apiKey || !report) return null;

  try {
    const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 320,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(evidenceFor(report)) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim();
  } catch {
    // Silence, deliberately. Every failure mode lands here, and every one of
    // them produces no explanation rather than a guessed one.
    return null;
  }
}

/**
 * Whether this deployment can explain anything at all, and why not if it
 * cannot.
 *
 * Silence is the right failure mode for the explainer, but silence with no
 * label is ambiguous in a way that matters: a report with no explanation looks
 * identical whether the feature is switched off, the model timed out, or there
 * was genuinely nothing to say. A reader who cannot tell those apart will
 * assume the worst one. This is what lets the report say which it was.
 */
export function explainerStatus({ apiKey = process.env.GROQ_API_KEY } = {}) {
  if (!apiKey) {
    return {
      configured: false,
      reason:
        'no explanation model is configured on this deployment, so reports carry evidence and a verdict but no plain-English summary. The verdict is unaffected: it is computed before the explainer runs and never reads its output.',
    };
  }
  return { configured: true, model: MODEL, reason: null };
}

export { evidenceFor, SYSTEM_PROMPT, MODEL };
