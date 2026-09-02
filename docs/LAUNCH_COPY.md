# Launch copy

Drafts for Day 13. Nothing here goes out until the service is live and the
URL is real. Every `stressproof.dev` below is a placeholder to be replaced,
and every number is one I can point at rather than one that sounds good.

Written in first person because a real person is posting it.

---

## X post (main)

> Most agent testing asks "did it get the right answer?"
>
> I got interested in a different question: when your agent can't answer, does
> it say so, or does it hand you something confident and wrong?
>
> So I built StressProof. Point it at an agent's API, it fires 12 fixed
> failure conditions, and it scores whether the thing fails honestly or lies
> quietly.
>
> It never judges whether an answer is correct. That's not measurable from
> outside someone else's API in a domain you don't know. What is measurable:
> you sent malformed JSON, and it returned HTTP 200 with a cheerful answer.
>
> Free demo, no wallet, one command: stressproof.dev

**Why this shape:** opens on the distinction rather than the product, because
the distinction is the interesting part. No thread, no emoji, no "excited to
announce". The last line is the only ask.

---

## X post (follow-up, for after the first real external certification)

> I certified my own other project with it first, before anyone else's.
>
> It scored [SCORE]. [ONE HONEST SENTENCE ABOUT WHAT IT CAUGHT.]
>
> Publishing that felt worse than publishing a clean result would have felt
> good, which is roughly the point. A certifier that only shows you its
> passes isn't a certifier.
>
> [REPORT URL]

**Do not post this until the PulseVerify run is real.** If it scores well,
say so plainly and pick a different angle. Inventing a bad result to look
humble would be its own kind of dishonesty.

---

## Telegram post (Orion builder community)

> Built a thing that might be useful to people here before judging starts:
> StressProof certifies whether an agent fails honestly.
>
> You give it your agent's URL and one sample request it normally answers. It
> sends 12 fixed failure conditions (malformed input, missing fields, load,
> prompt injection with control probes), then scores whether your agent
> refuses cleanly or quietly returns something wrong.
>
> It won't tell you if your agent is good at its job. It tells you what it
> does when it's out of its depth, which is the thing you can't see from the
> happy path.
>
> Free for anyone building here, this week. Reply or DM and I'll run it and
> send you the full report privately. I'll only publish results for agents
> whose owner says yes.
>
> One thing worth knowing: it sends real traffic, so it makes you prove you
> control the target first, by publishing a one-time code at your agent's own
> address. That's deliberate. I didn't want to build something that can be
> pointed at other people's services.

**Why this shape:** the offer is the point, not the launch. Private report by
default and publish only with permission are both stated up front, because
the ask is "let me probe your live service" and that needs to sound safe.

---

## 90-second demo script

Timings are the target, not a promise. Screen recording, no face, no music.
Real terminal, real service, no cuts that hide a wait.

**0:00 to 0:12, the question**

> This agent answers questions about wallets. Watch what it does when I send
> it something broken.

Show one curl with malformed JSON. Show the HTTP 200 and the confident answer
come back.

> It didn't fail. It just made something up and returned success.

**0:12 to 0:25, the distinction**

> StressProof doesn't check whether an agent's answers are right. You can't
> check that from outside someone else's API. It checks whether the agent
> tells you when it can't answer.

**0:25 to 0:50, the run**

One command against the demo agent. Let it run in real time; it takes under a
second, so there is nothing to hide.

Show the verdict, the score, and the per-probe breakdown on screen. Say out
loud:

> Twelve probes, all of them ran. Six reached a firm enough conclusion to
> score. Four couldn't be judged from outside the API, and those get reported
> as unclear rather than as failures, because accusing an agent on weak
> evidence is the thing I most wanted to avoid.

**0:50 to 1:10, the check**

> Every report is signed. Here's the report, and here's the same report with
> one number changed.

Show `/verify/:id` passing. Edit the score by one. Show it failing.

> It also tells you whether the signature is actually mine, separately from
> whether the report was altered. Someone can forge a certificate that agrees
> with itself perfectly.

**1:10 to 1:30, the honesty table and the ask**

Show `/honesty` scrolling.

> This is every part of the product, marked real, simplified, or not built.
> I've updated it every day of the build rather than writing it at the end.
> Including the parts that aren't finished.
>
> Free demo, one command, link below.

**What not to do in this video:** no speeding up the run, no cutting away
during a wait, no showing a verdict that was produced off camera. The whole
pitch is that the thing is honest, and a demo that cheats to look smooth
would undercut it more than a slow moment would.

---

## Checklist before any of this goes out

- [ ] Service is live and the URL in every draft is replaced with the real one
- [ ] The three commands on the landing page actually work against the live URL
- [ ] A stranger on a phone can get a verdict from one command in under 60s
- [ ] `/about` reports payment and explainer honestly on the live deployment
- [ ] PulseVerify has actually been certified, and the number quoted is that run
- [ ] No external agent's result is published without its owner saying yes
