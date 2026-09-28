# 52 — What happens when a gateway refuses a deposit (migration 0174)

**Status:** applied to production 2026-09-28 (ledger 175/175); 199 ghost rows closed out.

## 1. The incident

Players saw:

```json
{"error":{"code":"PROVIDER_ERROR","message":"We couldn't complete that right now. …"}}
```

The real error, logged server-side by `app.payments.ts`'s `domain()` wrapper:

```
PAYHERO_INITIATE_REJECTED_400
{"error_code":"BAD_REQUEST","error_message":"The merchant has been blocked for spamming","status_code":400}
```

**This was not a code regression.** Evidence:

- the API was last deployed ~18:4x; a deposit **succeeded at 19:21:50** on that build;
- a deposit **succeeded at 19:53:42 — 39 seconds *after* a rejection at 19:53:03**;
- that day: **37 successes**, 61 failures, 21 ghosts.

PayHero's block is a **transient burst throttle**, not an account ban. It was provoked by six KES 200
deposits fired in 27 seconds. The route's rate limit is per **user** (20/min), which a ~4-second retry
loop slips under.

> **Which API:** production is on the **Kenyan** host. Both `payment_provider_config` rows (global and
> the MUCHENDU platform scope) hold `base_url: https://backend.payhero.co.ke/api/v2`, and resolution
> order is **DB → env → default**, so the stored value wins. Nothing points at `api.payhero.africa`.

## 2. The real defect it exposed — ghost deposits

Every initiate path created the row **before** calling the gateway:

```ts
const txId = await repo.createDepositProvider(...)   // row is now `pending`
const res  = await client.initiateStk(...)           // <-- throws: gateway refused
await repo.attachStk(txId, res...)                   // never reached
```

A refusal therefore left a row that is `pending` with `checkout_request_id IS NULL` **forever** —
nothing settles it, because the callback and the reconcile sweep both key on that id. **199** had
accumulated across every rail.

No money was ever at risk: the row predates the gateway call, so no STK prompt reached a player and
**0 `ledger_entries`** existed for any of them (verified). The damage was operational — the deposits
queue filled with ghosts, and a refusal looked like a stuck payment.

## 3. The fix

**`fn_abandon_deposit(tx, reason)`** closes such a row out. Deliberately narrow — it acts only on a row
that is still pending/processing, **has no `checkout_request_id`** (proof the gateway never accepted
it), and **has no ledger entries**. Anything else returns false, untouched. It cannot move money.

`withAbandonOnReject` wraps the gateway call on **all four** initiate paths (Daraja, MegaPay, PayHero
STK, PayHero Lipwa) and rethrows the provider's error unchanged — the clean-up never masks it.

Lipwa additionally had its `attachStk` moved to **after** the link is minted; attaching the checkout id
first would have made a refused Lipwa deposit un-abandonable by the guard above.

## 4. The gate — narrow on purpose, and EXACT (migration 0175)

`guardInitiate` stops two things:

1. **A retry straight after a rejection** (`DEPOSIT_REJECT_COOLDOWN_MS`, 6s). Retrying into a provider
   that just said no is what escalates one refusal into a merchant-wide block.
2. **A per-merchant ceiling** (`DEPOSIT_MERCHANT_PER_MIN`, 60) as the backstop for several players at
   once, keyed by the payment scope — the thing that decides whose credentials are used.

Both surface as **429**, never as a failure.

**What it deliberately does NOT throttle: a normal sequence of deposits.** The first version threw a
minimum gap around *every* attempt and broke six existing e2e tests — correctly, because a player
whose deposit just succeeded may immediately make another. Only the loop that provokes the provider
is stopped. `paymentservice.initiateguard.test.ts` pins this with a test that drives five successful
deposits back to back.

### It is a guarantee, not a mitigation

The first version kept the counters in process memory. That bounds each API machine independently: with
N machines the real ceiling is N x the configured one, and a player's post-rejection hold is honoured
only by the machine that served the rejection. For a **merchant-wide** block, one machine's view of the
rate is not the rate.

`0175` moves the gate into **Postgres** — the shared store this stack already has, and the one the
deposit row is created in on the same request, so a gate here cannot be "down" while deposits are
otherwise working. Adding Redis would have put a new availability dependency on the money path for no
benefit.

`fn_deposit_gate` takes a **row lock per key**, so concurrent initiations serialise on that key and the
counter cannot be raced. The two keys are disjoint namespaces and are always locked in the same order
(user, then merchant), so it cannot deadlock against itself. A refused caller consumes **no** slot.

**FAILS CLOSED.** An initiate whose gate cannot be consulted is refused with a 429 and never sent to
the gateway, so there is no path to a provider without a granted slot. The cost is nearly theoretical,
per the paragraph above.

**Proven under real concurrency, not asserted:** 24 parallel independent connections against a ceiling
of 10 returned exactly 10 `ok` and 14 `busy`, and the counter landed on exactly 10 — no over-grant, no
lost update.

## 5. Client side

The deposit button now shows a spinner while the prompt is being sent, then holds for **6 seconds**
with `Check your phone · Ns` — matching the server's cooldown, so the UI never invites a request the
API would refuse. A second prompt cannot help a player still looking at the first one.

## 6. Verification

`0174` was run against **production inside a transaction and rolled back** before applying: 199 rows
closed, none left stranded, the function **refused** both a settled deposit and an in-flight one that
carried a checkout id, and wallets/ledger were untouched (84,370 ledger rows, balances unchanged).

`apps/engine/src/paymentservice.initiateguard.test.ts` — 9 cases: a refusal closes the row out and is
terminal; the provider error is rethrown unchanged; no money moves; a retry after rejection never
reaches the gateway; **a normal run of five successful deposits is never throttled**; the first attempt
is never blocked and the cooldown is per player; a throttled attempt creates no row at all; a live
deposit is never abandoned.

Full suite: **1290 passing**.
