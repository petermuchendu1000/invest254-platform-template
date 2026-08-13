# TESTING — multi-tenant template

Evidence that the multi-tenant foundation is correct, tested aggressively, and regression-free.

## Results (this build)

| Suite | Tests | Result |
|---|---|---|
| **DB e2e (real Postgres, two isolated sites)** | 38 scenarios | ✅ all pass |
| Shared (`packages/shared`) incl. new `site.ts` | 75 | ✅ all pass (7 new) |
| Engine (`apps/engine`) incl. multiplex + WS integration + auth site-claim | 142 | ✅ all pass (12 new) |
| API (`apps/api`) | 115 | ✅ all pass |

Total: **332 automated tests + 38 DB e2e scenarios**, 0 failures. No regressions in inherited code.

## DB end-to-end (the hardest, highest-risk layer)

`packages/db/_testkit/e2e_multitenant.py` stands up a **local, ephemeral Postgres 17**, applies the
Supabase shim + **all migrations 0001→0048**, then runs adversarial two-site scenarios directly
against the SECURITY DEFINER money RPCs. It proved:

- All 46+ migrations apply cleanly **and are idempotent** (re-apply is a no-op).
- `site_id` is threaded onto every tenant table; the default site backfills existing data.
- **Per-site identity:** the same phone/username registers on two brands (two accounts); a
  duplicate within one brand is rejected.
- **Per-site fairness:** the same `trade_date` exists independently on two sites.
- **Money lifecycle per site:** open debits stake, settle credits payout, balances isolated.
- **Site-stamping bug-catch:** every stake/payout ledger row carries the POSITION's site — no
  row silently defaults to the wrong brand (this was the key risk of the column-default design).
- **Per-site stake bounds:** a stake valid on Site A is rejected on Site B's tighter economy.
- **Cross-site safety:** you cannot open Site A's wallet under Site B's id.
- **Scoped attribution:** a referral code resolves only within its own site; using it on another
  brand attributes nothing.
- **Feasibility guard:** an impossible economy (RTP/winRate ≤ 1) is rejected by the CHECK.
- **Statistical override:** a per-user win-rate boost is stored, site-scoped, and engine-feasible.
- **Deposits:** credit + idempotent completion (no double credit) + failed-no-credit + cross-site
  rejection; the deposit ledger derives the correct site from the transaction.
- **Withdrawals:** hold debits, approve→complete keeps the debit, failure/reject reverses; every
  hold/reversal ledger row is site-stamped; per-site minimum enforced.
- **Fairness:** `fn_ensure_game_day` is per-site + idempotent; `fn_reveal_game_day` reveals only the
  targeted brand's day (a sibling brand's same-date day stays committed).

Reproduce:
```bash
# start a local pg (see _testkit) then:
python3 packages/db/_testkit/e2e_multitenant.py
python3 packages/db/_testkit/e2e_rls_sites.py          # player/affiliate site RLS (0051)
python3 packages/db/_testkit/e2e_rls_admin_sites.py    # admin site RLS (0056, docs/22 Task F)
python3 packages/db/_testkit/e2e_platform_console.py
python3 packages/db/_testkit/e2e_affiliate_sites.py
python3 packages/db/_testkit/e2e_marketer_rollup.py
```

## Shared — per-site provably-fair seeds (`site.test.ts`)
Determinism; two brands decorrelated from one master+day; per-brand master also decorrelates;
day/version rotation decorrelates; commitment == single-tenant construction; input guards; a
brand seed never collides with the legacy single-tenant lineage.

## Engine — multiplex pricing core (`sitecontext.test.ts`)
Two brands get **decorrelated curves** from the same master+day; each **calibrates RTP to its own
economy independently** (held-out Monte-Carlo: Site A ≈ 0.25, Site B ≈ 0.10); deterministic
rebuild = crash-recovery equivalence; forced rotation changes only that brand; per-brand master
decorrelates. This reuses the proven `CurveGenerator`/`SettlementEngine` unchanged, so their
smoothness + RTP + fairness guarantees carry over per brand.

## Engine — multiplexed WS server (`multiengine.test.ts`)
A real **two-client WebSocket** integration test (two brands on one engine process) proves:
- each brand commits its **own seed** and streams a **decorrelated** tick sequence;
- `online` is counted **per brand**;
- auth → open → auto-settle on Brand A is **never** seen by Brand B (isolated fan-out);
- **per-brand stake bounds** are enforced independently (a stake valid on A is rejected on B).
Plus the entrypoint boot was smoke-tested (in-memory → live WS `hello`).

## Auth — per-site token `site` claim (`authservice.site.test.ts`)
- Register/login issue a JWT whose `site` claim binds the token to a brand (verified via the real verifier).
- The same phone registers independently on two brands; duplicate-within-a-brand is rejected.
- Login is **scoped to the brand** (a valid phone/password on Brand A is rejected under Brand B).
- Single-tenant (no siteId) still works and omits the claim.
Live-DB verified: `fn_register_user` 4-arg → default site, 5-arg → the given brand; `findByPhone`
returns exactly the brand's account (and both brands when unscoped).

## Run the TS suites
```bash
node --import tsx --test packages/shared/src/*.test.ts
node --import tsx --test apps/engine/src/*.test.ts
node --import tsx --test apps/api/src/*.test.ts
```

## Still to test (as the matching code lands — see docs/22)
Deposit/withdrawal + affiliate-accrual/payout RPC site-wiring; full engine server multiplex
(sockets + per-site GameServer + site-aware repo `ensureGameDay`/`listOpenPositions`); auth `site`
claim; API `requireSite`; RLS site dimension; web brand render; platform-superadmin console.
Each ships with the same two-site, isolation-first testing posture used above.
