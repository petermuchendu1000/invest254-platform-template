# 19 — Affiliate Programme: Decisions & Dashboard Design

> **Status:** authoritative product+engineering decision record for the marketer/affiliate
> programme. Answers the four governing questions, with research, debate, and an implementable
> spec. Pairs with the redesigned `/affiliate` dashboard.

## Q1 — Who is a marketer (affiliate)?
A **marketer is a player who *also* promotes Invest254.** Becoming an affiliate is **additive** — it
never removes the player experience. A marketer can still deposit, trade, withdraw, and view history
exactly like any player (every player route is auth-only and `marketer` outranks `player`, so nothing
is gated away). On top of that, they get a unique referral link and earn **25% of the deposits** made
on their brand, distributed up a **hierarchical (unilevel) marketer tree** and always rooted at the
brand's **default marketer** (`sites.owner_user_id`). See doc 09 §3 for the differential tiers
(25% / 20% / 17% telescoping to a total of exactly 25% per deposit).

> **Note (model update, migrations 0078/0081/0103):** the programme now pays **25% of deposits**
> hierarchically, not 20% of GGR. Every deposit credits the brand's default marketer 25% unless a
> sub-marketer referred the depositor, in which case the 25% is split differentially up the chain to
> the default marketer at the root. The GGR text elsewhere in this doc is retained for history.

Two consequences that the product must respect:
1. **Two separate money pools.** A marketer has (a) a **playing wallet** — real/bonus balance funded
   by deposits, used to trade, withdrawn via `/withdrawals`; and (b) **affiliate commission** —
   accrued from *referred players'* NGR, paid out via M-Pesa B2C (`/affiliate/payouts`). These must
   never be conflated in the UI: commission is not spendable as a stake, and the playing balance is
   not commission.
2. **No self-dealing.** A marketer **cannot refer themselves** — attribution requires
   `affiliate ≠ new user` (`v_aff <> v_id`; in-memory `aff.userId !== u.userId`). Their *own* play
   therefore generates house revenue but **never self-commission**. This is the correct
   anti-fraud posture and must be preserved.

Because they advertise gambling in Invest254's name and are paid real money, they remain a **vetted,
contractually-bound marketing agent** (see Q4) — but as a *person* they are still a player.

## Q2 — What does a marketer actually want to see? (minimum + useful)
Industry standard (Track360 iGaming guidance) is the funnel hierarchy
**Clicks → Registrations → FTDs (first-time deposits) → NGR → Commission**, and an affiliate portal
should expose **only stance-relevant metrics**: clicks, registrations, FTDs, FTD-conversion,
commission earned/pending. **Raw per-player revenue and PII stay in the operator dashboard, never
the affiliate's.**

| Priority | Metric | Have? | Decision |
|---|---|---|---|
| P0 | Commission available / pending / lifetime paid | ✅ | **Hero.** This is why they're here. |
| P0 | Referral link + code (copy/share) | ✅ | Keep — the core tool. |
| P0 | Payout request | ✅ | Keep, beside the hero. |
| P1 | Registrations (referred signups) | ✅ | Keep, as funnel stage 1. |
| P1 | Active players | ✅ (7d/30d) | Keep, consolidated as funnel stage. |
| P1 | Commission/earnings trend over time | ✅ (from commission history) | **Add a chart.** |
| P1 | Net revenue (GGR/NGR) the commission is based on | ✅ | Keep as aggregate only. |
| P2 | **Clicks** on the referral link | ❌ not tracked | **Gap — see spec below.** Show "tracking coming", do **not** fake it. |
| P2 | **FTD count / FTD-conversion** | ❌ not tracked | **Gap — see spec below.** |
| — | **Turnover** (total stakes) | ✅ | **Remove from the affiliate view.** The affiliate is paid on NGR, not turnover; it's an operator metric and only adds noise. |
| — | **Per-referral username + lifetime revenue** | ✅ shown today | **Remove (privacy/compliance).** Replace with a **masked handle + coarse status** (New / Active). Player-level revenue belongs to the operator dashboard. |

**Net:** lead with earnings, make the funnel honest with the data we have, add a trend chart,
strip operator-only/PII data, and clearly mark clicks/FTD as roadmap items instead of inventing
numbers. Every tile must pay rent.

## Q3 — Is the dashboard professionally designed?
The previous version was a flat grid of equal stat cards — no hierarchy, no hero, no trend, no
funnel, and it leaked per-player revenue. The redesign follows reputable affiliate-portal patterns
(data-driven hero KPI + earnings chart + funnel + copy-link tool; e.g. Mosaic/affiliate-portal
references): a single **earnings hero** with the payout action, the **link tool**, an **honest
funnel** (Registrations → Active → Earning), an **earnings trend chart**, an aggregate revenue
summary, and a **privacy-safe** referred-players list. Mobile-first, dark-parity, no PII.

## Q4 — Auto-promote on apply, or admin approval? → **Admin approval.**
**Debate.**
- *For instant (current `fn_affiliate_enroll` auto-promotes player→marketer):* virality/low friction;
  naive self-referral is partly self-defeating (commission < the losses you'd have to generate).
- *For approval (chosen):* this is **regulated real-money gambling**. An un-vetted affiliate posting
  non-compliant gambling ads in our name is a **legal/brand liability** (BCLB). Approval enables
  enforceable T&Cs (you can only enforce on people you vetted), blocks fraud rings/bonus abuse, and
  matches iGaming norms (manual-augmented onboarding). We already have the seams: `affiliates.status`,
  admin commission-rate control, and the payout approval queue.

**Decision:** a player **applies**; an **admin/superadmin approves or rejects**. Role is promoted to
`marketer` and the referral code becomes active **only on approval**. Attribution already requires
`status='active'` (migration 0017), so a pending code earns nothing until approved — exactly right.

### Implementation spec (lands with the Admin Console, Phase A — see doc 18)
> **Why sequenced with the admin console, not now:** "pending" applications need a UI for an admin to
> action them. Shipping pending state with no approver UI would strand every applicant. The dashboard
> is being built now with all states (apply/pending/active/rejected) so the backend flips on with
> zero UI rework.

1. **Migration `0024_affiliate_application_review.sql`:**
   - `affiliates.status` CHECK → `('pending','active','suspended','rejected')`, default `'pending'`.
   - `fn_affiliate_enroll` → insert `status='pending'`, **do not** promote role.
   - `fn_affiliate_review(p_user, p_admin, p_approve bool)` → approve: `status='active'` + promote
     `player→marketer`; reject: `status='rejected'`; write an `admin_actions` audit row.
2. **Engine (`identity.ts` PG + in-memory repos, `affiliateservice.ts`):** `applyAffiliate` (pending,
   no role change), `reviewAffiliate(userId, adminId, approve)`, `listApplications(pending)`.
3. **API:** `POST /affiliate/enroll` returns `status:'pending'` (no token reissue while role is
   unchanged); admin: `GET /admin/affiliate/applications`, `POST /admin/affiliate/applications/:id/{approve,reject}` (audited).
4. **Admin console:** an Applications queue (approve/reject) — built in Phase A.
5. **Tests:** rewrite affiliate tests to apply→approve; add admin approve/reject coverage.

**Until then:** the dashboard ships redesigned; the apply CTA sets the expectation that applications
are reviewed; the backend remains instant-activate only until 0024 + the admin queue land together.
