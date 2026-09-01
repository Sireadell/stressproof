# StressProof

**Point it at an agent's API. It fires 12 fixed failure conditions and scores
whether the agent fails honestly or lies quietly.**

StressProof does not check whether your agent's answer is *correct*. It checks
whether your agent *tells you when it cannot answer*.

That distinction is why the score is deterministic instead of a matter of
opinion. Judging "was that answer right" for a stranger's agent in an unknown
domain is not solvable. Judging "did it return a success-shaped response to
input it should have rejected" is a fixed check on an HTTP response, and two
people running it get the same answer.

## Status

Working end to end. **190 tests passing** (counted, not estimated — run
`npm test` and check). All twelve probes are implemented, the scoring engine
is live, reports are signed and independently verifiable, and there is a free
demo that needs no wallet.

Not done: no real payment has been settled yet. The payment config is verified
against the live facilitator, but until a real transaction exists we do not
claim one. See [`docs/REAL_VS_SIMPLIFIED.md`](docs/REAL_VS_SIMPLIFIED.md) for
exactly what is real, what is narrowed, and what is not built. That file is
updated as the build goes and nothing in it is retrofitted at the end.

## See it work in 30 seconds

```bash
npm install && npm start
# then, in another terminal:
curl -s -X POST http://localhost:3000/demo/certify \
  -H 'content-type: application/json' -d '{"demoMode":"sloppy"}'
```

Swap `sloppy` for `honest`, `crashy` or `echoer` and watch the verdict change.
The demo runs against a deliberately flawed agent we host ourselves, so it
raises no consent question — the target agreed, because the target is us.

| Demo agent behaves like | Verdict | Score | Caught lying |
|---|---|---:|:---:|
| honest | RESILIENT | 100 | no |
| correct, but quotes bad input back | RESILIENT | 100 | no |
| crashes loudly on bad input | PARTIAL | 77 | no |
| answers confidently to nonsense | PARTIAL | 83 | **yes** |

Note the last two rows. The lying agent *scores higher* than the crashing one
and still cannot beat PARTIAL, because one silent failure caps the verdict. A
quiet wrong answer is worse than a loud crash, and the verdict enforces that
rather than merely claiming it.

## Documents

- [`docs/PROBES.md`](docs/PROBES.md) — the 12 probes, frozen, with every threshold as a literal number
- [`docs/SCORING.md`](docs/SCORING.md) — the six outcomes and the exact SILENT_WRONG rules
- [`docs/REAL_VS_SIMPLIFIED.md`](docs/REAL_VS_SIMPLIFIED.md) — what is real, what is narrowed, what is not built

## Tests

```bash
npm test
```

190 passing, stable across repeated runs. These are not decoration — writing
them caught bugs that reading the code did not:

- The published 30-request cap did not match the sum of its parts (it was 32).
  The very first test written failed on its first run.
- An oversized response would have hung a run forever, waiting for an ending
  that never came.
- A compromised agent hiding the evidence in encoded text scored **clean** —
  a false negative, the worse direction to fail in.
- Running the whole product against an *honest* agent revealed it was being
  **falsely accused three times**, because we were treating "answered after we
  deleted a field" as a lie when the field may simply have been optional.
- A lying agent was reported as "we couldn't tell", burying proven evidence.

Two of those came from the same underlying mistake — a ratio with no floor
behaves absurdly at small values — which is recorded as a pattern rather than
as two unrelated fixes.

## Consent, and why this is not a stress-testing weapon

StressProof sends traffic at a stranger's server on request, so it refuses to
run without proof that the requester controls the target:

- A one-time code, issued per run, must appear at the target's
  `/.well-known/stressproof.txt` within 15 minutes. A permission file written
  once and left up forever is not enough.
- Hard cap of 30 requests per run, published and asserted by test.
- One run per target per 15 minutes, no matter who pays.
- Private, loopback and internal addresses are refused, and the address is
  pinned at resolution time so the check cannot be dodged.

## Licence

Apache-2.0. Includes work adapted from
[AgentOps-Bench](https://github.com/kunwarshivam/agentops-bench) — see
[`NOTICE`](NOTICE).
