# Bug Log

Running log of bugs caught (new or pre-existing) while working through issues, with status. Each
entry: what, evidence, root cause, impact, and resolution.

---

## #1 — Bonus subsystem was dormant in the live money RPCs — FIXED (issue 1 / migration 0094)
- **What:** `bonus_balance` was frozen platform-wide — it could never be staked, wagered, or converted.
- **Evidence:** Live `fn_open_position` (10-arg) and `fn_settle_position` only moved `real`/`demo`
  balances; the `bonuses` table was empty across all 9 brands.
- **Root cause:** the original 0037 bonus mechanics were dropped when the RPCs were rewritten for
  site-scoping (0047) and demo isolation (0084). Deposit-bonus *granting* was also removed at 0077/0078.
- **Impact:** any credit to `bonus_balance` would have been permanently unusable and non-withdrawable.
- **Resolution:** migration 0094 restores bonus-first staking, wagering accrual, and FIFO conversion in
  the site-scoped/demo-aware RPCs (additive; verified no-op for existing zero-bonus accounts). See docs/31.

## #2 — DepositForm advertised a deposit bonus the backend never grants — FIXED (issue 1)
- **What:** the deposit screen showed a live "+KES X bonus (50%/25%/15%)… credited instantly as bonus
  balance" preview, but `fn_complete_deposit` (0078) grants no deposit bonus.
- **Resolution (per direction "remove any deposit-bonus apart from the one we just implemented"):**
  removed the DepositForm preview + `bonusPctForDeposit` import; deleted the shared deposit-tier module
  (`packages/shared/src/bonus.ts`, its `./bonus` package export, the engagement re-export, and its
  tests); and dropped the orphaned `fn_deposit_bonus_pct` in migration 0094. The **only** bonus in the
  system is now the sign-up welcome bonus. (Legacy `bonus_config.tiers/wagering_x` columns are left
  inert.)

## #3 — Admin "day" finance report is timezone-fragile (fails 00:00–03:00 EAT) — FIXED (issue 1 / global-config)
- **What:** `app.admin.isolation.e2e.test.ts` → "finance reports (daily/day/users) are brand-scoped"
  fails: `day report: brand A only` expects 40000, gets 0.
- **Evidence:** Reproduced on a clean `main` (pre-existing; independent of issue 1). The test derives
  `today` via `Africa/Nairobi` (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`) while the
  deposit rows are grouped by their stored (UTC) date. When the run happens in the window where the
  Nairobi calendar date is already ahead of UTC (00:00–03:00 EAT), the requested day and the stored day
  disagree and the report returns 0.
- **Impact:** the `/admin/reports/day` aggregation and/or the test are not timezone-consistent; the
  report can under-count near the UTC/EAT day boundary. Test is flaky by wall-clock (green during Nairobi
  daytime).
- **Refined root cause (this fix):** the *production* report (`PgAdminRepo.reportDay`, apps/engine/src/admin.ts)
  was already correct — it groups by `(created_at at time zone 'Africa/Nairobi')::date`. The defect was in
  the **in-memory test harness** helper `dayOfMs` (apps/engine/src/admin.ts:521), which used
  `toISOString().slice(0,10)` (UTC). The harness therefore bucketed cash facts under the UTC day while the
  test (and production) use the EAT day — diverging only in the 00:00–03:00 EAT window.
- **Resolution:** `dayOfMs` now returns the EAT calendar date
  (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`), matching production SQL and the callers'
  EAT `today`. **No production financial-reporting behaviour changed** (only the harness), so the prior
  concern about touching a live report does not apply. Baseline test suite is now fully green (610/610),
  and the finance-isolation e2e is deterministic regardless of wall-clock.
- **Follow-on:** two `app.admin.test.ts` report tests computed their expected day in UTC
  (`toISOString().slice(0,10)`) and were the mirror of the isolation test (they only passed during
  Nairobi daytime). Aligned both to the EAT calendar date so ALL day-report tests now agree with the
  production EAT boundary and each other.

## #4 — Phone-only password reset is account takeover for admins/superadmins — FIXED (issue 2 / migration 0097)
- **What:** `POST /api/v1/auth/password/reset` sets a new password from phone + new password alone
  (no possession proof), gated only by `ALLOW_UNVERIFIED_PASSWORD_RESET`. For a privileged account
  (admin / superadmin / platform_superadmin) anyone who knows the phone number could seize the back
  office.
- **Evidence:** `AuthService.resetPassword` had no second factor for privileged roles; the only reset
  path is that public endpoint (no admin-panel reset exists). Production roles are player/marketer/
  admin/platform_superadmin — note there is NO literal `superadmin`, so the real top account is
  `platform_superadmin` and had to be included in the privileged set.
- **Impact:** full account takeover of any admin whose phone number is known. `ALLOW_UNVERIFIED_PASSWORD_RESET`
  IS set as a Fly secret on `invest254-api` (confirmed via `fly secrets list`; value hidden but presence
  implies enabled), so this was very likely LIVE-exploitable before the fix. (An earlier partial GraphQL
  secret listing wrongly suggested the flag was absent.)
- **Resolution (migration 0097 + code):** privileged resets now REQUIRE all three security-question
  answers to verify, independent of the flag, and fail CLOSED when answers are unset. Added
  `user_security_answers` (scrypt-hashed, RLS/service-role only) + `profiles.sessions_valid_after`
  force-logout epoch (privileged tokens issued before it are rejected). `/auth/me` exposes
  `securitySetupRequired`; the web shows a mandatory non-dismissible setup gate. See docs/32.
  ROLLOUT COMPLETED 2026-08-21: migration 0097 applied; API deployed to Fly invest254-api; web deployed
  via Cloudflare Pages (commit 26b630a); force-logout stamped for all 3 privileged accounts. Verified in
  prod: reset on a real admin phone returns 403 SECURITY_QUESTIONS_NOT_SET (fail-closed, no change).
  Full suite 610 pass / 0 fail.

## #5 — Demo/marketer classifier was NOT site-scoped → players bypassed the withdrawal pool — FIXED (migration 0100)
- **What:** `fn_is_marketer_account` (0084) matched a profile to the `marketers` cohort on **phone
  (significant-9) alone, across ALL brands** — no `site_id` filter. But 0076 made `marketers` per-site
  and docs/20 §7 defines marketer identity as per-site. So a real **player on brand B** whose phone
  collided with a marketer on brand A was classified demo/marketer on brand B.
- **Symptoms (reported):** "global pool fund not applying to some clients (e.g. 33traders)" and "players
  using game config meant for marketers instead of the pool fund."
- **Mechanism (confirmed end-to-end):** engine `loadIsMarketer` → `fn_is_marketer_account` → wrongly
  true → `poolPath = poolActive && !isMarketer` = false → the player **skips the withdrawal pool and
  settles on the statistical ("marketer") path**, and the money layer (0086) routes them to the demo
  bucket. Not a mirror/template or deployment issue — the defect is in applied SQL affecting every brand;
  33traders is a normal row in the primary DB and pools correctly once classification is right.
- **Evidence (live):** 13 `role=player` accounts flagged as marketer; 5 were pure cross-site
  contamination (no marketer on their own site): 33traders/boyz, 66investors/Mercy, tamutraders/boyz,
  madolar/jake, invest254/grace254_waithera. The predicate also drives finance/RTP exclusion + money
  routing, so it mis-bucketed money too.
- **Fix (0100):** a user is demo/marketer IFF a `marketers` row exists **on the user's own site**
  (significant-9 match) **OR** the profile is `role='marketer'` (safety: never un-demo an enrolled
  marketer — 0084 warns that would turn funny-money into withdrawable cash). Rolled-back validation:
  player-flagged 13→8 (the 5 cross-site players become real pool players; all had 0 balance / 0 trades),
  marketer-flagged 10→12 (ALL enrolled marketers stay demo; moha KES 3,152 and jake KES 3,005 demo
  balances preserved). Additive, idempotent, reversible, money-neutral.
- **Follow-up (data hygiene) — DONE:** `madolar/moha` and `safitraders/jake` were `role=marketer` with
  live demo balances but had **no `marketers` row on their own brand** — an artifact of 0076 backfilling
  every pre-existing marketer to the default site (invest254). Enrolled them properly on their own brand
  via `fn_marketer_create` (active row + `marketer_wallets`), leaving the invest254 rows untouched;
  audited as `marketer.enroll.backfill` in `admin_actions`. Their classification now resolves via the
  site-scoped same-site match (not just the `role='marketer'` safety clause). NOTE: no marketer-dashboard
  PIN was set for the new brand identities — set one via the marketer admin if they need to log in there.
## #6 — Pool RTP tracked pool-size, not house_edge (Bug 1) — FIXED (pool RTP redesign, docs/25 §14)
- **What:** the pool controller paced payouts against `pool_amount × elapsed_day_fraction`, so realized
  player RTP tracked how big the daily pool was relative to turnover — not the operator's `house_edge`.
- **Evidence:** `sessionWinProbability` pace term was `(amount·dayFraction − paid)/amount`. With a pool
  large relative to turnover, `paid` sits far behind pace every trade, pinning win-prob at `pCap`. With
  the pre-redesign defaults (`pCap 0.6`, `meanMultiplier 1.8`) that yields `E[RTP] = 0.6·1.8 = 108%`.
  Simulation of the real decision fn confirmed RTP saturating well above the intended `1 − house_edge`.
- **Impact:** RTP was effectively set by pool sizing, not the configured edge; on generously-sized pools
  the house could pay ~100%+ RTP.
- **Resolution:** pace realized RTP toward `targetRtp × cumulative_turnover` (player-only, per site-day);
  the pool `available()` becomes only the hard cash fuse. Net: `realized RTP = min(targetRtp,
  pool/turnover)`. Turnover is tracked in-memory + DB-seeded (no migration).

## #7 — No structural positive-edge guarantee; low-volume days ran underwater (Bug 2) — FIXED (docs/25 §14)
- **What:** nothing guaranteed cumulative payout stayed below turnover. A fixed probability cap bounds
  only the *expected* per-trade edge, not realized aggregate RTP.
- **Evidence:** driving the real engine over 400 simulated days at 8 trades/day (strict `pCap = base`,
  no ceiling) ended **above 100% RTP on 116/400 days** (house net loss), max day 177%; even high-volume
  days spiked intraday RTP to 124–135%.
- **Impact:** on thin/low-volume brand-days, the house could and did (in simulation) lose money.
- **Resolution:** a HARD RTP-budget ceiling in `decidePoolOutcome` — `paid + reserved ≤ ⌊targetRtp ×
  turnover⌋` at all times (subtracting reserved makes it concurrency-safe across in-flight positions).
  Guarantees realized RTP ≤ target at **every** volume; simulation: 0/400 days over target, `maxIntraday
  = target` exactly. The pool `available()` remains the absolute cash fuse.

## #8 — Pool and statistical engines disagreed on win frequency (Bug 3) — FIXED (docs/25 §14)
- **What:** the pool used hardcoded knobs (`targetSessionRtp 0.6`, `meanMultiplier 1.8`) disconnected from
  each brand's `site_game_config`, so pool win frequency (base `0.6/1.8 = 0.33`) did not match the
  statistical engine's `targetWinRate` (default `0.125`). A player's win cadence changed with pool mode.
- **Resolution:** derive the pool's `meanMultiplier = targetRtp / targetWinRate` (the same `rtp/winRate`
  the `SettlementEngine` calibrates to), so pool base win-prob = `targetWinRate`. Both engines now share
  `targetWinRate` and both deliver RTP = `1 − house_edge`. `game.ts` threads `cfg.targetWinRate` into the
  controller; an infeasible config falls back to the default multiplier (defence-in-depth).

## #9 — Marketer/demo funny-money polluted real analytics (raw-table queries) — FIXED (migration 0101)
- **What:** money-bearing rows (positions/ledger/transactions/wallets) for the marketer/demo cohort
  live in the same tables as real players. Reports that used the cohort exclusion were correct, but any
  query that omitted it mixed demo funny-money into real figures — e.g. a raw `sum(positions.stake)`
  read ~KES 9.75M of demo turnover as real, producing a wildly wrong demand/RTP interpretation.
- **Evidence:** `positions` held 8,391 rows but the dashboard (which excludes `marketer_account_ids`)
  counted 2,128 real bets; the excess 6,263 were marketer demo bets (incl. a KES 4.7M single-day burst).
- **Root cause:** no enforced "real data" surface — cohort exclusion was applied per-query, so it could
  be forgotten.
- **Resolution (0101):** canonical `v_real_*` / `v_demo_*` views over the live classifier
  (`marketer_account_ids`), correct-by-construction and drift-free; `fn_demo_isolation_report()` proves
  0 leakage; `fn_platform_overview` rewired onto the views (identical output). Data hygiene: the
  6,263 marketer demo positions + 12,087 demo ledger rows + 426 demo transactions were removed and the
  demo wallets reset (real player data provably untouched); a bug-inflated madolar test account was
  deleted; and seeded pool caps were zeroed. See docs/27.
