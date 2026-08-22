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
