# 09 — Affiliate / Marketer System

Marketers are players who also **promote a brand and earn 25% of deposits**. They can both play and earn.

> **Commission model (authoritative, migrations 0078/0081/0103):** every successful M-Pesa **deposit**
> on a brand pays a total of **25%** commission into that brand's **marketer hierarchy**, always
> rooted at the brand's **default marketer** (`sites.owner_user_id`). Marketers are **hierarchical**
> (unilevel): the recruiter who directly brought the depositor earns the largest share and each
> upline marketer earns a differential override, with the default marketer at the root. The shares
> always sum to exactly **25% of the deposit**. See §3.

## 1. Becoming a marketer ✅ (I1)
- Any player calls `POST /affiliate/enroll` → creates an `affiliates` row with a unique
  `referral_code` and sets `profiles.role = 'marketer'`. (The legacy `commission_rate` column is
  retained but the live model pays **25% of deposits** via the brand hierarchy, not a flat rate.)
- Each brand has a **default marketer** (`sites.owner_user_id`) who sits at the root of the brand's
  marketer hierarchy and earns 25% of every deposit not otherwise attributed to a sub-marketer.
- They get a shareable link: `https://invest254.../r/<referral_code>`.
- **Implemented (I1):** enrollment is **idempotent** — repeat calls return the existing stable
  code and never re-mint or downgrade a privileged role. The code uses a Crockford-style
  alphabet (no `0/O/1/I/L`). Logic lives in the `fn_affiliate_enroll` RPC (service-role only,
  migration 0017); the API returns `{ referralCode, commissionRate, status, role, referralPath }`.

## 2. Attribution ✅ (I1)
- A new user arriving via `/r/<code>` carries the code through signup (`POST /auth/register` with
  an optional `referral_code` — auth is self-managed phone+password, no OTP). On account creation:
  `profiles.referred_by = affiliate_id` and a `referrals` row is inserted (one referral per user,
  **first-touch, permanent**).
- **Implemented (I1):** attribution is written **atomically inside `fn_register_user`** (migration
  0017), so it can never be lost or double-applied (`referrals.referred_user` is `UNIQUE`). Codes
  are matched case-insensitively; an **unknown or suspended** code is silently ignored so a stale
  link never blocks a signup, while a **malformed** code is rejected up front (`INVALID_REFERRAL_CODE`).
  Self-referral is structurally impossible (phone is unique, so a brand-new account can never be
  the referring affiliate).

## 3. Commission model — 25% of deposits, hierarchical (migrations 0078/0081/0103) ✅
Marketers earn **25% of every deposit** on their brand, distributed up the brand's **marketer
hierarchy** and **always rooted at the brand's default marketer** (`sites.owner_user_id`). This is
the live model (`fn_pay_referral_commissions`), writing rows to `deposit_commissions` that the
marketer dashboard reads via `GET /me/referral`.

**Attribution per deposit (precedence):**
1. If the depositor was referred by a **sub-marketer** (`profiles.referred_by`), the 25% is split
   differentially up that recruiter's chain of consecutive same-brand marketers, **then** the
   brand's default marketer at the root receives the remaining override.
2. Otherwise (no referrer), the **default marketer earns the full 25%**.
Self-commission is blocked — a marketer's own deposit never pays themselves; it flows to the upline
(ultimately the default marketer).

**Differential tiers** (`fn_marketer_tier_rate`): position 1 = 25%, position 2 = 20%, position 3+ =
17%. Each marketer earns their tier minus the tier of the marketer directly above, so the shares
telescope to exactly **25%** regardless of depth:
- 1 level (default marketer only) → **25%**
- 2 levels (recruiter + default) → 20% + 5% = **25%**
- 3 levels → 17% + 3% + 5% = **25%**

Worked example: a player deposits KES 20,000 on madolar (default marketer *moha*):
- No referrer → *moha* earns `20,000 × 0.25 = KES 5,000`.
- Referred by sub-marketer *Mohane* → *Mohane* earns `20,000 × 0.20 = KES 4,000` and *moha*
  (root) earns `20,000 × 0.05 = KES 1,000` (total KES 5,000 = 25%).

> **A brand always credits its default marketer.** Even when **no** referral link is used, the
> default marketer earns the full 25% of every deposit — a non-default marketer (e.g. *Mohane*)
> therefore shows **KES 0** in their dashboard until a depositor is actually attributed to them
> (`profiles.referred_by`). This is by design, not a bug: a non-default sub-marketer earns only from
> deposits routed through their own referral chain.

**Assigning / changing a brand's default marketer.** The default marketer is `sites.owner_user_id`
and must be an **active marketer on that brand** (migration 0104). Two ways to set it:
- **Admin panel** (brand `admin`/`superadmin`): **Admin → Users → open a marketer → "Make brand
  default"** (or "Remove as default"). Site-scoped: an admin can only assign within their own brand
  (`fn_admin_set_site_owner`, `POST /admin/marketers/:id/make-default|clear-default`).
- **Platform Console** (`platform_superadmin`, cross-brand): **open the client → Users →** select a
  user **→ "Make brand default"** (or the *Brand marketer* selector) — `fn_platform_set_site_owner`,
  `PATCH /platform/sites/:id/owner`.

Both paths require the target to be an **active** marketer on that brand and are audited. A
banned/suspended user cannot be set as default (`OWNER_NOT_ACTIVE`), and the **current default marketer
cannot be banned/suspended until reassigned** (`DEFAULT_MARKETER_LOCKED`, migration 0104) — so a brand
is never left crediting a disabled account. Setting the default to *unassigned* means deposits on that
brand pay **no** marketer commission until a new default is assigned.

> **Legacy (deprecated):** an earlier design paid **20% of GGR** (net loss) accrued daily via
> `fn_accrue_affiliate_commissions` into `affiliate_commissions`. The live payout stream is the
> **25%-of-deposits** model above; the GGR tables remain only for historical reporting.

> Alternative models (CPA, deposit-%, hybrid) are supported by the schema but **revenue-share is the
> configured MVP default**. Rate is per-affiliate editable by admin.

> **Implemented (I2):** accrual is the `fn_accrue_affiliate_commissions(period)` RPC (migration 0018),
> run once per trading day by an operator/cron via `POST /admin/affiliate/accrue` (finance_admin) or
> directly as `service_role`. It is idempotent (settled positions never change) and never re-touches
> a bucket already `paid`/`reversed`. GGR is keyed to `game_days.trade_date` (the authoritative
> trading day) and zero-floored per player-day. Commission is `floor(GGR × commission_rate)`.

## 4. Marketer dashboard (`/affiliate/*`) ✅ (I3, reads)
- Summary cards: referral link, total referrals, active players (played in last 7/30d), total turnover,
  total GGR, commission accrued, commission paid, available to withdraw.
- Tables: referrals list (joined date, status, lifetime GGR), daily commission history.
- Charts: signups over time, GGR over time.
- **Payouts:** see §5 below.

**Expenses & advances (migrations 0068 + 0105).** An admin logs costs against a marketer
(TikTok/data/airtime/advance/other) from either the Admin panel (`/admin/users/:id`) or the
marketer-finance **Expenses** tab. Every entry is **keyed to the marketer's affiliate `profiles.id`**
so it appears on that marketer's dashboard. Expenses **reduce the withdrawable balance**:
`Available to withdraw = earned − held − paid − Σ expenses` (floored at 0, computed in
`fn_commission_balance`), so a marketer can only cash out commission net of every logged cost/advance —
and the payout RPC is auto-capped at that net. The marketer-finance selector resolves each marketer-app
account to its linked website marketer; app accounts with no website marketer can't be charged (nowhere
to show it).

## 5. Payouts — request → approve → M-Pesa B2C result ✅ (I4)
A marketer claims their earned commission; a finance admin authorizes it; the money goes out over
M-Pesa **B2C** and the asynchronous result settles the books. This mirrors the withdrawal
hold→approve→B2C-result→complete/reverse pattern (migration 0014), adapted to commission buckets.

**Reservation model (the key idea).** Rather than recomputing "available" from a moving target, a
payout **snapshots the exact accrued buckets it covers** by stamping their
`affiliate_commissions.payout_id` at request time. So:
- `available = Σ commission WHERE status='accrued' AND payout_id IS NULL`
- `accrued` (dashboard) still counts *all* accrued buckets (reserved or not); a reserved bucket
  simply drops out of `available` while its payout is in flight.

This sidesteps any "which buckets get paid" ambiguity (e.g. backfilled accruals arriving between
request and result): the covered set is fixed at request time, and its sum **is** the payout amount.

**Lifecycle (all RPCs `SECURITY DEFINER`, service-role only, idempotent under `FOR UPDATE`):**
1. `POST /affiliate/payouts` (marketer) → `fn_affiliate_request_payout`. Sums the caller's
   unreserved accrued buckets, refuses if one is already in flight (`PAYOUT_PENDING`) or there's
   nothing to pay (`NO_AVAILABLE_COMMISSION`), inserts the `requested` payout for that exact amount,
   and reserves the covered buckets. Returns `{ payoutId, amountCents }`.
2. `POST /admin/affiliate/payouts/:id/approve` (finance_admin) → `fn_affiliate_approve_payout`.
   `requested → approved`, returns the amount + the marketer's phone; the service then dispatches
   the M-Pesa B2C payment. Re-approving a non-`requested` payout is a no-op.
3. `POST /affiliate/payouts/mpesa/result/:payoutId` (public, allowlisted) → `fn_affiliate_complete_payout`.
   `ResultCode 0` ⇒ payout `paid`, reserved buckets move `accrued → paid` (their sum equals the
   payout amount by construction). Non-zero ⇒ payout `rejected` and the reservation is **released**
   (buckets stay `accrued`, available again). Terminal payouts no-op. The payout row captures
   `paid_at`, `conversation_id`, `mpesa_receipt`, `result_code/desc`, and the raw callback.
4. `POST /admin/affiliate/payouts/:id/reject` (finance_admin) → `fn_affiliate_reject_payout`.
   Declines a **pre-dispatch** `requested` payout and releases its reservation.

**Schema (migration 0019):** `affiliate_payouts` gains `paid_at, conversation_id, mpesa_receipt,
result_code, result_desc, raw_callback`; `affiliate_commissions` gains the
`payout_id → affiliate_payouts(id)` reservation link (+ supporting indexes).

**Invariant:** exactly `amount` worth of commission moves `accrued → paid` on success, matching what
the marketer receives; on any failure/rejection the same amount returns to `available`.

## 6. Anti-fraud
- Self-referral blocked (can't refer your own phone/device).
- Commission accrues only on **real-balance** turnover (bonus-funded play excluded) to stop
  bonus-abuse farming.
- Multi-account/collusion detection flags clusters (shared device, M-Pesa number) for review.
- Reversals: if a referred deposit is charged back/reversed, related commission is `reversed`.

## 7. Admin controls
- View/search marketers, edit `commission_rate`, suspend abusive affiliates.
- Review & approve/reject affiliate payout requests; full audit trail (payout `result_code/desc`,
  `conversation_id`, `mpesa_receipt`, `paid_at`, raw B2C callback).
