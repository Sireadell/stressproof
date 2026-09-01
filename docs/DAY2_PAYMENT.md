# Day 2 — payment on Base: what was found

## GO/NO-GO 1: **GO**, with a correction to the plan

The build plan assumed the risk was "does x402 work on Base at all." The real
risk turned out to be narrower and sharper: **the facilitator everybody
defaults to does not settle Base mainnet.**

### Confirmed live, 2026-09-01

Asked `https://x402.org/facilitator/supported` directly:

```
eip155:84532   Base Sepolia   ← testnet only
base-sepolia   (v1 naming)    ← testnet only
```

`eip155:8453` — Base **mainnet** — is not in the list. Not deprecated, not
undocumented: absent.

This is the identical trap PulseVerify hit with X Layer, where the same public
facilitator silently did not settle the target chain and the failure surfaced
weeks later as a rejected submission. Docs implied support; the live endpoint
disagreed; only the live endpoint was true.

### Two no-auth facilitators that DO settle Base mainnet

Both confirmed by querying their own `/supported`:

| Facilitator | Mainnet `eip155:8453` | Sepolia `eip155:84532` |
|---|:---:|:---:|
| `facilitator.xpay.sh` | yes | yes |
| `facilitator.0xarchive.io` | yes | no |

**xpay is the default.** It serves both networks, so the planned fallback
(ship on testnet if mainnet settlement misbehaves) becomes a one-line config
change instead of swapping providers mid-build. Coinbase's CDP facilitator
also settles mainnet, but it needs an account and API keys — that would put an
owner-side signup on the critical path, so it is not the default.

### USDC on Base, verified on-chain not from a docs table

`eth_call` against `https://mainnet.base.org`, contract
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`:

```
name()             "USD Coin"
symbol()           "USDC"
decimals()         6
version()          "2"
DOMAIN_SEPARATOR() present
```

So the EIP-712 domain is `{ name: "USD Coin", version: "2" }`.

This matters more than it looks. That two-field object is **required** in the
402 challenge for the exact/EIP-3009 scheme. Without it, a paying client
cannot build the signature and gives up *before it ever sends a paid request*.
On the seller's side that looks like the buyer timing out. PulseVerify failed
review twice on exactly this, and the cause was two missing fields.

## Re-runnable check

```bash
node scripts/preflight.js                        # mainnet
STRESSPROOF_NETWORK=sepolia node scripts/preflight.js   # testnet
```

Both pass as of Day 2. Run it before every deploy, and first whenever payments
misbehave. It asks the facilitator rather than trusting this document — this
document can go stale, the facilitator cannot.

## The one step that is owner-side

**Everything above is verified. Actual settlement is not, and cannot be by
me.** Sending a real payment needs a funded wallet and a signature, which is
yours to do, not something to automate on your behalf.

To close out GO/NO-GO 1 completely, once the paid route exists on Day 9:

1. Fund a wallet on Base with a small amount of USDC (well under a dollar
   covers several test runs at $0.25).
2. Make one paid call to the live endpoint.
3. Record the settled transaction hash.

That hash goes in the README as proof a judge can check independently. Until
then the honesty table says payment is verified-but-not-settled, which is the
truthful state.

**Judgement:** this does not block Days 3–8. The config is proven correct
against live infrastructure, both networks work, and the fallback path is a
config flag. Settlement is a ten-minute task once there is a route to pay.
