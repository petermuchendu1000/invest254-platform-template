# Bug Log

Running log of bugs caught (new or pre-existing) while working through issues, with status. Each
entry: what, evidence, root cause, impact, and resolution.

---

## #13 — Banned marketer stayed a brand's earning default; no admin-panel way to reassign — FIXED (migration 0104)
- **Report (operator):** *Mohane* (the only ACTIVE marketer on **madolar**) was still not the brand
  default; the "Make brand default" control couldn't be found where marketers are actually managed.
- **Evidence (read-only, production):** madolar had `sites.owner_user_id = moha`, but **moha and Mohan
  were both `banned`** and *Mohane* was the lone `active` marketer — yet a **banned** marketer remained
  the brand default and kept accruing 25% of every deposit. The only assignment UI lived in the
  **Platform Console** (`/platform`, platform_superadmin), not the **Admin panel** (`/admin/users`)
  operators use; and nothing prevented a default marketer from being banned or stopped a banned user
  from being (or staying) the default.
- **Root causes:** (1) surface mismatch — the control was platform-only; (2) `fn_platform_set_site_owner`
  validated role + site but **not status**, so a banned/suspended marketer could be set/left as default;
  (3) `fn_admin_set_user_status` had **no guard** against banning/suspending the current default.
- **Immediate data fix:** reassigned madolar's default from banned *moha* → active *Mohane*
  (`fn_platform_set_site_owner`, audited). Future deposits now credit Mohane 25%. (Historical
  commissions already paid to *moha* were left as-is.)
- **Resolution (branch `feat/admin-default-marketer-guards`, migration 0104 + API + web):**
  * **0104:** (a) `fn_platform_set_site_owner` now rejects a non-active marketer (`OWNER_NOT_ACTIVE`);
    (b) new **site-scoped** `fn_admin_set_site_owner(actor, role, marketer, make_default)` lets a brand
    `admin`/`superadmin` set/clear THEIR OWN brand's default (site derived from the marketer;
    `SITE_SCOPE_FORBIDDEN` off-brand; active-marketer enforced); (c) `fn_admin_set_user_status` blocks
    banning/suspending the current default (`DEFAULT_MARKETER_LOCKED`) — reassign first (per operator
    choice: **block**). Reactivating is always allowed.
  * **API:** `POST /admin/marketers/:id/make-default` and `/clear-default` (admin-gated, brand-scope
    enforced), routed via `PlatformRepository.setDefaultMarketer`. `AdminUserDetail` gains
    `isBrandDefaultMarketer`.
  * **Web:** `/admin/users/:id` shows a **"Make brand default" / "Remove as default"** control for
    marketers with a ★ current-default badge — where operators already manage users.
- **Verification:** rolled-back live e2e (13 scenarios: every guard + valid set/clear) against the real
  schema; 0104 applied to production and re-checked live (ban-of-default → `DEFAULT_MARKETER_LOCKED`).
  Typecheck clean (backend + web); full suite 673/673 (added an admin route-wiring/gating test).

## #12 — "Mohane's earnings not populating" — NOT A BUG (by design); default-marketer assignment made a first-class button + docs corrected
- **Report:** marketer *Mohane*'s dashboard showed no earnings; suspected a regression of #11.
- **Investigation (read-only, production):** *Mohane* (`0cb63be4…`, role `marketer`, brand **madolar**
  `776fd02b…`) has **0** `deposit_commissions`, **0** balance (`fn_commission_balance`), **0** direct
  referrals (`profiles.referred_by = Mohane` is empty), **0** clicks on her code `HYJJJQW2`. The
  dashboard (`GET /me/referral` → `sum(deposit_commissions.commission_amount)`) is therefore faithfully
  reporting zero.
- **Why zero is correct:** madolar's **default marketer** is *moha* (`sites.owner_user_id = a765af32…`).
  Verified the live model works: **78/78** successful M-Pesa deposits (KES 25,286.00) each generated a
  commission to *moha* at rate `0.25`, totalling KES 6,321.50 = **exactly 25%** — even though **all 118
  madolar players have `referred_by = NULL`**. So "default marketer earns 25% of every deposit,
  regardless of referral link" is already implemented and correct (`fn_pay_referral_commissions`,
  0103, invoked by `fn_complete_deposit`). *Mohane* is a **non-default** sub-marketer with no attributed
  deposits, so she correctly earns nothing.
- **Operator decision:** keep the differential-split model (every deposit still totals 25%, default
  marketer always at the root — **Model B**, no commission-math change), AND make assigning a brand's
  default marketer a first-class action.
- **Root cause of the confusion:** stale docs — `README.md` still described a legacy "20% of GGR / net
  losses" affiliate model, contradicting the live 25%-of-deposits model.
- **Resolution (branch `feat/set-default-marketer`, UI + docs only — no schema/money-path change):**
  * `apps/web/.../platform/ClientDetail.tsx`: added a **"Make brand default"** button (and
    **"Remove as default"**) in the per-user management panel, plus a **★ default** badge in the user
    table. Gated on `role = 'marketer'` client-side (backend `fn_platform_set_site_owner` already
    enforces marketer-on-same-brand + `platform_superadmin`, audited). This fixes a real gap: the
    pre-existing top-of-list selector only listed marketers from the first 50 loaded rows, so a marketer
    deeper in the list could not be selected; the search-then-select button reaches **any** marketer.
  * Docs: `README.md` (both 20% references corrected to the 25%-of-deposits hierarchical model), `docs/09`
    §3 (added "a brand always credits its default marketer" clarification + how to assign the default
    marketer), and this entry.
- **Verification:** rolled-back live e2e of `fn_platform_set_site_owner` — NOT_AUTHORIZED /
  SITE_NOT_FOUND / OWNER_NOT_FOUND / OWNER_NOT_MARKETER / OWNER_WRONG_SITE all fire; valid set
  (Mohane→madolar default) and clear-to-NULL both succeed; transaction rolled back (production
  untouched). Web typecheck clean; platform+referral+affiliate suites green (16/16).

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

## #10 — Marketer app login rejected valid phone formats (false NOT_MARKETER) — FIXED (issue: marketer app login)
- **What:** the generic marketer app (mpesa/truecaller builds) showed "This account isn't registered
  as a marketer" (403 NOT_MARKETER) and the transaction feed/notifications never loaded, for a
  marketer whose website password and ledger were valid — whenever she typed her phone in any format
  other than the exact stored string (e.g. `+254706597235`, `254706597235`, `706597235`,
  `0706 597 235` vs stored `0706597235`).
- **Evidence:** read-only production comparison on the affected number (sig9 `706597235`, default
  brand): the old exact-match query found the row only for the stored format (1/6 formats); the
  sig9-match query finds it for all 6. Both marketer apps send the phone exactly as typed
  (no client-side normalization).
- **Root cause:** `profileByPhone` in `apps/api/src/marketers.pg.ts` matched `phone = $1` on the raw,
  un-normalized request string, while `auth.login` normalizes via `normalizeMsisdn` — so the password
  check succeeded but the marketer-wallet lookup missed. It was the one marketer lookup never migrated
  to the canonical significant-9-digits rule (`fn_phone_sig9`, migrations 0084/0086/0100, docs/29).
  The route tests passed because the in-memory double in `testutil.ts` replicated the same exact-match
  flaw and the fixtures never varied the phone format.
- **Impact:** any marketer typing their number in a non-stored format was locked out of the app with a
  misleading "not a marketer" error; downstream, the app's poll worker no-ops without a session, so
  M-Pesa-style transaction notifications silently stopped.
- **Resolution:** `profileByPhone` now matches on
  `fn_phone_sig9(phone) = fn_phone_sig9($1)` (with the `length(...) = 9` guard, site-scoped,
  deterministic `ORDER BY created_at ASC LIMIT 1`) — the same predicate as every other marketer
  lookup. The in-memory double keys phones by sig9 to stay faithful. New regression test
  ("login-web accepts the phone in any valid format") covers 6 format variants end to end.
  Full suite green (672/672); typecheck clean. No schema or write-path changes.

## #11 — Non–site-owner marketers earned no commission; some brands had no default marketer — FIXED (migration 0103)
- **What:** marketer dashboards showed no commissions for many marketers (e.g. *joy*, *Mohane*).
- **Evidence (read-only, production):** of 807 profiles only 4 had `referred_by` set; commissions
  flowed **only** to site owners via the `sites.owner_user_id` fallback. 4 brands had **no** default
  marketer (`owner_user_id IS NULL`): invest254, muchwins, tamutraders, 66investors — so every
  deposit on those brands paid **0%**. Verified *moha* (madolar owner) already earned exactly 25%.
- **Root cause:** (1) 4 brands were never assigned a default marketer, so their deposits paid no
  commission; (2) `fn_pay_referral_commissions` (0081) only rooted at the default marketer for
  **unreferred** deposits — a sub-marketer referral could take the whole 25% and leave the default
  marketer with nothing, so the hierarchy wasn't guaranteed.
- **Model (confirmed with operator):** each brand has ONE **default marketer**; **every deposit pays
  25%** into the brand's **hierarchical** marketer tree, always rooted at the default marketer.
- **Resolution (0103):**
  * `fn_pay_referral_commissions` now **always roots the 25% differential chain at the brand's
    default marketer** — full 25% when unreferred; differential split (recruiter bulk + upline
    overrides, default marketer at root) when a sub-marketer referred the depositor. Totals always
    sum to exactly 25%. Self-pay blocked; idempotent via `(deposit_tx_id, beneficiary_user)`.
  * Default marketers assigned: **invest254 → joy**, **muchwins → sheila** (single-marketer brands
    auto-assigned generically). **tamutraders** — the lone marketer (a duplicate *joy*) was demoted
    to player per operator instruction; brand left with no default. **66investors** — no marketer
    exists; skipped.
  * Docs 09 §3 and 19 updated to the 25%-of-deposits hierarchical model.
- **Verification:** rolled-back e2e against the live schema — unreferred→owner 25%; sub-marketer
  referral→recruiter 20% + default 5%; owner self-deposit→no pay; sub-marketer self-deposit→default
  25%; idempotent re-run→0 new rows; all marketer totals == 25%. Referral + affiliate TS suites green.
