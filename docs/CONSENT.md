# Proving you control the target

StressProof sends real traffic at somebody else's server on request. Before it
does, whoever asked has to show they are entitled to. There are two ways to do
that. The first is the default and has not changed. The second exists because
the first cannot support a re-check that runs on a schedule with nobody
watching.

## Mode 1: the one-time code (default)

Ask for a run:

```
POST /runs
{ "targetUrl": "https://your-agent.example/v1/chat",
  "payerAddress": "0x...",
  "sampleBody": { "query": "..." } }
```

You get back a run id and a code. Publish a plain text file at your own
origin, at `/.well-known/stressproof.txt`:

```
challenge=sp-<the code you were given>
payer=0x<the wallet paying for this run>
target=https://your-agent.example/v1/chat
```

Then start the run within 15 minutes. The code is useless afterwards and
useless to anyone else.

This proves you controlled that origin within the last fifteen minutes, which
is the strongest thing a file at a URL can prove.

## Mode 2: standing consent (opt in)

The one-time code assumes a person is available at the moment of the run. For a
certification that is re-checked every day, that assumption fails every day.
So a target's owner may instead publish one file granting a repeating
permission.

Ask for it by name:

```
POST /runs
{ "targetUrl": "https://your-agent.example/v1/chat",
  "payerAddress": "0x...",
  "sampleBody": { "query": "..." },
  "consentMode": "standing" }
```

Publish, at the same `/.well-known/stressproof.txt`:

```
standing=yes
payer=0x<the one wallet allowed to pay for testing this>
target=https://your-agent.example/v1/chat
expires=2026-10-01T00:00:00Z
min-hours-between-runs=24
```

All five lines are required, and **all five are fetched fresh and re-checked
before every single run.** Nothing is cached, nothing is remembered from the
last run.

| Line | What it does |
|---|---|
| `standing=yes` | Says this is a standing permission. Without it the file is treated as a one-time file and refused, so the two can never be confused |
| `payer=` | The one wallet allowed to pay for runs against this target. A different wallet does not inherit the permission |
| `target=` | The exact URL authorised. Permission for one endpoint never authorises another |
| `expires=` | When the permission dies. An ISO 8601 date, at most 30 days out |
| `min-hours-between-runs=` | The shortest gap you are willing to be tested at |

### How you revoke it

Delete the file, or edit any line in it. The next run stops. There is nobody to
notify and nothing to coordinate, because the permission is a question asked
again every run rather than a record of something that happened once.

### Why there is an expiry as well

Deletion and expiry protect against two different failures and the file needs
both.

Deletion covers the owner who changes their mind, or who sees something and
wants it stopped now. It does nothing for the far more common case, which is a
file published once, forgotten, and never thought about again. Only the expiry
covers that one, because it is the only protection that works when nobody is
paying attention.

The maximum is 30 days, enforced regardless of what the file claims. A file
saying `expires=2099-01-01` is refused outright rather than quietly shortened,
because silently changing what you said is its own kind of dishonesty. Thirty
days is the longest re-check interval anything built on this actually uses, so
renewal never has to happen more often than the loosest checking cycle it
supports.

### Two frequency limits, and both apply

`min-hours-between-runs` is yours. StressProof also enforces its own minimum
gap of 15 minutes between runs against any one target, regardless of who is
paying, because paying repeatedly must not amount to unlimited flooding.

Whichever is stricter wins. If you say weekly, weekly is what happens, even
though our own limit would allow much more. If you say zero, our 15 minutes
still applies. A refusal names which of the two stopped it, so you are never
sent to edit a file that was not the problem.

A daily re-check clears both comfortably.

## What standing consent does not prove

Stated plainly, and repeated in the honesty table:

- It does not prove a human decided anything today. A forgotten file keeps
  authorising runs until it expires, which is up to 30 days. The one-time code
  narrows that to 15 minutes. This is the trade, made knowingly.
- Anyone who can write files at your origin inherits the permission for the
  rest of that window: a compromised deploy pipeline, a stale build that
  redeploys an old copy of the file, a subdomain takeover.
- Revocation is only as fast as your own caching. We ask for the file with
  no-cache headers, which is a request and not a guarantee. A CDN still serving
  a deleted file is still consenting on your behalf.
- It is an origin-level permission, exactly like the one-time code. Anything
  that lets one tenant publish at another tenant's origin defeats both.

If none of that is acceptable for your target, use the one-time code. It stays
the default and nothing about it changed.
