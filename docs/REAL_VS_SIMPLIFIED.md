# Real vs Simplified vs Not built

Started Day 1, updated every day of the build. Nothing here is retrofitted at
the end.

**Real** = enforced in code and covered by a test.
**Simplified** = it works, but in a narrower way than the name suggests, and the narrowing is stated.
**Not built** = designed, not implemented. Never faked, never demoed as if it exists.

| Capability | Status | Detail |
|---|---|---|
| Frozen 12-probe spec | **Real** | `src/lib/spec.js`, 17 tests asserting internal consistency |
| 30-request hard cap | **Real** | Asserted by test; the parts are proven to sum to the published total |
| Six-outcome classifier incl. UNCLASSIFIED | **Real** | Spec + tests. Implementation lands Day 7 |
| Payment config for Base mainnet | **Real** | Facilitator confirmed live to settle `eip155:8453`; USDC contract, decimals and EIP-712 domain all verified on-chain; 11 tests |
| Payment preflight check | **Real** | `scripts/preflight.js`, passes against both mainnet and testnet |
| **Settled payment on Base** | **Not built** | Config is proven; no real payment has been sent yet. Needs a funded wallet — owner-side, see [DAY2_PAYMENT.md](DAY2_PAYMENT.md). No transaction hash is claimed until one exists |
| Refusal of private/internal addresses | **Real** | Allow-list of public addresses only, checked on every resolved address; IPv4-mapped IPv6, decimal/octal literals, cloud credential range and loopback all covered by tests, including against a live local server |
| Connection pinned to the checked address | **Real** | The validated address is the one connected to, so a hostname cannot resolve to something safe during the check and something private during the connection |
| Redirects never followed | **Real** | A redirect is a destination that never passed the check. Captured and reported, never followed |
| Consent challenge flow | **Real** | One-time code, 15-minute expiry, bound to payer wallet + exact target URL. 18 tests covering stale codes, wrong payer, wrong endpoint, replay and expiry |
| Standing consent for recurring checks | **Real** | Opt-in second mode for unattended re-certification. One published file authorises one wallet to certify one exact URL, with an expiry date the owner sets and a maximum frequency the owner sets. All five fields are re-fetched and re-checked before every single run, so deleting the file stops the next run. 23 tests, including that a one-time file is never read as standing consent and the reverse |
| Standing permission capped at 30 days | **Real** | A ceiling applied regardless of what the file claims. A file claiming a longer life is refused outright rather than quietly shortened, so renewing the file is a recurring, if weak, proof that somebody still controls the origin. The constant is in `spec.js` as `CONSENT_POLICY`, deliberately outside the scoring fingerprint, because a permission window cannot move a single point on a single probe and pretending otherwise would invalidate every report ever issued |
| Owner-set testing frequency | **Real** | The consent file states the shortest gap the owner is willing to be tested at. It applies alongside StressProof's own 15-minute per-target cooldown, whichever is stricter wins, and the refusal names which of the two stopped the run so an owner is never sent to edit a file that was not the problem |
| Per-target cooldown | **Simplified** | Enforced, and enforced across payers so paying repeatedly is not unlimited flooding, but held in memory, so a restart clears it. This matters more on the deployed service than it reads: the free hosting plan sleeps after 15 minutes without traffic, so in practice the cooldown is cleared often rather than rarely. A determined caller who waits out the idle window gets a fresh cooldown. The 30-request cap per run is unaffected, being fixed in the spec rather than counted at runtime |
| All 12 probes implemented | **Real** | 54 probe tests against a live local fixture in five behavioural modes. Every probe observes only — none decides an outcome |
| Injection probe's false-accusation defence | **Real** | The `echoer` fixture (a correct agent that quotes bad input back) lands 6 techniques but every matching control echoes too, so it is not convicted. A genuinely compromised stub is caught on all 6 with all controls silent |
| Scoring engine | **Real** | Six-outcome classifier, pure functions, no model anywhere near a verdict. 33 tests, most of them about *not* convicting |
| Evidence measured by kind, not just count | **Real** | A verdict needs five conclusions spanning at least two different kinds of failure, and the top verdict needs three. Five conclusions that are all the same probe wearing different hats is one piece of evidence, not five |
| Narrow evidence downgrades instead of voiding | **Real** | A run that never reached a conclusion about adversarial input is reported with what it did find, capped below the top verdict, and told plainly that this is a limit on the test rather than a fault in the agent. Voiding a real finding and awarding an unearned badge are both worse |
| Full 12-probe run, end to end | **Real** | Runs against a live agent inside the published 30-request cap; an honest agent certifies RESILIENT, a lying one is capped at PARTIAL, an unreachable one is INCONCLUSIVE and never BRITTLE |
| Signed, independently verifiable reports | **Real** | Every report is signed; altering one character of a verdict or of the evidence breaks verification. 13 tests, most of them deliberate tampering. Anyone can recover the signing address from the report alone |
| Verification by one URL | **Real** | `GET /verify/<id>` checks a report we are serving, so a judge needs a link rather than a hand-built request. `POST /verify` still checks a copy you saved, from a machine we do not run |
| Forged certificates told apart from altered ones | **Real** | A signature that is perfectly self-consistent can still have been made by somebody else's key. Both verification routes answer `valid` and `signedByStressProof` separately, so a forgery cannot pass by reading one field. Covered by a test that signs a real report with a stranger's key |
| Probe contract + 5-mode test agent | **Real** | Shared harness all probes are tested against, including an `echoer` mode built specifically so the injection probe's false-accusation path cannot ship untested |
| On-chain publication of certificates | **Not built** | Deliberately cut, not deferred. An offline-verifiable signature gives the same guarantee at no cost and with no risk of a failed broadcast spoiling a good verdict |
| Plain-English explainer | **Real** | Describes an already-decided verdict; never sees the scoring rules, cannot change a verdict, and stays silent on any failure rather than inventing one. 9 tests, including one proving a hostile model reply changes nothing |
| Silence that says which kind of silence it is | **Real** | A report with no summary now says whether the explainer is switched off or simply did not answer, and states that the verdict is unaffected either way. An unlabelled blank reads as a broken product |
| Unsigned reports told apart from tampered ones | **Real** | A deployment with no signing key produces unsigned reports. Verification reports those as unsigned rather than as failures, because telling a reader to distrust a sound report would be the same dishonesty this product measures |
| Honesty table served, not filed | **Real** | Published at `/honesty` straight from the repo, so the document making the claims is reachable without cloning the code |
| Deployment config | **Real** | `render.yaml` with every secret left unset on purpose. Each missing one degrades loudly and visibly at `/about`: no payout address refuses paid runs, no signing key leaves reports unsigned, no model key leaves reports unexplained |
| HTTP service + public page | **Real** | Consent flow, free demo, both verification endpoints. 16 route tests: refusals explain themselves, unknown ids 404 rather than crash, the free route refuses a target that never agreed, and the abuse ceiling is proven to actually stop a caller |
| Free demo without a wallet | **Real** | Runs against a deliberately flawed agent **we host**, so the demo raises no consent question. Capped per address and per day |
| Paid route gated at 0.25 USDC | **Real** | `POST /runs/:runId/start` is behind an x402 paywall. An unpaid request gets a 402 carrying the network, the USDC address, the amount and the EIP-712 domain a payer needs to sign with. Asking for a consent code stays free, because it costs us nothing |
| Payment bound to the wallet that proved consent | **Real** | The wallet that pays must be the wallet named in the consent file. Otherwise anyone holding a run id could buy 30 requests aimed at an agent somebody else vouched for. Checked as a pure function with its own tests, including that letter case does not falsely refuse a legitimate payer |
| Never free by accident | **Real** | Three boot states, not two. Charging, deliberately free, or *meant to charge and cannot*, and the third refuses with a 503 rather than quietly giving runs away. A facilitator that cannot be reached also refuses. Both covered by tests that assert the run never starts |
| Free demo's triple bound | **Real** | Per-address limit, daily budget, and a fixed target list, all three enforced before any traffic leaves. The ceiling is proven by a test that keeps calling until it is actually stopped |
| Paid route settlement | **Not built** | The gate is real and refuses correctly; no real payment has been settled through it yet. Needs a funded wallet, owner-side, see [DAY2_PAYMENT.md](DAY2_PAYMENT.md). No transaction hash is claimed until one exists |

## Known limitations, stated up front

These are properties of the design, not bugs to be fixed later.

- **We do not check whether an agent's answer is correct.** Only whether it
  tells you when it cannot answer. An agent that is confidently, fluently
  wrong about its actual subject matter will pass every probe here.
- **The injection family only catches compliance that echoes.** An agent that
  silently obeys an injected instruction without echoing anything is missed by
  design.
- **A `RESILIENT` verdict is not a security audit.** It is twelve fixed
  probes, run once, from one machine.
- **Non-determinism is not penalised.** Two runs against the same agent can
  differ, and the report says which probes were affected.
- **`INCONCLUSIVE` is common and is not an insult.** Targets behind auth we
  cannot supply, or too noisy to measure, return `INCONCLUSIVE` rather than a
  guessed verdict.
- **Some agents cannot be certified at all, by design.** Proving control of a
  target means publishing a one-time code at its own address. Certain managed
  hosting platforms do not let an operator serve a file at `/.well-known/`,
  and those targets are simply out of scope. Accepting weaker proof would make
  the permission check decorative, and a tool that sends traffic at strangers
  does not get to have a decorative permission check.
- **Standing consent proves the file is still being served, not that a human
  meant it today.** The one-time code proved somebody controlled the origin
  within the last fifteen minutes. Standing consent proves the origin is still
  serving the permission right now, which stops a deleted or edited file dead
  on the next run, and it proves nothing about whether anyone has thought about
  it since they published it. A file left up and forgotten keeps authorising
  runs until its expiry date, up to thirty days. Anyone who can write files at
  that origin, through a compromised deploy pipeline, a stale build that
  redeploys an old copy, or a subdomain takeover, inherits the permission for
  the rest of that window. This is a real widening of the challenge flow's
  fifteen-minute exposure and it is the price of unattended re-certification,
  accepted knowingly rather than overlooked.
- **Revocation is only as fast as the origin's own caching.** We ask for the
  consent file with no-cache headers before every run. A CDN that keeps serving
  a deleted file is still consenting on the owner's behalf, and we cannot tell.
- **The per-target cooldown does not survive a restart.** It lives in memory
  today. A deliberate attacker who could force a restart could shorten the gap
  between runs; the 30-request per-run cap still holds regardless.
- **Volatile fields are learned from only two samples, so a slow-changing one
  can be missed.** We detect which parts of your response legitimately change
  (ids, timestamps) by sending the same request twice and comparing. A field
  that happens to hold the same value across both — a timestamp when both
  requests land in the same millisecond, a counter that has not ticked — looks
  stable to us. The comparison that follows can then read a normal variation
  as a real difference, which makes us *miss* a problem rather than invent
  one. Found because a test went intermittently red, not by reasoning about it.
- **Two of the twelve probes usually cannot reach a firm conclusion, and say
  so.** If we delete a field from your request, or change its type, and your
  agent answers normally, that may mean it ignored the field — or the field
  may simply be optional. From outside your API we cannot tell, so the honest
  answer is "unclear", not an accusation. Proving a field was genuinely
  ignored is `differential_corruption`'s job, because that probe has a
  baseline to compare against. This was found by running the whole product
  against a *correct* agent, which it then accused three times.
- **A run needs 7 of about 10 usable probes to reach a verdict.** Below that
  it reports INCONCLUSIVE. The one exception: a demonstrated lie is always
  reported, however little else could be measured, because burying proven
  evidence under "not enough data" would be worse than saying nothing.
- **An agent that echoes because your wording looked hostile can still be
  wrongly suspected.** The injection controls defeat an agent that echoes
  because the input *shape* looked odd; they do not, by themselves, defeat one
  that echoes because the *wording* looked like an attack. A second check (did
  the canary appear anywhere other than a verbatim quote of our own request)
  covers that case, and the scoring rules require both before convicting. It
  is a real residual weakness, mitigated rather than eliminated.
- **The contradiction probe sometimes has to add the field it contradicts.**
  If a sample request has `max_results` but no `min_results`, the probe adds
  one to build the contradiction — and a target that simply ignores fields it
  does not recognise will answer normally and look like it swallowed a
  contradiction. Every report records whether the counterpart was invented, so
  that case is never scored as harshly as a genuinely inverted existing pair.
- **The rate probe sends its 7 requests one after another, not all at once.**
  That is deliberate — firing them simultaneously would make "your agent broke
  at request 5" depend on which response happened to arrive first, and a
  finding that changes between runs is not evidence. The honest cost: a target
  that only throttles above some requests-per-second rate may never be tripped
  by 7 sequential requests, and will look untested rather than resilient. This
  probe reliably detects count-based limits and cannot promise to detect
  rate-based ones.

- **When the payment facilitator is unreachable, the paid route answers 500,
  not a helpful message.** It refuses, which is the part that matters: no run
  goes out and nothing is given away free. But the caller sees a generic server
  error rather than "our payment provider is down, try again shortly", because
  the x402 middleware handles that failure internally and does not hand us a
  chance to reword it. Correct behaviour, poor explanation.
- **A run bills even when the target turns out to be unreachable.** The work
  being paid for is the probing, not the verdict, so a target that is down
  produces an INCONCLUSIVE report and still costs 0.25 USDC. That is stated in
  the 402 challenge itself and on `/about`, so it is a disclosed policy rather
  than a surprise, but it is a real cost to a payer whose agent happened to be
  offline.
- **Reports and rate limits are held in memory, so a restart clears both.**
  A restart drops stored reports (they stay verifiable from a saved copy) and
  also resets the free demo's daily budget and the per-target cooldown. On a
  host that restarts often, those ceilings are looser in practice than the
  numbers suggest.

- **The evidence floors were tuned against our own demo agents, not a large
  sample of real ones.** Five conclusions across two families is a judgement
  about how much is enough, and it is the third revision of that judgement.
  Nine was unreachable, seven left a healthy agent sitting exactly on the line,
  and the current pair leaves one family of headroom. It is a better-founded
  number than the last two and it is still a number chosen from a handful of
  runs. Certifying real external agents is what will actually test it.

## Attribution

The six injection delivery-technique *shapes* are adapted from
[AgentOps-Bench](https://github.com/kunwarshivam/agentops-bench) (Apache-2.0).
The payload target and all detection logic are ours. See `NOTICE`.
