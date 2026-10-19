// The lineup is the public claim "every lie we say we catch, we catch, and we
// accuse nobody honest". These tests are that claim, run for real against the
// demo agents, so the number on the page cannot drift from what the code does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LINEUP, certifyLineupAgent, judgeLineupEntry, lineupHeadline, isLineupMode } from '../src/lib/lineup.js';
import { LIES, MODES } from '../src/lib/demoAgent.js';

const FAST = { probeOpts: { dripMs: 20, cutoffMs: 300 } };

for (const entry of LINEUP) {
  const name = entry.caughtBy
    ? `${entry.mode} is convicted by ${entry.caughtBy} and by nothing else`
    : 'the honest agent is convicted by nothing';
  test(name, async () => {
    const run = await certifyLineupAgent(entry.mode, FAST);
    const judged = judgeLineupEntry(entry, run);
    assert.deepEqual(judged.convictedBy, entry.caughtBy ? [entry.caughtBy] : []);
    assert.equal(judged.ok, true);
    assert.equal(run.verdict, entry.caughtBy ? 'PARTIAL' : 'RESILIENT');
  });
}

test('every liar in the demo agent is in the lineup, once', () => {
  const inLineup = LINEUP.filter((e) => e.caughtBy).map((e) => e.mode).sort();
  assert.deepEqual(inLineup, Object.keys(LIES).sort());
  for (const mode of Object.keys(LIES)) assert.ok(MODES.includes(mode));
  assert.equal(isLineupMode('honest'), false);
  assert.equal(isLineupMode('obeys_injection'), true);
});

test('each liar is aimed at a different check', () => {
  const checks = LINEUP.filter((e) => e.caughtBy).map((e) => e.caughtBy);
  assert.equal(new Set(checks).size, checks.length);
});

test('a liar caught by the wrong check is not counted as caught', () => {
  const entry = LINEUP.find((e) => e.mode === 'ignores_input');
  const wrong = judgeLineupEntry(entry, { verdict: 'PARTIAL', score: 89, probes: [{ probe: 'malformed_json', outcome: 'SILENT_WRONG' }] });
  assert.equal(wrong.ok, false);
  const extra = judgeLineupEntry(entry, {
    verdict: 'PARTIAL', score: 80,
    probes: [{ probe: 'differential_corruption', outcome: 'SILENT_WRONG' }, { probe: 'malformed_json', outcome: 'SILENT_WRONG' }],
  });
  assert.equal(extra.ok, false);
});

test('the headline says so when the honest agent is wrongly accused', () => {
  const results = [
    { caughtBy: null, ok: false },
    { caughtBy: 'malformed_json', ok: true },
    { caughtBy: 'auth_absent', ok: false },
  ];
  const h = lineupHeadline(results);
  assert.equal(h.caught, 1);
  assert.equal(h.liars, 2);
  assert.equal(h.honestCleared, false);
  assert.match(h.sentence, /^1 of 2 lying agents caught/);
  assert.match(h.sentence, /wrongly accused/);
});
