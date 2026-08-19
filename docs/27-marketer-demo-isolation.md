# 27 — Marketer Demo-Money Isolation (docs/25 Decision F, resolved)

> **Status: IMPLEMENTED (migration 0084 + engine).** Resolves docs/25 §8 / §12-F and audit rec #1/#3.
> Marketers are DEMO / social-proof accounts: their game money is now structurally non-withdrawable and
> excluded from the real-cash economy — never dependent on a run-time phone check.

## 1. Decision (F)
Marketers do **not** play with real money. Their stakes and winnings live in a dedicated,
**non-withdrawable `wallets.demo_balance`**. A marketer win can never become real, M-Pesa-withdrawable
cash, and marketer gameplay never enters real turnover / GGR / RTP.

Rejected alternatives: (a) statistical settlement on `real_balance` (the status quo — the leak);
(b) scripted always-win. Chosen: **isolated demo bucket** — the system's own stated intent (0070:
"they play the game on funny money… NONE of it is real money"), made structural.

## 2. What changed
**Migration `0084_marketer_demo_isolation.sql`** (additive, idempotent, revertible):
- `wallets.demo_balance bigint not null default 0 check (>=0)` — the demo bucket.
- `fn_is_marketer_account(uuid)` — the **single canonical predicate** ("is this a demo account?"):
  a profile whose phone matches a `marketers` row, matched on the **significant 9 digits** so
  `+254… / 254… / 0… / 7…` all match uniformly (a SUPERSET of the old `^\+?254`→`0` rule that closes a
  gap where a bare-`7XXXXXXXX` marketer could be treated as a real player). The reporting view
  `marketer_account_ids` is re-pointed at this predicate, so money + reporting share one definition (rec #3).
- `fn_open_position` — marketer stakes debit `demo_balance` only (never dip into real); ledger `kind='demo'`.
- `fn_settle_position` — marketer payouts credit `demo_balance` only; ledger `kind='demo'`.
- `fn_marketer_game_withdraw` — the instant game→marketer-wallet transfer is sourced from `demo_balance`.
- `fn_create_withdrawal` — **hard guard**: a marketer account can never reach the real M-Pesa path
  (`MARKETER_NO_REAL_WITHDRAWAL`). Belt-and-braces on top of the service-layer routing.
- **Data migration**: existing marketers' `real_balance` is swept into `demo_balance` (idempotent), so no
  marketer retains withdrawable real cash.

**Engine:**
- `GameServer` takes an optional `loadIsMarketer(userId)` resolver. When present it is **authoritative**
  over the JWT `role` claim for the pool exemption — so the pool exemption and the money layer's demo
  routing can never disagree (prevents reserving real pool budget for a demo win). Falls back to `role`
  when absent (tests / back-compat).
- `server.ts` wires `loadIsMarketer` to `fn_is_marketer_account` (60s TTL cache; fails toward the real
  path so a lookup glitch never misclassifies a real player, and the DB RPC still guards regardless).
- `PgGameRepository.getBalance` / `getWalletSnapshot` surface the **demo** bucket as the spendable
  balance for marketers (so their UI shows their playable funds); real players unchanged.
- `InMemoryGameRepository` mirrors the DB demo routing (`markMarketer` / `seedDemo`) so engine tests
  reflect production money movement.

## 3. Invariants (all tested)
1. A marketer's `real_balance` is **never** increased by gameplay.
2. Marketer stakes/payouts flow through `demo_balance` only; a demo-short marketer is refused, never
   dips into real.
3. A marketer can never create a real M-Pesa withdrawal.
4. Pool budget is never reserved/paid for a marketer trade (they stay pool-exempt).
5. Real players are byte-for-byte unaffected (real bucket path unchanged).
6. Pool exemption == money routing (one predicate), regardless of the JWT role claim.

## 4. Tests
- **SQL e2e** (`test_demo_isolation.py`, run against real Postgres in an isolated schema, rolled back):
  41 scenarios — predicate across all phone forms, open/settle for player vs marketer, no-dip-into-real,
  idempotent re-settle, marketer-blocked real withdrawal, internal transfer from demo, inactive-account
  gate, data-migration correctness + idempotency. **41/41 pass.**
- **Engine e2e** (`apps/engine/src/game.demo.test.ts`): predicate-authoritative-over-role (both
  directions), real-never-touched-by-gameplay over 40 trades, no-dip-into-real, real-player-unaffected,
  pool-never-drawn over 100 marketer trades, back-compat role fallback. **7/7 pass.**
- Full monorepo suite: **542/542 pass**, `tsc -b` clean.

## 5. Operational follow-ups (not blocking)
- **Promoting an EXISTING account to marketer after 0084**: the one-time real→demo sweep runs only at
  migration. When an account is newly added to `marketers` later, add a real→demo sweep at that moment
  (in the marketer-create / role path) so it doesn't strand real_balance. Until then, such an account's
  pre-existing real is frozen (non-withdrawable via the new guard) and new play uses demo.
- **Funding marketers**: whatever admin path credits marketer "funny money" should credit
  `demo_balance` (not `real_balance`) going forward, to match the isolation.
- Reporting can now additionally exclude `balance_kind='demo'` ledger rows from real-cash GGR/RTP as a
  second safety net (the cohort exclusion already covers it).
